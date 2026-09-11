import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { loadRuntimeConfig } from "../dist/runtime/config.js";
import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test", "Tournament E2E may only run with BD_APP_ENV=test");
assert.equal(config.mode, "test-write", "Tournament E2E requires guarded test-write mode");
assert.equal(config.prefixes.runtime, "bd_test_", "Tournament E2E may only mutate bd_test_ runtime tables");
assert.equal(config.prefixes.identity, "bd_test_", "Tournament E2E may only mutate bd_test_ identity tables");
assert.equal(config.mysql.budget.maxConcurrentConnections, 1, "Tournament E2E must use one MySQL connection");

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
const bearer = `tournament-e2e-${randomBytes(24).toString("hex")}`;
const bearerHash = createHash("sha256").update(bearer).digest("hex");
const fixture = {
  club: null,
  tournament: null,
  players: [],
  user: null,
  session: null,
};
const baseUrl = `http://127.0.0.1:${config.port}`;
let server = null;
let serverOutput = "";

try {
  await createFixture();
  server = startServer();
  await waitForReady();

  const tournaments = await getJson(`/v1/clubs/${fixture.club}/registration-tournaments`);
  const listed = tournaments.items.find((item) => String(item.id) === fixture.tournament);
  assert.ok(listed, "Disposable TEST tournament was not returned by Node registration list");
  assert.equal(listed.registration_state, "open");
  assert.equal(Number(listed.max_players), 8);

  for (const playerId of fixture.players.slice(0, 8)) {
    const response = await postJson(`/v1/tournaments/${fixture.tournament}/registrations`, {
      player_id: playerId,
    });
    assert.equal(response.registration.status, "registered");
  }

  const waitlisted = await postJson(`/v1/tournaments/${fixture.tournament}/registrations`, {
    player_id: fixture.players[8],
  });
  assert.equal(waitlisted.registration.status, "waitlisted");

  const withdrawn = await deleteJson(
    `/v1/tournaments/${fixture.tournament}/registrations/${fixture.players[0]}`,
  );
  assert.equal(withdrawn.registration.status, "withdrawn");
  assert.equal(String(withdrawn.registration.promoted_player_id), fixture.players[8]);

  const hugeSeed = "9223372036854775807";
  const draw = await postJson(`/v1/tournaments/${fixture.tournament}/groups/draw`, {
    group_count: 2,
    mode: "elo_snake",
    draw_seed: hugeSeed,
  });
  assert.equal(draw.groups.length, 2);
  assert.deepEqual(draw.groups.map((group) => group.players.length), [4, 4]);
  assert.ok(draw.groups.every((group) => String(group.draw_seed) === hugeSeed));

  const groups = await getJson(`/v1/tournaments/${fixture.tournament}/groups`);
  assert.equal(groups.groups.length, 2);
  assert.deepEqual(groups.groups.map((group) => group.players.length), [4, 4]);

  const generated = await postJson(`/v1/tournaments/${fixture.tournament}/groups/round-robin`, {
    best_of_legs: 3,
  });
  assert.equal(generated.created_match_count, 12);
  assert.equal(generated.best_of_legs, 3);

  const matchCount = await scalar(
    `SELECT COUNT(*) AS value FROM \`${prefix}matches\` WHERE tournament_id=?`,
    [fixture.tournament],
  );
  assert.equal(Number(matchCount), 12);
  const pendingCount = await scalar(
    `SELECT COUNT(*) AS value FROM \`${prefix}matches\` WHERE tournament_id=? AND status='pending'`,
    [fixture.tournament],
  );
  assert.equal(Number(pendingCount), 12);

  const locked = await requestJson(`/v1/tournaments/${fixture.tournament}/registrations`, {
    method: "POST",
    body: { player_id: fixture.players[0] },
    expectedStatus: 422,
  });
  assert.equal(locked.error.code, "registration_locked_by_matches");

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-tournament-lifecycle",
    release_sha: config.releaseSha,
    runtime_prefix: prefix,
    tournament_id: fixture.tournament,
    generated_matches: 12,
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
  await provider.withConnection(async (sql) => {
    const club = await sql.execute(
      `INSERT INTO \`${prefix}clubs\` (name, slug) VALUES (?, ?)`,
      [`Tournament E2E ${suffix}`, `tournament-e2e-${suffix}`],
    );
    fixture.club = requireInsertId(club, "club");

    for (let index = 0; index < 9; index += 1) {
      const inserted = await sql.execute(
        `INSERT INTO \`${prefix}players\` (club_id, display_name) VALUES (?, ?)`,
        [fixture.club, `Tournament E2E Player ${index + 1} ${suffix}`],
      );
      fixture.players.push(requireInsertId(inserted, `player ${index + 1}`));
    }

    const tournament = await sql.execute(
      `INSERT INTO \`${prefix}tournaments\`
        (club_id, name, slug, provider_system, status, start_at, registration_opens_at, registration_closes_at, max_players)
       VALUES (?, ?, ?, 'local', 'ready', DATE_ADD(NOW(), INTERVAL 1 DAY), DATE_SUB(NOW(), INTERVAL 1 DAY), DATE_ADD(NOW(), INTERVAL 2 DAY), 8)`,
      [fixture.club, `Tournament E2E ${suffix}`, `tournament-e2e-${suffix}`],
    );
    fixture.tournament = requireInsertId(tournament, "tournament");

    const username = `e2e-${suffix}`;
    const email = `${username}@example.invalid`;
    const user = await sql.execute(
      `INSERT INTO \`${prefix}user_accounts\`
        (username, email, password_hash, display_name, player_id, role, is_active, account_status)
       VALUES (?, ?, NULL, ?, ?, 'player', 1, 'active')`,
      [username, email, `Tournament E2E Admin ${suffix}`, fixture.players[1]],
    );
    fixture.user = requireInsertId(user, "user");

    await sql.execute(
      `INSERT INTO \`${prefix}global_user_roles\` (user_account_id, role) VALUES (?, 'super_admin')`,
      [fixture.user],
    );
    const session = await sql.execute(
      `INSERT INTO \`${prefix}auth_sessions\`
        (user_account_id, session_token_hash, expires_at, last_used_at)
       VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY), NOW())`,
      [fixture.user, bearerHash],
    );
    fixture.session = requireInsertId(session, "session");
  });
}

async function cleanupFixture() {
  if (!fixture.club) return;
  try {
    await provider.withConnection(async (sql) => {
      if (fixture.tournament) {
        await sql.execute(`DELETE FROM \`${prefix}matches\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(
          `DELETE gp FROM \`${prefix}tournament_group_players\` gp
            INNER JOIN \`${prefix}tournament_groups\` g ON g.id=gp.group_id
           WHERE g.tournament_id=?`,
          [fixture.tournament],
        );
        await sql.execute(`DELETE FROM \`${prefix}tournament_groups\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}tournament_players\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}tournament_summaries\` WHERE tournament_id=?`, [fixture.tournament]);
      }
      if (fixture.session) await sql.execute(`DELETE FROM \`${prefix}auth_sessions\` WHERE id=?`, [fixture.session]);
      if (fixture.user) {
        await sql.execute(`DELETE FROM \`${prefix}global_user_roles\` WHERE user_account_id=?`, [fixture.user]);
        await sql.execute(`DELETE FROM \`${prefix}club_user_roles\` WHERE user_account_id=?`, [fixture.user]);
        await sql.execute(`DELETE FROM \`${prefix}user_accounts\` WHERE id=?`, [fixture.user]);
      }
      if (fixture.tournament) await sql.execute(`DELETE FROM \`${prefix}tournaments\` WHERE id=?`, [fixture.tournament]);
      for (const playerId of fixture.players) {
        await sql.execute(`DELETE FROM \`${prefix}players\` WHERE id=?`, [playerId]);
      }
      await sql.execute(`DELETE FROM \`${prefix}clubs\` WHERE id=?`, [fixture.club]);
    });
  } catch (cleanupError) {
    console.error("backend-v2 tournament E2E cleanup failed", cleanupError);
  }
}

function startServer() {
  const child = spawn(process.execPath, ["apps/backend-v2/dist/server.js"], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(config.port),
    },
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

async function getJson(path) {
  return requestJson(path, { method: "GET" });
}

async function postJson(path, body) {
  return requestJson(path, { method: "POST", body });
}

async function deleteJson(path) {
  return requestJson(path, { method: "DELETE" });
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

async function scalar(sql, params) {
  return provider.withConnection(async (db) => {
    const rows = await db.query(sql, params);
    return rows[0]?.value ?? null;
  });
}

function requireInsertId(result, label) {
  const value = String(result.insertId ?? "").trim();
  assert.match(value, /^[1-9][0-9]*$/, `${label} insert id missing`);
  return value;
}
