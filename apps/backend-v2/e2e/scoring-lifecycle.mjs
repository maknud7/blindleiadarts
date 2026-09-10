import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import { loadRuntimeConfig } from "../dist/runtime/config.js";
import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test", "E2E may only run with BD_APP_ENV=test");
assert.equal(config.mode, "test-write", "E2E requires the guarded test-write mode");
assert.equal(config.prefixes.runtime, "bd_test_", "E2E may only mutate bd_test_ runtime tables");
assert.equal(config.mysql.budget.maxConcurrentConnections, 1, "E2E must keep backend-v2 at one connection");

const token = config.internalToken;
assert.ok(token, "E2E requires BD_BACKEND_V2_INTERNAL_TOKEN");

const provider = new MySql2SessionProvider({
  host: config.mysql.host,
  port: config.mysql.port,
  database: config.mysql.database,
  username: config.mysql.username,
  password: config.mysql.password,
  connectTimeoutMs: config.mysql.connectTimeoutMs,
  budget: config.mysql.budget,
  writable: true,
});
const prefix = config.prefixes.runtime;
const suffix = randomBytes(6).toString("hex");
const fixture = {
  club: null,
  playerA: null,
  playerB: null,
  tournament: null,
  kiosk: null,
  match: null,
};
const baseUrl = `http://127.0.0.1:${config.port}`;
let server = null;
let serverOutput = "";

try {
  await createFixture();
  server = startServer();
  await waitForReady();

  const health = await getJson("/health");
  assert.equal(health.ok, true);
  assert.equal(health.environment, "test");
  assert.equal(health.mode, "test-write");
  assert.equal(health.writes_armed, true);
  assert.equal(health.runtime_prefix, "bd_test_");
  assert.equal(health.max_connections, 1);

  const ready = await getJson("/ready");
  assert.equal(ready.ok, true);
  assert.equal(ready.runtime_prefix, "bd_test_");
  assert.deepEqual(ready.checked_tables, [
    "bd_test_matches",
    "bd_test_legs",
    "bd_test_visits",
    "bd_test_match_statistics",
  ]);

  const started = await postJson("/internal/v1/scoring/start-match", {
    kiosk_id: fixture.kiosk,
    source: "api",
  });
  assert.equal(started.result.kind, "started");
  assert.equal(started.result.match_id, fixture.match);

  const request180 = `backend-v2-${suffix}-a180`;
  await visit({ input_mode: "sum", score: 180, darts_used: 3, request_id: request180 });
  const retry = await visit({ input_mode: "sum", score: 180, darts_used: 3, request_id: request180 });
  assert.equal(retry.result.kind, "duplicate");

  const visitCount = await scalar(
    `SELECT COUNT(*) AS value FROM \`${prefix}visits\` WHERE match_id=?`,
    [fixture.match],
  );
  assert.equal(Number(visitCount), 1, "request_id retry inserted a second canonical visit");

  await visit({ input_mode: "sum", score: 60, darts_used: 3 });
  await visit({ input_mode: "sum", score: 160, darts_used: 3 });
  await visit({ input_mode: "sum", score: 60, darts_used: 3 });
  const checkout = await visit({
    input_mode: "per_dart",
    darts_used: 3,
    darts: [
      { multiplier: "T", value: 20 },
      { multiplier: "T", value: 17 },
      { multiplier: "D", value: "BULL" },
    ],
    request_id: `backend-v2-${suffix}-checkout`,
  });
  assert.equal(checkout.result.kind, "recorded");
  assert.equal(checkout.result.match_completed, true);
  assert.equal(checkout.result.evaluation.score, 161);
  assert.equal(checkout.result.evaluation.is_checkout, true);

  const completedMatch = await one(
    `SELECT status, CAST(winner_player_id AS CHAR) AS winner_player_id FROM \`${prefix}matches\` WHERE id=?`,
    [fixture.match],
  );
  assert.equal(completedMatch.status, "completed");
  assert.equal(completedMatch.winner_player_id, fixture.playerA);

  const stats = await one(
    `SELECT legs_won, average, darts_thrown, highest_checkout, score_140_plus, score_180
     FROM \`${prefix}match_statistics\` WHERE match_id=? AND player_id=?`,
    [fixture.match, fixture.playerA],
  );
  assert.equal(Number(stats.legs_won), 1);
  assert.ok(Math.abs(Number(stats.average) - 167.0) < 0.01, `unexpected average ${stats.average}`);
  assert.equal(Number(stats.darts_thrown), 9);
  assert.equal(Number(stats.highest_checkout), 161);
  assert.equal(Number(stats.score_180), 1);
  assert.equal(Number(stats.score_140_plus), 2);

  const undone = await postJson("/internal/v1/scoring/undo", {
    kiosk_id: fixture.kiosk,
    source: "api",
  });
  assert.equal(undone.result.kind, "undone");
  assert.equal(undone.result.match_id, fixture.match);

  const reopenedMatch = await one(
    `SELECT status, CAST(winner_player_id AS CHAR) AS winner_player_id FROM \`${prefix}matches\` WHERE id=?`,
    [fixture.match],
  );
  assert.equal(reopenedMatch.status, "in_progress");
  assert.equal(reopenedMatch.winner_player_id, null);

  const rebuilt = await one(
    `SELECT legs_won, average, darts_thrown, highest_checkout, score_140_plus, score_180
     FROM \`${prefix}match_statistics\` WHERE match_id=? AND player_id=?`,
    [fixture.match, fixture.playerA],
  );
  assert.equal(Number(rebuilt.legs_won), 0);
  assert.ok(Math.abs(Number(rebuilt.average) - 170.0) < 0.01, `unexpected undo average ${rebuilt.average}`);
  assert.equal(Number(rebuilt.darts_thrown), 6);
  assert.equal(Number(rebuilt.highest_checkout), 0);
  assert.equal(Number(rebuilt.score_180), 1);
  assert.equal(Number(rebuilt.score_140_plus), 1);

  const visitsAfterUndo = await scalar(
    `SELECT COUNT(*) AS value FROM \`${prefix}visits\` WHERE match_id=?`,
    [fixture.match],
  );
  assert.equal(Number(visitsAfterUndo), 4);

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-scoring-lifecycle",
    release_sha: config.releaseSha,
    match_id: fixture.match,
    runtime_prefix: prefix,
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
}

async function createFixture() {
  await provider.withConnection(async (sql) => {
    const club = await sql.execute(
      `INSERT INTO \`${prefix}clubs\` (name, slug) VALUES (?, ?)`,
      [`Backend v2 E2E ${suffix}`, `backend-v2-e2e-${suffix}`],
    );
    fixture.club = requireInsertId(club, "club");

    const playerA = await sql.execute(
      `INSERT INTO \`${prefix}players\` (club_id, display_name) VALUES (?, ?)`,
      [fixture.club, "Backend v2 E2E A"],
    );
    fixture.playerA = requireInsertId(playerA, "player A");

    const playerB = await sql.execute(
      `INSERT INTO \`${prefix}players\` (club_id, display_name) VALUES (?, ?)`,
      [fixture.club, "Backend v2 E2E B"],
    );
    fixture.playerB = requireInsertId(playerB, "player B");

    const tournament = await sql.execute(
      `INSERT INTO \`${prefix}tournaments\` (club_id, name, slug, provider_system, status, start_at)
       VALUES (?, ?, ?, "local", "ready", NOW())`,
      [fixture.club, `Backend v2 E2E Tournament ${suffix}`, `backend-v2-e2e-tournament-${suffix}`],
    );
    fixture.tournament = requireInsertId(tournament, "tournament");

    const kiosk = await sql.execute(
      `INSERT INTO \`${prefix}kiosks\` (club_id, code, name, board_number) VALUES (?, ?, ?, ?)`,
      [fixture.club, `BV2-${suffix.slice(0, 8).toUpperCase()}`, "Backend v2 E2E Board", 998],
    );
    fixture.kiosk = requireInsertId(kiosk, "kiosk");

    const match = await sql.execute(
      `INSERT INTO \`${prefix}matches\`
       (tournament_id, kiosk_id, status, best_of_legs, legs_to_win, player_a_id, player_b_id)
       VALUES (?, ?, "assigned", 1, 1, ?, ?)`,
      [fixture.tournament, fixture.kiosk, fixture.playerA, fixture.playerB],
    );
    fixture.match = requireInsertId(match, "match");
  });
}

async function cleanupFixture() {
  if (!fixture.club) return;
  try {
    await provider.withConnection(async (sql) => {
      if (fixture.match) {
        await sql.execute(`DELETE FROM \`${prefix}match_statistics\` WHERE match_id=?`, [fixture.match]);
        await sql.execute(`DELETE FROM \`${prefix}live_match_states\` WHERE match_id=?`, [fixture.match]);
        await sql.execute(`DELETE FROM \`${prefix}visits\` WHERE match_id=?`, [fixture.match]);
        await sql.execute(`DELETE FROM \`${prefix}legs\` WHERE match_id=?`, [fixture.match]);
        await sql.execute(`DELETE FROM \`${prefix}matches\` WHERE id=?`, [fixture.match]);
      }
      if (fixture.kiosk) await sql.execute(`DELETE FROM \`${prefix}kiosks\` WHERE id=?`, [fixture.kiosk]);
      if (fixture.tournament) {
        await sql.execute(`DELETE FROM \`${prefix}tournament_summaries\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}tournaments\` WHERE id=?`, [fixture.tournament]);
      }
      if (fixture.playerA) await sql.execute(`DELETE FROM \`${prefix}players\` WHERE id=?`, [fixture.playerA]);
      if (fixture.playerB) await sql.execute(`DELETE FROM \`${prefix}players\` WHERE id=?`, [fixture.playerB]);
      await sql.execute(`DELETE FROM \`${prefix}clubs\` WHERE id=?`, [fixture.club]);
    });
  } catch (cleanupError) {
    console.error("backend-v2 E2E cleanup failed", cleanupError);
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
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (server?.exitCode !== null) {
      throw new Error(`backend-v2 exited before readiness. ${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
      lastError = new Error(`ready returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError ?? new Error("backend-v2 did not become ready");
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(5000) });
  const json = await response.json();
  assert.equal(response.ok, true, `${path} failed: ${JSON.stringify(json)}`);
  return json;
}

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bd-backend-v2-token": token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const json = await response.json();
  assert.equal(response.ok, true, `${path} failed: ${JSON.stringify(json)}`);
  return json;
}

async function visit(payload) {
  return postJson("/internal/v1/scoring/visit", {
    kiosk_id: fixture.kiosk,
    source: "api",
    payload,
  });
}

async function one(sqlText, params) {
  return provider.withConnection(async (sql) => {
    const rows = await sql.query(sqlText, params);
    assert.ok(rows[0], `query returned no row: ${sqlText}`);
    return rows[0];
  });
}

async function scalar(sqlText, params) {
  const row = await one(sqlText, params);
  return row.value;
}

function requireInsertId(result, name) {
  assert.ok(result.insertId, `${name} insert did not return an id`);
  return result.insertId;
}
