import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { loadRuntimeConfig } from "../dist/runtime/config.js";
import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test", "Tournament create E2E may only run with BD_APP_ENV=test");
assert.equal(config.mode, "test-write", "Tournament create E2E requires guarded test-write mode");
assert.equal(config.prefixes.runtime, "bd_test_", "Tournament create E2E may only mutate bd_test_ runtime tables");
assert.equal(config.prefixes.identity, "bd_test_", "Tournament create E2E may only mutate bd_test_ identity tables");
assert.equal(config.mysql.budget.maxConcurrentConnections, 1, "Tournament create E2E must use one MySQL connection");

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
const bearer = `tournament-create-e2e-${randomBytes(24).toString("hex")}`;
const bearerHash = createHash("sha256").update(bearer).digest("hex");
const fixture = { club: null, season: null, tournament: null, user: null, session: null };
const baseUrl = `http://127.0.0.1:${config.port}`;
let server = null;
let serverOutput = "";

try {
  await createFixture();
  server = startServer();
  await waitForReady();

  const missingName = await requestJson(`/v1/clubs/${fixture.club}/tournaments`, {
    method: "POST",
    body: { name: "   " },
    expectedStatus: 422,
  });
  assert.equal(missingName.error.code, "tournament_name_required");

  const created = await requestJson(`/v1/clubs/${fixture.club}/tournaments`, {
    method: "POST",
    body: {
      name: `Øvelse Æresrunde ${suffix}`,
      max_visits_per_leg: 42,
      start_at: "2026-10-01 18:30:00",
      end_at: "2026-10-01 23:30:00",
    },
    expectedStatus: 201,
  });
  const tournament = created.tournament;
  fixture.tournament = String(tournament.id);
  assert.match(fixture.tournament, /^[1-9][0-9]*$/);
  assert.equal(String(tournament.club_id), fixture.club);
  assert.equal(String(tournament.season_id), fixture.season);
  assert.equal(tournament.club_name, `Tournament Create E2E ${suffix}`);
  assert.equal(tournament.name, `Øvelse Æresrunde ${suffix}`);
  assert.equal(tournament.slug, `ovelse-aeresrunde-${suffix}`);
  assert.equal(tournament.provider_system, "local");
  assert.equal(tournament.status, "draft");
  assert.equal(tournament.max_visits_per_leg, 42);
  assert.deepEqual(tournament.registrations, []);
  assert.deepEqual(tournament.matches, []);

  const stored = await provider.withConnection(async (db) => {
    const rows = await db.query(
      `SELECT club_id,season_id,name,slug,provider_system,status,max_visits_per_leg,start_at,end_at
         FROM \`${prefix}tournaments\` WHERE id=? LIMIT 1`,
      [fixture.tournament],
    );
    return rows[0];
  });
  assert.equal(String(stored.club_id), fixture.club);
  assert.equal(String(stored.season_id), fixture.season);
  assert.equal(stored.slug, `ovelse-aeresrunde-${suffix}`);
  assert.equal(stored.provider_system, "local");
  assert.equal(Number(stored.max_visits_per_leg), 42);

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-tournament-create",
    release_sha: config.releaseSha,
    runtime_prefix: prefix,
    tournament_id: fixture.tournament,
    inherited_active_season: true,
    exact_decimal_ids: true,
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
      [`Tournament Create E2E ${suffix}`, `tournament-create-e2e-${suffix}`],
    );
    fixture.club = requireInsertId(club, "club");

    const season = await db.execute(
      `INSERT INTO \`${prefix}seasons\` (club_id,name,slug,is_active) VALUES (?,?,?,1)`,
      [fixture.club, `Create Season ${suffix}`, `create-season-${suffix}`],
    );
    fixture.season = requireInsertId(season, "season");

    const username = `tournament-create-e2e-${suffix}`;
    const user = await db.execute(
      `INSERT INTO \`${prefix}user_accounts\`
        (username,email,password_hash,display_name,role,is_active,account_status)
       VALUES (?,?,NULL,?,'player',1,'active')`,
      [username, `${username}@example.invalid`, `Tournament Create Admin ${suffix}`],
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

async function cleanupFixture() {
  if (!fixture.club) return;
  try {
    await provider.withConnection(async (db) => {
      if (fixture.tournament) await db.execute(`DELETE FROM \`${prefix}tournaments\` WHERE id=?`, [fixture.tournament]);
      if (fixture.session) await db.execute(`DELETE FROM \`${prefix}auth_sessions\` WHERE id=?`, [fixture.session]);
      if (fixture.user) {
        await db.execute(`DELETE FROM \`${prefix}global_user_roles\` WHERE user_account_id=?`, [fixture.user]);
        await db.execute(`DELETE FROM \`${prefix}club_user_roles\` WHERE user_account_id=?`, [fixture.user]);
        await db.execute(`DELETE FROM \`${prefix}user_accounts\` WHERE id=?`, [fixture.user]);
      }
      if (fixture.season) await db.execute(`DELETE FROM \`${prefix}seasons\` WHERE id=?`, [fixture.season]);
      await db.execute(`DELETE FROM \`${prefix}clubs\` WHERE id=?`, [fixture.club]);
    });
  } catch (cleanupError) {
    console.error("backend-v2 tournament create E2E cleanup failed", cleanupError);
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
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
