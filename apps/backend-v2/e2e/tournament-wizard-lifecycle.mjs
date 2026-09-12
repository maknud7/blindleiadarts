import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { loadRuntimeConfig } from "../dist/runtime/config.js";
import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test", "Tournament wizard E2E may only run with BD_APP_ENV=test");
assert.equal(config.mode, "test-write", "Tournament wizard E2E requires guarded test-write mode");
assert.equal(config.prefixes.runtime, "bd_test_", "Tournament wizard E2E may only mutate bd_test_ runtime tables");
assert.equal(config.prefixes.identity, "bd_test_", "Tournament wizard E2E may only mutate bd_test_ identity tables");
assert.equal(config.mysql.budget.maxConcurrentConnections, 1, "Tournament wizard E2E must use one MySQL connection");

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
const bearer = `wizard-e2e-${randomBytes(24).toString("hex")}`;
const bearerHash = createHash("sha256").update(bearer).digest("hex");
const fixture = { club: null, tournament: null, players: [], user: null, session: null, match: null };
const baseUrl = `http://127.0.0.1:${config.port}`;
let server = null;
let serverOutput = "";

try {
  await createFixture();
  server = startServer();
  await waitForReady();

  const publicPlan = await requestJson(`/v1/tournaments/${fixture.tournament}/wizard-plan`, {
    method: "GET",
    authenticated: false,
  });
  assert.equal(String(publicPlan.plan.tournament_id), fixture.tournament);
  assert.equal(String(publicPlan.plan.club_id), fixture.club);
  assert.equal(publicPlan.plan.tournament_format, "groups_playoff");
  assert.equal(Number(publicPlan.plan.starting_score), 501);
  assert.equal(Number(publicPlan.plan.group_count), 1);
  assert.equal(publicPlan.plan.group_draw_mode, "elo_snake");
  assert.equal(publicPlan.plan.groups_already_drawn, false);

  const unauthenticatedMutation = await requestJson(`/v1/tournaments/${fixture.tournament}/wizard-plan`, {
    method: "PATCH",
    body: { starting_score: 301 },
    authenticated: false,
    expectedStatus: 401,
  });
  assert.equal(unauthenticatedMutation.error.code, "authentication_required");

  const updated = await requestJson(`/v1/tournaments/${fixture.tournament}/wizard-plan`, {
    method: "PATCH",
    body: {
      tournament_format: "groups_playoff",
      starting_score: 301,
      group_count: 1,
      group_draw_mode: "random",
      group_best_of_legs: 5,
      qualifiers_per_group: 2,
      playoff_best_of_legs: 7,
      auto_create_playoff: false,
    },
  });
  assert.equal(updated.plan.tournament_format, "groups_playoff");
  assert.equal(Number(updated.plan.starting_score), 301);
  assert.equal(Number(updated.plan.group_count), 1);
  assert.equal(updated.plan.group_draw_mode, "random");
  assert.equal(Number(updated.plan.group_best_of_legs), 5);
  assert.equal(Number(updated.plan.qualifiers_per_group), 2);
  assert.equal(Number(updated.plan.playoff_best_of_legs), 7);
  assert.equal(updated.plan.auto_create_playoff, false);

  const invalidScore = await requestJson(`/v1/tournaments/${fixture.tournament}/wizard-plan`, {
    method: "PATCH",
    body: { starting_score: 401 },
    expectedStatus: 422,
  });
  assert.equal(invalidScore.error.code, "invalid_starting_score");

  const invalidBestOf = await requestJson(`/v1/tournaments/${fixture.tournament}/wizard-plan`, {
    method: "PATCH",
    body: { group_best_of_legs: 4 },
    expectedStatus: 422,
  });
  assert.equal(invalidBestOf.error.code, "invalid_best_of_legs");

  const groupsTooSmall = await requestJson(`/v1/tournaments/${fixture.tournament}/wizard-plan`, {
    method: "PATCH",
    body: { group_count: 2 },
    expectedStatus: 422,
  });
  assert.equal(groupsTooSmall.error.code, "groups_too_small");

  await provider.withConnection(async (sql) => {
    const inserted = await sql.execute(
      `INSERT INTO \`${prefix}matches\`
        (tournament_id,round_label,round_number,status,best_of_legs,legs_to_win,player_a_id,player_b_id)
       VALUES (?,'Wizard delete guard',1,'pending',3,2,?,?)`,
      [fixture.tournament, fixture.players[0], fixture.players[1]],
    );
    fixture.match = requireInsertId(inserted, "match");
  });

  const guardedDelete = await requestJson(`/v1/tournaments/${fixture.tournament}/wizard-plan`, {
    method: "DELETE",
    expectedStatus: 409,
  });
  assert.equal(guardedDelete.error.code, "tournament_delete_has_matches");

  await provider.withConnection(async (sql) => {
    await sql.execute(`DELETE FROM \`${prefix}matches\` WHERE id=?`, [fixture.match]);
    fixture.match = null;
  });

  const deleted = await requestJson(`/v1/tournaments/${fixture.tournament}/wizard-plan`, { method: "DELETE" });
  assert.equal(deleted.deleted, true);
  assert.equal(String(deleted.tournament_id), fixture.tournament);

  const afterDelete = await requestJson(`/v1/tournaments/${fixture.tournament}/wizard-plan`, {
    method: "GET",
    authenticated: false,
    expectedStatus: 404,
  });
  assert.equal(afterDelete.error.code, "tournament_not_found");

  const cleanupProof = await provider.withConnection(async (sql) => {
    const tournamentRows = await sql.query(`SELECT COUNT(*) AS c FROM \`${prefix}tournaments\` WHERE id=?`, [fixture.tournament]);
    const registrationRows = await sql.query(
      `SELECT COUNT(*) AS c FROM \`${prefix}tournament_players\` WHERE tournament_id=?`,
      [fixture.tournament],
    );
    return {
      tournaments: Number(tournamentRows[0]?.c ?? -1),
      registrations: Number(registrationRows[0]?.c ?? -1),
    };
  });
  assert.equal(cleanupProof.tournaments, 0);
  assert.equal(cleanupProof.registrations, 0);

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-tournament-wizard-lifecycle",
    release_sha: config.releaseSha,
    runtime_prefix: prefix,
    public_read_verified: true,
    plan_update_verified: true,
    group_validation_verified: true,
    delete_guard_verified: true,
    fk_cleanup_verified: true,
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
      `INSERT INTO \`${prefix}clubs\` (name,slug) VALUES (?,?)`,
      [`Wizard E2E ${suffix}`, `wizard-e2e-${suffix}`],
    );
    fixture.club = requireInsertId(club, "club");

    for (let index = 0; index < 4; index += 1) {
      const inserted = await sql.execute(
        `INSERT INTO \`${prefix}players\` (club_id,display_name,first_name,last_name) VALUES (?,?,?,?)`,
        [fixture.club, `Wizard Player ${index + 1} ${suffix}`, `Wizard${index + 1}`, `Player${suffix}`],
      );
      fixture.players.push(requireInsertId(inserted, `player ${index + 1}`));
    }

    const tournament = await sql.execute(
      `INSERT INTO \`${prefix}tournaments\`
        (club_id,name,slug,provider_system,status,start_at,
         planned_group_count,planned_group_draw_mode,planned_group_best_of_legs,
         planned_qualifiers_per_group,planned_playoff_best_of_legs,planned_auto_create_playoff,
         planned_tournament_format,planned_starting_score)
       VALUES (?,?,?,'local','draft',DATE_ADD(NOW(),INTERVAL 1 DAY),1,'elo_snake',3,2,3,1,'groups_playoff',501)`,
      [fixture.club, `Wizard ${suffix}`, `wizard-${suffix}`],
    );
    fixture.tournament = requireInsertId(tournament, "tournament");

    for (const playerId of fixture.players) {
      await sql.execute(
        `INSERT INTO \`${prefix}tournament_players\`
          (tournament_id,player_id,status,registration_source,checked_in_at,checkin_source)
         VALUES (?,?,'checked_in','admin',NOW(3),'admin_override')`,
        [fixture.tournament, playerId],
      );
    }

    const username = `wizard-e2e-${suffix}`;
    const user = await sql.execute(
      `INSERT INTO \`${prefix}user_accounts\`
        (username,email,password_hash,display_name,role,is_active,account_status)
       VALUES (?,?,NULL,?,'player',1,'active')`,
      [username, `${username}@example.invalid`, `Wizard Admin ${suffix}`],
    );
    fixture.user = requireInsertId(user, "user");
    await sql.execute(`INSERT INTO \`${prefix}global_user_roles\` (user_account_id,role) VALUES (?,'super_admin')`, [fixture.user]);
    const session = await sql.execute(
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
    await provider.withConnection(async (sql) => {
      if (fixture.match) await sql.execute(`DELETE FROM \`${prefix}matches\` WHERE id=?`, [fixture.match]);
      if (fixture.tournament) {
        await sql.execute(`DELETE FROM \`${prefix}tournament_players\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}tournaments\` WHERE id=?`, [fixture.tournament]);
      }
      if (fixture.session) await sql.execute(`DELETE FROM \`${prefix}auth_sessions\` WHERE id=?`, [fixture.session]);
      if (fixture.user) {
        await sql.execute(`DELETE FROM \`${prefix}global_user_roles\` WHERE user_account_id=?`, [fixture.user]);
        await sql.execute(`DELETE FROM \`${prefix}club_user_roles\` WHERE user_account_id=?`, [fixture.user]);
        await sql.execute(`DELETE FROM \`${prefix}user_accounts\` WHERE id=?`, [fixture.user]);
      }
      for (const playerId of fixture.players) await sql.execute(`DELETE FROM \`${prefix}players\` WHERE id=?`, [playerId]);
      await sql.execute(`DELETE FROM \`${prefix}clubs\` WHERE id=?`, [fixture.club]);
    });
  } catch (cleanupError) {
    console.error("backend-v2 tournament wizard E2E cleanup failed", cleanupError);
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

async function requestJson(path, { method, body = undefined, expectedStatus = 200, authenticated = true }) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(authenticated ? { authorization: `Bearer ${bearer}` } : {}),
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
