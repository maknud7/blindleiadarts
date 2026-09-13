import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { loadRuntimeConfig } from "../dist/runtime/config.js";
import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test", "Board admin E2E may only run with BD_APP_ENV=test");
assert.equal(config.mode, "test-write", "Board admin E2E requires guarded test-write mode");
assert.equal(config.prefixes.runtime, "bd_test_", "Board admin E2E may only mutate bd_test_ runtime tables");
assert.equal(config.prefixes.identity, "bd_test_", "Board admin E2E may only mutate bd_test_ identity tables");
assert.equal(config.prefixes.hardware, "bd_prod_", "Board admin E2E must preserve PROD hardware read prefix");
assert.equal(config.mysql.budget.maxConcurrentConnections, 1, "Board admin E2E must use one MySQL connection");

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
const bearer = `board-admin-e2e-${randomBytes(24).toString("hex")}`;
const bearerHash = createHash("sha256").update(bearer).digest("hex");
const fixture = { club: null, tournament: null, players: [], kiosks: [], matches: [], user: null, session: null };
const baseUrl = `http://127.0.0.1:${config.port}`;
let server = null;
let serverOutput = "";

try {
  await createFixture();
  server = startServer();
  await waitForReady();

  const initial = await getJson(`/v1/tournaments/${fixture.tournament}/board-assignments`);
  assert.equal(String(initial.tournament.id), fixture.tournament);
  assert.equal(initial.boards.length, 3);
  assert.equal(Number(initial.queue.pending_count), 0);
  assert.ok(initial.boards.every((board) => String(board.id).match(/^[1-9][0-9]*$/)));

  const selected = await putJson(`/v1/tournaments/${fixture.tournament}/board-assignments`, {
    kiosk_ids: fixture.kiosks,
  });
  assert.equal(selected.boards.filter((board) => Number(board.is_assigned_to_tournament) === 1).length, 3);

  const pending = await requestJson(`/v1/tournaments/${fixture.tournament}/matches`, {
    method: "POST",
    body: {
      player_a_id: fixture.players[0],
      player_b_id: fixture.players[1],
      round_label: "E2E pending",
      best_of_legs: 3,
    },
    expectedStatus: 201,
  });
  fixture.matches.push(String(pending.match.id));
  assert.equal(pending.match.status, "pending");
  assert.equal(pending.match.kiosk_id, null);

  const rejectedBeforeCheckin = await requestJson(`/v1/tournaments/${fixture.tournament}/matches`, {
    method: "POST",
    body: {
      player_a_id: fixture.players[4],
      player_b_id: fixture.players[5],
      kiosk_id: fixture.kiosks[0],
      round_label: "E2E requires checkin",
    },
    expectedStatus: 422,
  });
  assert.equal(rejectedBeforeCheckin.error.code, "players_not_checked_in_for_tournament");

  await provider.withConnection(async (sql) => {
    await sql.execute(
      `UPDATE \`${prefix}tournament_players\` SET status='checked_in' WHERE tournament_id=?`,
      [fixture.tournament],
    );
  });

  const direct = await requestJson(`/v1/tournaments/${fixture.tournament}/matches`, {
    method: "POST",
    body: {
      player_a_id: fixture.players[4],
      player_b_id: fixture.players[5],
      kiosk_id: fixture.kiosks[0],
      round_label: "E2E direct",
      best_of_legs: 5,
      legs_to_win: 3,
    },
    expectedStatus: 201,
  });
  fixture.matches.push(String(direct.match.id));
  assert.equal(direct.match.status, "assigned");
  assert.equal(String(direct.match.kiosk_id), fixture.kiosks[0]);

  const secondPending = await requestJson(`/v1/tournaments/${fixture.tournament}/matches`, {
    method: "POST",
    body: {
      player_a_id: fixture.players[2],
      player_b_id: fixture.players[3],
      round_label: "E2E auto assign",
    },
    expectedStatus: 201,
  });
  fixture.matches.push(String(secondPending.match.id));
  assert.equal(secondPending.match.status, "pending");

  const assigned = await postJson(`/v1/matches/${pending.match.id}/assign-kiosk`, {
    kiosk_id: fixture.kiosks[1],
  });
  assert.equal(assigned.match.status, "assigned");
  assert.equal(String(assigned.match.kiosk_id), fixture.kiosks[1]);

  const autoAssigned = await postJson(`/v1/tournaments/${fixture.tournament}/auto-assign`, {});
  assert.equal(Number(autoAssigned.assigned_count), 1);
  assert.equal(String(autoAssigned.assigned[0].match_id), String(secondPending.match.id));
  assert.equal(String(autoAssigned.assigned[0].kiosk_id), fixture.kiosks[2]);

  const finalOverview = await getJson(`/v1/tournaments/${fixture.tournament}/board-assignments`);
  assert.equal(Number(finalOverview.queue.pending_count), 0);
  assert.equal(Number(finalOverview.queue.assigned_count), 3);
  assert.equal(Number(finalOverview.queue.in_progress_count), 0);
  assert.equal(finalOverview.queue.items.filter((match) => match.players_checked_in === true).length, 3);
  assert.ok(finalOverview.queue.items.every((match) => typeof match.id === "string"));

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-tournament-board-admin-lifecycle",
    release_sha: config.releaseSha,
    runtime_prefix: prefix,
    hardware_prefix: config.prefixes.hardware,
    tournament_id: fixture.tournament,
    selected_boards: fixture.kiosks.length,
    created_matches: fixture.matches.length,
    manual_assignment: true,
    auto_assignment: true,
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
      [`Board Admin E2E ${suffix}`, `board-admin-e2e-${suffix}`],
    );
    fixture.club = requireInsertId(club, "club");

    for (let index = 0; index < 3; index += 1) {
      const kiosk = await sql.execute(
        `INSERT INTO \`${prefix}kiosks\` (club_id,code,name,board_number,is_active) VALUES (?,?,?,?,1)`,
        [fixture.club, `board-admin-${suffix}-${index + 1}`, `Board Admin E2E ${index + 1}`, index + 1],
      );
      fixture.kiosks.push(requireInsertId(kiosk, `kiosk ${index + 1}`));
    }

    for (let index = 0; index < 6; index += 1) {
      const player = await sql.execute(
        `INSERT INTO \`${prefix}players\` (club_id,display_name) VALUES (?,?)`,
        [fixture.club, `Board Admin Player ${index + 1} ${suffix}`],
      );
      fixture.players.push(requireInsertId(player, `player ${index + 1}`));
    }

    const tournament = await sql.execute(
      `INSERT INTO \`${prefix}tournaments\`
        (club_id,name,slug,provider_system,status,start_at,registration_opens_at,registration_closes_at,max_players)
       VALUES (?,?,?,'local','ready',DATE_ADD(NOW(),INTERVAL 1 DAY),DATE_SUB(NOW(),INTERVAL 1 DAY),DATE_ADD(NOW(),INTERVAL 2 DAY),16)`,
      [fixture.club, `Board Admin E2E ${suffix}`, `board-admin-e2e-${suffix}`],
    );
    fixture.tournament = requireInsertId(tournament, "tournament");

    for (const playerId of fixture.players) {
      await sql.execute(
        `INSERT INTO \`${prefix}tournament_players\` (tournament_id,player_id,status,registration_source)
         VALUES (?,?,'registered','admin')`,
        [fixture.tournament, playerId],
      );
    }

    const username = `board-admin-e2e-${suffix}`;
    const user = await sql.execute(
      `INSERT INTO \`${prefix}user_accounts\`
        (username,email,password_hash,display_name,player_id,role,is_active,account_status)
       VALUES (?,?,NULL,?,?,'player',1,'active')`,
      [username, `${username}@example.invalid`, `Board Admin E2E ${suffix}`, fixture.players[0]],
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
      if (fixture.tournament) {
        await sql.execute(`DELETE FROM \`${prefix}tournament_board_reservations\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}matches\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}tournament_kiosks\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}tournament_players\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}tournaments\` WHERE id=?`, [fixture.tournament]);
      }
      if (fixture.session) await sql.execute(`DELETE FROM \`${prefix}auth_sessions\` WHERE id=?`, [fixture.session]);
      if (fixture.user) {
        await sql.execute(`DELETE FROM \`${prefix}global_user_roles\` WHERE user_account_id=?`, [fixture.user]);
        await sql.execute(`DELETE FROM \`${prefix}club_user_roles\` WHERE user_account_id=?`, [fixture.user]);
        await sql.execute(`DELETE FROM \`${prefix}user_accounts\` WHERE id=?`, [fixture.user]);
      }
      for (const kioskId of fixture.kiosks) await sql.execute(`DELETE FROM \`${prefix}kiosks\` WHERE id=?`, [kioskId]);
      for (const playerId of fixture.players) await sql.execute(`DELETE FROM \`${prefix}players\` WHERE id=?`, [playerId]);
      await sql.execute(`DELETE FROM \`${prefix}clubs\` WHERE id=?`, [fixture.club]);
    });
  } catch (cleanupError) {
    console.error("backend-v2 board admin E2E cleanup failed", cleanupError);
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

async function getJson(path) {
  return requestJson(path, { method: "GET" });
}

async function postJson(path, body) {
  return requestJson(path, { method: "POST", body });
}

async function putJson(path, body) {
  return requestJson(path, { method: "PUT", body });
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
  try { payload = JSON.parse(text); }
  catch { throw new Error(`${method} ${path} returned non-JSON ${response.status}: ${text}`); }
  assert.equal(response.status, expectedStatus, `${method} ${path}: ${text}`);
  return payload;
}

function requireInsertId(result, label) {
  const value = String(result.insertId ?? "").trim();
  assert.match(value, /^[1-9][0-9]*$/, `${label} insert id missing`);
  return value;
}
