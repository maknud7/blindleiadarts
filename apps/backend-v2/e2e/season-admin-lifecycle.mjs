import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { loadRuntimeConfig } from "../dist/runtime/config.js";
import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test", "Season admin E2E may only run with BD_APP_ENV=test");
assert.equal(config.mode, "test-write", "Season admin E2E requires guarded test-write mode");
assert.equal(config.prefixes.runtime, "bd_test_", "Season admin E2E may only mutate bd_test_ runtime tables");
assert.equal(config.prefixes.identity, "bd_test_", "Season admin E2E may only mutate disposable bd_test_ identity tables");
assert.equal(config.prefixes.hardware, "bd_prod_", "Season admin E2E must not mutate physical hardware tables");
assert.equal(config.mysql.budget.maxConcurrentConnections, 1, "Season admin E2E must use one backend connection");

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
const bearer = `season-admin-e2e-${randomBytes(24).toString("hex")}`;
const bearerHash = createHash("sha256").update(bearer).digest("hex");
const fixture = {
  club: null,
  seasons: [],
  players: [],
  tournament: null,
  match: null,
  user: null,
  session: null,
};
const baseUrl = `http://127.0.0.1:${config.port}`;
let server = null;
let serverOutput = "";

try {
  await createIdentityFixture();
  server = startServer();
  await waitForReady();

  const invalid = await requestJson(`/v1/clubs/${fixture.club}/seasons`, {
    method: "POST",
    body: { name: "Invalid", starts_on: "2026-09-02", ends_on: "2026-09-01" },
    expectedStatus: 422,
  });
  assert.equal(invalid.error.code, "season_validation_failed");

  const createdOne = await requestJson(`/v1/clubs/${fixture.club}/seasons`, {
    method: "POST",
    body: {
      name: `Høstserie ${suffix}`,
      starts_on: "2026-09-01",
      ends_on: "2026-12-31",
      ranking_method: "match_points",
      points_win: 2,
      points_draw: 1,
      points_loss: 0,
      activate: true,
    },
    expectedStatus: 201,
  });
  const seasonOne = String(createdOne.season.id);
  fixture.seasons.push(seasonOne);
  assert.match(seasonOne, /^[1-9][0-9]*$/);
  assert.equal(String(createdOne.season.club_id), fixture.club);
  assert.equal(createdOne.season.status, "active");
  assert.equal(createdOne.season.is_active, true);

  const createdTwo = await requestJson(`/v1/clubs/${fixture.club}/seasons`, {
    method: "POST",
    body: { name: `Neste serie ${suffix}`, activate: true },
    expectedStatus: 201,
  });
  const seasonTwo = String(createdTwo.season.id);
  fixture.seasons.push(seasonTwo);
  assert.equal(createdTwo.season.status, "active");

  const firstAfterSecond = await requestJson(`/v1/seasons/${seasonOne}`, { method: "GET" });
  assert.equal(firstAfterSecond.season.is_active, false);
  assert.equal(firstAfterSecond.season.status, "draft");

  const activated = await requestJson(`/v1/seasons/${seasonOne}/activate`, { method: "POST", body: {} });
  assert.equal(activated.season.status, "active");
  assert.equal(activated.season.is_active, true);
  const secondAfterActivation = await requestJson(`/v1/seasons/${seasonTwo}`, { method: "GET" });
  assert.equal(secondAfterActivation.season.is_active, false);
  assert.equal(secondAfterActivation.season.status, "draft");

  const updated = await requestJson(`/v1/seasons/${seasonOne}`, {
    method: "PATCH",
    body: { name: `Høstserie oppdatert ${suffix}`, points_win: 3, points_draw: 1, points_loss: 0 },
  });
  assert.equal(updated.season.name, `Høstserie oppdatert ${suffix}`);
  assert.equal(Number(updated.season.points_win), 3);

  const noResults = await requestJson(`/v1/seasons/${seasonOne}/complete`, {
    method: "POST",
    body: {},
    expectedStatus: 409,
  });
  assert.equal(noResults.error.code, "season_has_no_results");

  await createResultFixture(seasonOne);

  const completed = await requestJson(`/v1/seasons/${seasonOne}/complete`, { method: "POST", body: {} });
  assert.equal(completed.season.status, "completed");
  assert.equal(completed.season.is_active, false);
  assert.equal(String(completed.season.champion_player_id), fixture.players[0]);

  const completedAgain = await requestJson(`/v1/seasons/${seasonOne}/complete`, { method: "POST", body: {} });
  assert.equal(completedAgain.season.status, "completed");
  assert.equal(String(completedAgain.season.champion_player_id), fixture.players[0]);

  const lockedUpdate = await requestJson(`/v1/seasons/${seasonOne}`, {
    method: "PATCH",
    body: { name: "Skal ikke lagres" },
    expectedStatus: 409,
  });
  assert.equal(lockedUpdate.error.code, "season_completed");

  const lockedActivate = await requestJson(`/v1/seasons/${seasonOne}/activate`, {
    method: "POST",
    body: {},
    expectedStatus: 409,
  });
  assert.equal(lockedActivate.error.code, "season_completed");

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-season-admin",
    release_sha: config.releaseSha,
    runtime_prefix: prefix,
    first_season_id: seasonOne,
    second_season_id: seasonTwo,
    champion_player_id: fixture.players[0],
    create_verified: true,
    update_verified: true,
    activation_exclusivity_verified: true,
    no_results_lock_verified: true,
    completion_verified: true,
    completion_idempotent_verified: true,
    completed_lock_verified: true,
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

async function createIdentityFixture() {
  await provider.withConnection(async (db) => {
    const club = await db.execute(
      `INSERT INTO \`${prefix}clubs\` (name,slug) VALUES (?,?)`,
      [`Season Admin E2E ${suffix}`, `season-admin-e2e-${suffix}`],
    );
    fixture.club = requireInsertId(club, "club");

    const username = `season-admin-e2e-${suffix}`;
    const user = await db.execute(
      `INSERT INTO \`${prefix}user_accounts\`
        (username,email,password_hash,display_name,role,is_active,account_status)
       VALUES (?,?,NULL,?,'player',1,'active')`,
      [username, `${username}@example.invalid`, `Season Admin ${suffix}`],
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

async function createResultFixture(seasonId) {
  await provider.withConnection(async (db) => {
    for (let index = 0; index < 2; index += 1) {
      const player = await db.execute(
        `INSERT INTO \`${prefix}players\` (club_id,display_name,is_active) VALUES (?,?,1)`,
        [fixture.club, `Season E2E Player ${index + 1} ${suffix}`],
      );
      fixture.players.push(requireInsertId(player, `player-${index + 1}`));
    }

    const tournament = await db.execute(
      `INSERT INTO \`${prefix}tournaments\` (club_id,season_id,name,slug,status)
       VALUES (?,?,?,?, 'completed')`,
      [fixture.club, seasonId, `Season Result ${suffix}`, `season-result-${suffix}`],
    );
    fixture.tournament = requireInsertId(tournament, "tournament");

    for (const playerId of fixture.players) {
      await db.execute(
        `INSERT INTO \`${prefix}tournament_players\` (tournament_id,player_id,status) VALUES (?,?,'registered')`,
        [fixture.tournament, playerId],
      );
    }

    const match = await db.execute(
      `INSERT INTO \`${prefix}matches\`
        (tournament_id,status,best_of_legs,legs_to_win,player_a_id,player_b_id,winner_player_id,starts_at,finished_at)
       VALUES (?,'completed',3,2,?,?,?,NOW(),NOW())`,
      [fixture.tournament, fixture.players[0], fixture.players[1], fixture.players[0]],
    );
    fixture.match = requireInsertId(match, "match");
  });
}

async function cleanupFixture() {
  if (!fixture.club) return;
  try {
    await provider.withConnection(async (db) => {
      if (fixture.match) await db.execute(`DELETE FROM \`${prefix}matches\` WHERE id=?`, [fixture.match]);
      if (fixture.tournament) {
        await db.execute(`DELETE FROM \`${prefix}tournament_players\` WHERE tournament_id=?`, [fixture.tournament]);
        await db.execute(`DELETE FROM \`${prefix}tournaments\` WHERE id=?`, [fixture.tournament]);
      }
      for (const seasonId of fixture.seasons) {
        await db.execute(`DELETE FROM \`${prefix}seasons\` WHERE id=?`, [seasonId]);
      }
      for (const playerId of fixture.players) {
        await db.execute(`DELETE FROM \`${prefix}players\` WHERE id=?`, [playerId]);
      }
      if (fixture.session) await db.execute(`DELETE FROM \`${prefix}auth_sessions\` WHERE id=?`, [fixture.session]);
      if (fixture.user) {
        await db.execute(`DELETE FROM \`${prefix}global_user_roles\` WHERE user_account_id=?`, [fixture.user]);
        await db.execute(`DELETE FROM \`${prefix}club_user_roles\` WHERE user_account_id=?`, [fixture.user]);
        await db.execute(`DELETE FROM \`${prefix}user_accounts\` WHERE id=?`, [fixture.user]);
      }
      await db.execute(`DELETE FROM \`${prefix}clubs\` WHERE id=?`, [fixture.club]);
    });
  } catch (cleanupError) {
    console.error("backend-v2 season admin E2E cleanup failed", cleanupError);
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
        if (
          health.ok === true &&
          health.environment === "test" &&
          health.writes_armed === true &&
          health.runtime_prefix === "bd_test_" &&
          health.identity_prefix === "bd_test_" &&
          health.max_connections === 1 &&
          health.connection_mode === "idle-reuse"
        ) return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`backend-v2 did not become ready: ${String(lastError ?? "unknown")}`);
}

async function requestJson(path, { method = "GET", body = undefined, expectedStatus = 200 } = {}) {
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
