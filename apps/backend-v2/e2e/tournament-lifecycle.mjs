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
  kiosks: [],
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
    const response = await requestJson(`/v1/tournaments/${fixture.tournament}/registrations`, {
      method: "POST",
      body: { player_id: playerId },
      expectedStatus: 201,
    });
    assert.equal(response.registration.status, "registered");
  }

  const waitlisted = await requestJson(`/v1/tournaments/${fixture.tournament}/registrations`, {
    method: "POST",
    body: { player_id: fixture.players[8] },
    expectedStatus: 201,
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

  const generated = await requestJson(`/v1/tournaments/${fixture.tournament}/groups/round-robin`, {
    method: "POST",
    body: { best_of_legs: 3 },
    expectedStatus: 201,
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

  await provider.withConnection(async (sql) => {
    await sql.execute(
      `UPDATE \`${prefix}tournament_players\` SET status='checked_in' WHERE tournament_id=? AND status='registered'`,
      [fixture.tournament],
    );
  });

  const defaultBoards = await getJson(`/v1/tournaments/${fixture.tournament}/operations/boards`);
  assert.equal(defaultBoards.selection_initialized, false);
  assert.equal(defaultBoards.boards.length, 3);
  assert.ok(defaultBoards.boards.every((board) => board.selected === true));
  assert.ok(defaultBoards.boards.every((board) => typeof board.id === "string"));

  const selectedBoards = await putJson(`/v1/tournaments/${fixture.tournament}/operations/boards`, {
    kiosk_ids: fixture.kiosks,
  });
  assert.equal(selectedBoards.selection_initialized, true);
  assert.equal(selectedBoards.selected_count, 3);
  assert.deepEqual(selectedBoards.boards.filter((board) => board.selected).map((board) => board.id), fixture.kiosks);

  const firstPendingMatchId = String(await scalar(
    `SELECT id AS value FROM \`${prefix}matches\` WHERE tournament_id=? AND status='pending' ORDER BY id LIMIT 1`,
    [fixture.tournament],
  ));
  assert.match(firstPendingMatchId, /^[1-9][0-9]*$/);

  const moved = await postJson(
    `/v1/tournaments/${fixture.tournament}/operations/matches/${firstPendingMatchId}/move`,
    { kiosk_id: fixture.kiosks[0] },
  );
  assert.equal(moved.move.moved, true);
  assert.equal(moved.move.match_id, firstPendingMatchId);
  assert.equal(moved.move.kiosk_id, fixture.kiosks[0]);
  assert.equal(moved.move.status, "assigned");

  const reconciled = await postJson(`/v1/tournaments/${fixture.tournament}/operations/reconcile`, {});
  assert.equal(reconciled.assignment.assigned_count, 2);
  assert.ok(reconciled.assignment.items.every((item) => typeof item.match_id === "string"));
  assert.equal(reconciled.boards.filter((board) => board.active_match_id !== null).length, 3);

  await provider.withConnection(async (sql) => {
    await sql.execute(
      `UPDATE \`${prefix}matches\`
          SET status='completed',winner_player_id=player_a_id,kiosk_id=NULL,starts_at=COALESCE(starts_at,NOW()),finished_at=NOW()
        WHERE tournament_id=? AND tournament_group_id IS NOT NULL`,
      [fixture.tournament],
    );
  });

  const playoffGenerated = await requestJson(`/v1/tournaments/${fixture.tournament}/playoffs/generate`, {
    method: "POST",
    body: { qualifiers_per_group: 2, best_of_legs: 3 },
    expectedStatus: 201,
  });
  assert.equal(playoffGenerated.bracket.playoff.bracket_size, 4);
  assert.equal(playoffGenerated.bracket.entries.length, 4);
  assert.equal(playoffGenerated.bracket.rounds.length, 2);
  assert.equal(playoffGenerated.bracket.rounds[0].nodes.length, 2);
  assert.ok(playoffGenerated.bracket.entries.every((entry) => typeof entry.player_id === "string"));

  const playoffRead = await getJson(`/v1/tournaments/${fixture.tournament}/playoffs`);
  assert.equal(playoffRead.bracket.playoff.status, "ready");
  assert.equal(playoffRead.bracket.rounds[0].label, "Semifinale");
  assert.equal(playoffRead.bracket.rounds[1].label, "Finale");

  await provider.withConnection(async (sql) => {
    await sql.execute(
      `UPDATE \`${prefix}matches\`
          SET status='completed',winner_player_id=player_a_id,starts_at=COALESCE(starts_at,NOW()),finished_at=NOW()
        WHERE tournament_id=? AND bracket_label='Sluttspill' AND round_number=101`,
      [fixture.tournament],
    );
  });

  const semifinalReconcile = await postJson(`/v1/tournaments/${fixture.tournament}/playoffs/reconcile`, {});
  assert.equal(semifinalReconcile.bracket.rounds[0].nodes.every((node) => node.status === "completed"), true);
  assert.equal(semifinalReconcile.bracket.rounds[1].nodes.length, 1);
  assert.equal(semifinalReconcile.bracket.rounds[1].nodes[0].status, "pending");
  assert.match(String(semifinalReconcile.bracket.rounds[1].nodes[0].match_id), /^[1-9][0-9]*$/);

  await provider.withConnection(async (sql) => {
    await sql.execute(
      `UPDATE \`${prefix}matches\`
          SET status='completed',winner_player_id=player_a_id,starts_at=COALESCE(starts_at,NOW()),finished_at=NOW()
        WHERE tournament_id=? AND bracket_label='Sluttspill' AND round_number=102`,
      [fixture.tournament],
    );
  });

  const finalReconcile = await postJson(`/v1/tournaments/${fixture.tournament}/playoffs/reconcile`, {});
  assert.equal(finalReconcile.bracket.playoff.status, "completed");
  assert.match(String(finalReconcile.bracket.playoff.champion_player_id), /^[1-9][0-9]*$/);
  assert.equal(finalReconcile.bracket.tournament.status, "completed");

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-tournament-lifecycle",
    release_sha: config.releaseSha,
    runtime_prefix: prefix,
    tournament_id: fixture.tournament,
    generated_group_matches: 12,
    selected_boards: fixture.kiosks.length,
    playoff_bracket_size: 4,
    playoff_completed: true,
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

    for (let index = 0; index < 3; index += 1) {
      const kiosk = await sql.execute(
        `INSERT INTO \`${prefix}kiosks\` (club_id,code,name,board_number,is_active) VALUES (?,?,?,?,1)`,
        [fixture.club, `e2e-${suffix}-${index + 1}`, `Tournament E2E Board ${index + 1}`, index + 1],
      );
      fixture.kiosks.push(requireInsertId(kiosk, `kiosk ${index + 1}`));
    }

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
        await sql.execute(
          `DELETE n FROM \`${prefix}tournament_playoff_nodes\` n
            INNER JOIN \`${prefix}tournament_playoffs\` p ON p.id=n.playoff_id WHERE p.tournament_id=?`,
          [fixture.tournament],
        );
        await sql.execute(
          `DELETE e FROM \`${prefix}tournament_playoff_entries\` e
            INNER JOIN \`${prefix}tournament_playoffs\` p ON p.id=e.playoff_id WHERE p.tournament_id=?`,
          [fixture.tournament],
        );
        await sql.execute(`DELETE FROM \`${prefix}tournament_playoffs\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}tournament_board_reservations\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}tournament_kiosks\` WHERE tournament_id=?`, [fixture.tournament]);
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
      for (const kioskId of fixture.kiosks) {
        await sql.execute(`DELETE FROM \`${prefix}scolia_visit_buffers\` WHERE kiosk_id=?`, [kioskId]);
        await sql.execute(`DELETE FROM \`${prefix}scolia_board_runtime\` WHERE kiosk_id=?`, [kioskId]);
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
      for (const kioskId of fixture.kiosks) {
        await sql.execute(`DELETE FROM \`${prefix}kiosks\` WHERE id=?`, [kioskId]);
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

async function putJson(path, body) {
  return requestJson(path, { method: "PUT", body });
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
