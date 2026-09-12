import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { loadRuntimeConfig } from "../dist/runtime/config.js";
import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test", "Player-break E2E may only run with BD_APP_ENV=test");
assert.equal(config.mode, "test-write", "Player-break E2E requires guarded test-write mode");
assert.equal(config.prefixes.runtime, "bd_test_", "Player-break E2E may only mutate bd_test_ runtime tables");
assert.equal(config.prefixes.identity, "bd_test_", "Player-break E2E may only mutate bd_test_ identity tables");
assert.equal(config.mysql.budget.maxConcurrentConnections, 1, "Player-break E2E must use one MySQL connection");

const provider = new MySql2SessionProvider({
  host: config.mysql.host,
  port: config.mysql.port,
  database: config.mysql.database,
  username: config.mysql.username,
  password: config.mysql.password,
  connectTimeoutMs: config.mysql.connectTimeoutMs,
  budget: config.mysql.budget,
  writable: true,
  connectionReuse: "idle-reuse",
  idleConnectionTimeoutMs: config.mysql.idleConnectionTimeoutMs,
});

const prefix = config.prefixes.runtime;
const suffix = randomBytes(6).toString("hex");
const bearer = `player-break-e2e-${randomBytes(24).toString("hex")}`;
const bearerHash = createHash("sha256").update(bearer).digest("hex");
const fixture = { club: null, tournament: null, player: null, user: null, session: null };
const baseUrl = `http://127.0.0.1:${config.port}`;
let server = null;
let serverOutput = "";

try {
  await createFixture();
  server = startServer();
  await waitForReady();

  const initial = await requestJson(`/v1/tournaments/${fixture.tournament}/me/break`, { method: "GET" });
  assert.equal(initial.break, null);
  assert.equal(initial.break_minutes, 7);

  const created = await requestJson(`/v1/tournaments/${fixture.tournament}/me/break`, {
    method: "POST",
    expectedStatus: 201,
  });
  assert.equal(created.break.status, "active");
  assert.equal(created.break.break_minutes, 7);
  assert.ok(created.break.ends_at);

  const paused = await registrationStatus();
  assert.equal(paused, "paused");

  const context = await requestJson("/v1/me/break-context", { method: "GET" });
  assert.equal(String(context.context.tournament_id), fixture.tournament);
  assert.equal(context.context.break.status, "active");
  assert.equal(context.break_minutes, 7);

  await provider.withConnection((db) => db.execute(
    `UPDATE \`${prefix}tournament_player_breaks\` SET ends_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE tournament_id=? AND player_id=?`,
    [fixture.tournament, fixture.player],
  ));

  const operations = await requestJson(`/v1/tournaments/${fixture.tournament}/operations`, { method: "GET" });
  assert.equal(operations.ok, true);

  const completed = await requestJson(`/v1/tournaments/${fixture.tournament}/me/break`, { method: "GET" });
  assert.equal(completed.break.status, "completed");
  assert.equal(await registrationStatus(), "checked_in");

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-tournament-player-break-lifecycle",
    release_sha: config.releaseSha,
    runtime_prefix: prefix,
    immediate_break: true,
    operations_normalizes_expiry: true,
    registration_restored: true,
  }));
} catch (error) {
  if (serverOutput) process.stderr.write(`\n--- backend-v2 server output ---\n${serverOutput}\n`);
  throw error;
} finally {
  if (server) {
    server.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  await cleanupFixture();
  await provider.close();
}

async function createFixture() {
  await provider.withConnection(async (db) => {
    const club = await db.execute(
      `INSERT INTO \`${prefix}clubs\` (name,slug) VALUES (?,?)`,
      [`Player Break E2E ${suffix}`, `player-break-e2e-${suffix}`],
    );
    fixture.club = requireInsertId(club, "club");

    const player = await db.execute(
      `INSERT INTO \`${prefix}players\` (club_id,display_name) VALUES (?,?)`,
      [fixture.club, `Player Break E2E ${suffix}`],
    );
    fixture.player = requireInsertId(player, "player");
    await db.execute(`UPDATE \`${prefix}players\` SET member_id=? WHERE id=?`, [fixture.player, fixture.player]);

    const tournament = await db.execute(
      `INSERT INTO \`${prefix}tournaments\`
        (club_id,name,slug,provider_system,status,start_at,registration_opens_at,registration_closes_at,max_players)
       VALUES (?,?,?,'local','in_progress',DATE_SUB(NOW(),INTERVAL 5 MINUTE),DATE_SUB(NOW(),INTERVAL 1 DAY),DATE_ADD(NOW(),INTERVAL 1 DAY),16)`,
      [fixture.club, `Player Break E2E ${suffix}`, `player-break-e2e-${suffix}`],
    );
    fixture.tournament = requireInsertId(tournament, "tournament");
    await db.execute(
      `INSERT INTO \`${prefix}tournament_players\`
        (tournament_id,player_id,status,registration_source,checked_in_at,checkin_source)
       VALUES (?,?,'checked_in','admin',NOW(3),'admin_override')`,
      [fixture.tournament, fixture.player],
    );

    const username = `player-break-e2e-${suffix}`;
    const user = await db.execute(
      `INSERT INTO \`${prefix}user_accounts\`
        (username,email,password_hash,display_name,player_id,member_id,role,is_active,account_status)
       VALUES (?,?,NULL,?,?,?,'player',1,'active')`,
      [username, `${username}@example.invalid`, `Player Break E2E ${suffix}`, fixture.player, fixture.player],
    );
    fixture.user = requireInsertId(user, "user");
    await db.execute(`INSERT INTO \`${prefix}global_user_roles\` (user_account_id,role) VALUES (?,'super_admin')`, [fixture.user]);
    const session = await db.execute(
      `INSERT INTO \`${prefix}auth_sessions\` (user_account_id,session_token_hash,expires_at,last_used_at)
       VALUES (?,?,DATE_ADD(NOW(),INTERVAL 1 DAY),NOW())`,
      [fixture.user, bearerHash],
    );
    fixture.session = requireInsertId(session, "session");
  });
}

async function registrationStatus() {
  return provider.withConnection(async (db) => {
    const rows = await db.query(
      `SELECT status FROM \`${prefix}tournament_players\` WHERE tournament_id=? AND player_id=? LIMIT 1`,
      [fixture.tournament, fixture.player],
    );
    return rows[0]?.status ?? null;
  });
}

async function cleanupFixture() {
  if (!fixture.club) return;
  try {
    await provider.withConnection(async (db) => {
      if (fixture.tournament) {
        await db.execute(`DELETE FROM \`${prefix}tournament_player_breaks\` WHERE tournament_id=?`, [fixture.tournament]);
        await db.execute(`DELETE FROM \`${prefix}tournament_elo_snapshots\` WHERE tournament_id=?`, [fixture.tournament]);
        await db.execute(`DELETE FROM \`${prefix}tournament_players\` WHERE tournament_id=?`, [fixture.tournament]);
        await db.execute(`DELETE FROM \`${prefix}tournaments\` WHERE id=?`, [fixture.tournament]);
      }
      if (fixture.session) await db.execute(`DELETE FROM \`${prefix}auth_sessions\` WHERE id=?`, [fixture.session]);
      if (fixture.user) {
        await db.execute(`DELETE FROM \`${prefix}global_user_roles\` WHERE user_account_id=?`, [fixture.user]);
        await db.execute(`DELETE FROM \`${prefix}club_user_roles\` WHERE user_account_id=?`, [fixture.user]);
        await db.execute(`DELETE FROM \`${prefix}user_accounts\` WHERE id=?`, [fixture.user]);
      }
      if (fixture.player) await db.execute(`DELETE FROM \`${prefix}players\` WHERE id=?`, [fixture.player]);
      await db.execute(`DELETE FROM \`${prefix}clubs\` WHERE id=?`, [fixture.club]);
    });
  } catch (cleanupError) {
    console.error("backend-v2 player-break E2E cleanup failed", cleanupError);
  }
}

function startServer() {
  const child = spawn(process.execPath, ["apps/backend-v2/dist/server.js"], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(config.port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  child.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
  return child;
}

async function waitForReady() {
  let lastError = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (server?.exitCode !== null) throw new Error(`backend-v2 exited before readiness. ${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        const health = await response.json();
        if (health.ok === true && health.environment === "test" && health.writes_armed === true) return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`backend-v2 did not become ready: ${String(lastError ?? "unknown")}`);
}

async function requestJson(path, { method, body = undefined, expectedStatus = 200 }) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} returned non-JSON ${response.status}: ${text}`);
  }
  assert.equal(response.status, expectedStatus, `${method} ${path}: ${text}`);
  return payload;
}

function requireInsertId(result, label) {
  const value = String(result.insertId ?? "").trim();
  assert.match(value, /^[1-9][0-9]*$/, `${label} insert id missing`);
  return value;
}
