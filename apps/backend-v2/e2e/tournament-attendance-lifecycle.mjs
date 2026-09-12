import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { loadRuntimeConfig } from "../dist/runtime/config.js";
import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test", "Attendance E2E may only run with BD_APP_ENV=test");
assert.equal(config.mode, "test-write", "Attendance E2E requires guarded test-write mode");
assert.equal(config.prefixes.runtime, "bd_test_", "Attendance E2E may only mutate bd_test_ runtime tables");
assert.equal(config.prefixes.identity, "bd_test_", "Attendance E2E may only mutate bd_test_ identity tables");
assert.equal(config.mysql.budget.maxConcurrentConnections, 1, "Attendance E2E must use one MySQL connection");

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
const bearer = `attendance-e2e-${randomBytes(24).toString("hex")}`;
const bearerHash = createHash("sha256").update(bearer).digest("hex");
const fixture = { club: null, tournaments: [], players: [], user: null, session: null };
const baseUrl = `http://127.0.0.1:${config.port}`;
let server = null;
let serverOutput = "";

try {
  await createFixture();
  server = startServer();
  await waitForReady();

  const [manualTournament, directStartTournament] = fixture.tournaments;
  const [selfPlayer] = fixture.players;

  const missingCode = await requestJson(`/v1/tournaments/${manualTournament}/check-in`, {
    method: "POST",
    body: {},
    expectedStatus: 422,
  });
  assert.equal(missingCode.error.code, "checkin_code_required");

  const badCode = await requestJson(`/v1/tournaments/${manualTournament}/check-in`, {
    method: "POST",
    body: { code: "ZZZ" },
    expectedStatus: 409,
  });
  assert.equal(badCode.error.code, "checkin_code_invalid");

  const checkedIn = await postJson(`/v1/tournaments/${manualTournament}/check-in`, { code: "a-b-c" });
  assert.equal(String(checkedIn.registration.player_id), selfPlayer);
  assert.equal(checkedIn.registration.status, "checked_in");
  assert.equal(checkedIn.registration.checkin_source, "player_code");
  assert.equal(checkedIn.registration.already_checked_in, false);
  assert.ok(checkedIn.registration.checked_in_at);

  const idempotent = await postJson(`/v1/tournaments/${manualTournament}/check-in`, {});
  assert.equal(idempotent.registration.already_checked_in, true);
  assert.equal(idempotent.registration.checkin_source, "player_code");

  const finished = await postJson(`/v1/tournaments/${manualTournament}/finish-checkin`, {});
  assert.equal(finished.attendance.status, "ready");
  assert.equal(finished.attendance.checked_in_count, 2);
  assert.equal(finished.attendance.no_show_count, 1);
  assert.equal(finished.attendance.withdrawn_waitlist_count, 1);
  assert.equal(finished.attendance.already_finished, false);

  const closedAt = await provider.withConnection(async (db) => {
    const rows = await db.query(
      `SELECT status,checkin_closes_at,registration_closes_at FROM \`${prefix}tournaments\` WHERE id=?`,
      [manualTournament],
    );
    return rows[0];
  });
  assert.equal(closedAt.status, "ready");
  assert.ok(closedAt.checkin_closes_at);
  assert.ok(closedAt.registration_closes_at);

  const started = await postJson(`/v1/tournaments/${manualTournament}/start`, {});
  assert.equal(started.start.status, "in_progress");
  assert.equal(started.start.checked_in_count, 2);
  assert.equal(started.start.already_started, false);

  const directStarted = await postJson(`/v1/tournaments/${directStartTournament}/start`, {});
  assert.equal(directStarted.start.status, "in_progress");
  assert.equal(directStarted.start.checked_in_count, 2);

  const directState = await provider.withConnection(async (db) => {
    const tournamentRows = await db.query(
      `SELECT status,checkin_closes_at,registration_closes_at FROM \`${prefix}tournaments\` WHERE id=?`,
      [directStartTournament],
    );
    const playerRows = await db.query(
      `SELECT status,COUNT(*) AS cnt FROM \`${prefix}tournament_players\` WHERE tournament_id=? GROUP BY status`,
      [directStartTournament],
    );
    return { tournament: tournamentRows[0], players: Object.fromEntries(playerRows.map((row) => [row.status, Number(row.cnt)])) };
  });
  assert.equal(directState.tournament.status, "in_progress");
  assert.ok(directState.tournament.checkin_closes_at, "direct start must finalize attendance first");
  assert.ok(directState.tournament.registration_closes_at, "direct start must close registration first");
  assert.equal(directState.players.checked_in, 2);
  assert.equal(directState.players.no_show, 1);
  assert.equal(directState.players.withdrawn, 1);

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-tournament-attendance-lifecycle",
    release_sha: config.releaseSha,
    runtime_prefix: prefix,
    checked_in_with_code: true,
    finish_checkin: true,
    direct_start_finalizes_attendance: true,
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
      [`Attendance E2E ${suffix}`, `attendance-e2e-${suffix}`],
    );
    fixture.club = requireInsertId(club, "club");

    for (let index = 0; index < 4; index += 1) {
      const inserted = await sql.execute(
        `INSERT INTO \`${prefix}players\` (club_id,display_name) VALUES (?,?)`,
        [fixture.club, `Attendance E2E Player ${index + 1} ${suffix}`],
      );
      fixture.players.push(requireInsertId(inserted, `player ${index + 1}`));
    }

    const identityMemberId = fixture.players[0];
    await sql.execute(
      `UPDATE \`${prefix}players\` SET member_id=? WHERE id=?`,
      [identityMemberId, fixture.players[0]],
    );

    const checkinCodes = ["ABC", "DEF"];
    for (let index = 0; index < 2; index += 1) {
      const tournament = await sql.execute(
        `INSERT INTO \`${prefix}tournaments\`
          (club_id,name,slug,provider_system,status,start_at,registration_opens_at,registration_closes_at,
           checkin_opens_at,checkin_method,checkin_code,max_players)
         VALUES (?,?,?,'local','draft',DATE_ADD(NOW(),INTERVAL 1 DAY),DATE_SUB(NOW(),INTERVAL 1 DAY),DATE_ADD(NOW(),INTERVAL 2 DAY),
                 DATE_SUB(NOW(),INTERVAL 1 HOUR),'code',?,16)`,
        [fixture.club, `Attendance E2E ${index + 1} ${suffix}`, `attendance-e2e-${index + 1}-${suffix}`, checkinCodes[index]],
      );
      fixture.tournaments.push(requireInsertId(tournament, `tournament ${index + 1}`));
    }

    for (const tournamentId of fixture.tournaments) {
      await sql.execute(
        `INSERT INTO \`${prefix}tournament_players\` (tournament_id,player_id,status,registration_source)
         VALUES (?,?,'registered','player'),(?,?,'checked_in','admin'),(?,?,'registered','admin'),(?,?,'waitlisted','admin')`,
        [
          tournamentId, fixture.players[0],
          tournamentId, fixture.players[1],
          tournamentId, fixture.players[2],
          tournamentId, fixture.players[3],
        ],
      );
      await sql.execute(
        `UPDATE \`${prefix}tournament_players\`
            SET checked_in_at=NOW(3),checkin_source='admin_override'
          WHERE tournament_id=? AND player_id=?`,
        [tournamentId, fixture.players[1]],
      );
    }

    const username = `attendance-e2e-${suffix}`;
    const user = await sql.execute(
      `INSERT INTO \`${prefix}user_accounts\`
        (username,email,password_hash,display_name,player_id,member_id,role,is_active,account_status)
       VALUES (?,?,NULL,?,?,?,'player',1,'active')`,
      [username, `${username}@example.invalid`, `Attendance E2E Admin ${suffix}`, fixture.players[0], identityMemberId],
    );
    fixture.user = requireInsertId(user, "user");
    await sql.execute(
      `INSERT INTO \`${prefix}global_user_roles\` (user_account_id,role) VALUES (?,'super_admin')`,
      [fixture.user],
    );
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
      for (const tournamentId of fixture.tournaments) {
        await sql.execute(`DELETE FROM \`${prefix}tournament_elo_snapshots\` WHERE tournament_id=?`, [tournamentId]);
        await sql.execute(`DELETE FROM \`${prefix}tournament_players\` WHERE tournament_id=?`, [tournamentId]);
        await sql.execute(`DELETE FROM \`${prefix}tournaments\` WHERE id=?`, [tournamentId]);
      }
      if (fixture.session) await sql.execute(`DELETE FROM \`${prefix}auth_sessions\` WHERE id=?`, [fixture.session]);
      if (fixture.user) {
        await sql.execute(`DELETE FROM \`${prefix}global_user_roles\` WHERE user_account_id=?`, [fixture.user]);
        await sql.execute(`DELETE FROM \`${prefix}club_user_roles\` WHERE user_account_id=?`, [fixture.user]);
        await sql.execute(`DELETE FROM \`${prefix}user_accounts\` WHERE id=?`, [fixture.user]);
      }
      for (const playerId of fixture.players) {
        await sql.execute(`DELETE FROM \`${prefix}players\` WHERE id=?`, [playerId]);
      }
      await sql.execute(`DELETE FROM \`${prefix}clubs\` WHERE id=?`, [fixture.club]);
    });
  } catch (cleanupError) {
    console.error("backend-v2 attendance E2E cleanup failed", cleanupError);
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

async function postJson(path, body) {
  return requestJson(path, { method: "POST", body });
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
