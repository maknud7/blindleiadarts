import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

import { loadRuntimeConfig } from "../dist/runtime/config.js";
import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test", "Kiosk scoring E2E may only run with BD_APP_ENV=test");
assert.equal(config.mode, "test-write", "Kiosk scoring E2E requires guarded test-write mode");
assert.equal(config.prefixes.runtime, "bd_test_", "Kiosk scoring E2E may only mutate bd_test_ runtime tables");
assert.equal(config.prefixes.identity, "bd_test_", "Isolated kiosk scoring E2E may only use bd_test_ identity fixtures");
assert.equal(config.prefixes.hardware, "bd_test_", "Isolated kiosk scoring E2E must never write bd_prod_ hardware");
assert.equal(config.mysql.budget.maxConcurrentConnections, 1, "Kiosk scoring E2E must use one backend connection");

const prefix = config.prefixes.runtime;
const suffix = randomBytes(6).toString("hex");
const pairingToken = `kiosk-score-${randomBytes(24).toString("hex")}`;
const wrongToken = `wrong-${randomBytes(24).toString("hex")}`;
const pairingHash = await bcrypt.hash(pairingToken, 10);
const code = `kiosk-score-${suffix}`;
const idleCode = `kiosk-idle-${suffix}`;
const fixture = {
  club: null,
  playerA: null,
  playerB: null,
  tournament: null,
  kiosk: null,
  idleKiosk: null,
  match: null,
};
const baseUrl = `http://127.0.0.1:${config.port}`;
let server = null;
let serverOutput = "";

try {
  const fixtureProvider = makeProvider();
  await createFixture(fixtureProvider);
  await fixtureProvider.close();

  server = startServer();
  await waitForReady();

  const wrongPairing = await requestJson(`/v1/kiosks/${encodeURIComponent(code)}/state`, {
    pairingToken: wrongToken,
    expectedStatus: 409,
  });
  assert.equal(wrongPairing.error.code, "kiosk_paired_to_other_device");

  const missingPairing = await requestJson(`/v1/kiosks/${encodeURIComponent(code)}/state`, {
    expectedStatus: 403,
  });
  assert.equal(missingPairing.error.code, "kiosk_pairing_required");

  const assigned = await requestJson(`/v1/kiosks/${encodeURIComponent(code)}/state`, {
    pairingToken,
  });
  assert.equal(assigned.ok, true);
  assert.equal(assigned.state, "assigned");
  assert.equal(typeof assigned.kiosk.id, "string");
  assert.equal(String(assigned.kiosk.id), fixture.kiosk);
  assert.equal(typeof assigned.match.id, "string");
  assert.equal(String(assigned.match.id), fixture.match);
  assert.equal(assigned.match.player_a.id, fixture.playerA);
  assert.equal(assigned.match.player_b.id, fixture.playerB);
  assert.equal(assigned.match.player_a.remaining, 501);
  assert.equal(assigned.match.player_b.remaining, 501);
  assert.equal(assigned.match.current_player_id, fixture.playerA);
  assert.equal(assigned.match.current_leg.id, null);
  assert.equal(assigned.match.current_leg.status, "pending");

  const idle = await requestJson(`/v1/kiosks/${encodeURIComponent(idleCode)}/state`);
  assert.equal(idle.ok, true);
  assert.equal(idle.state, "idle");
  assert.equal(String(idle.kiosk.id), fixture.idleKiosk);
  assert.match(String(idle.message), /No assigned or active match/);

  const started = await requestJson(`/v1/kiosks/${encodeURIComponent(code)}/start-match`, {
    method: "POST",
    pairingToken,
    body: {},
  });
  assert.equal(started.ok, true);
  assert.equal(started.state, "in_progress");
  assert.equal(started.match.current_leg.leg_number, 1);
  assert.equal(started.match.current_leg.status, "in_progress");
  assert.equal(started.match.current_player_id, fixture.playerA);
  assert.equal(started.match.player_a.remaining, 501);

  const visited = await requestJson(`/v1/kiosks/${encodeURIComponent(code)}/visit`, {
    method: "POST",
    pairingToken,
    body: { score: 60, darts_used: 3, input_mode: "sum" },
  });
  assert.equal(visited.ok, true);
  assert.equal(visited.state, "in_progress");
  assert.equal(visited.match.player_a.remaining, 441);
  assert.equal(visited.match.player_b.remaining, 501);
  assert.equal(visited.match.current_player_id, fixture.playerB);
  assert.equal(visited.match.recent_visits.length, 1);
  assert.equal(visited.match.recent_visits[0].player_id, fixture.playerA);
  assert.equal(visited.match.recent_visits[0].score, 60);
  assert.equal(visited.match.recent_visits[0].remaining_after, 441);

  const undone = await requestJson(`/v1/kiosks/${encodeURIComponent(code)}/undo`, {
    method: "POST",
    pairingToken,
    body: {},
  });
  assert.equal(undone.ok, true);
  assert.equal(undone.state, "in_progress");
  assert.equal(undone.match.player_a.remaining, 501);
  assert.equal(undone.match.player_b.remaining, 501);
  assert.equal(undone.match.current_player_id, fixture.playerA);
  assert.deepEqual(undone.match.recent_visits, []);

  const wrongUnpair = await requestJson(`/v1/kiosks/${encodeURIComponent(code)}/unpair`, {
    method: "POST",
    pairingToken: wrongToken,
    expectedStatus: 409,
  });
  assert.equal(wrongUnpair.error.code, "kiosk_paired_to_other_device");

  const missingUnpair = await requestJson(`/v1/kiosks/${encodeURIComponent(code)}/unpair`, {
    method: "POST",
    expectedStatus: 403,
  });
  assert.equal(missingUnpair.error.code, "kiosk_pairing_required");

  const unpaired = await requestJson(`/v1/kiosks/${encodeURIComponent(code)}/unpair`, {
    method: "POST",
    pairingToken,
  });
  assert.equal(unpaired.ok, true);
  assert.equal(unpaired.state, "in_progress");
  assert.equal(String(unpaired.kiosk.id), fixture.kiosk);
  assert.equal(unpaired.kiosk.is_paired, false);
  assert.equal(unpaired.kiosk.paired_device_name, null);
  assert.equal(unpaired.kiosk.paired_at, null);

  const unpairedState = await requestJson(`/v1/kiosks/${encodeURIComponent(code)}/state`);
  assert.equal(unpairedState.ok, true);
  assert.equal(unpairedState.state, "in_progress");
  assert.equal(unpairedState.kiosk.is_paired, false);
  assert.equal(String(unpairedState.match.id), fixture.match);

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-kiosk-scoring-frontdoor-lifecycle",
    release_sha: config.releaseSha,
    runtime_prefix: prefix,
    max_connections: config.mysql.budget.maxConcurrentConnections,
    paired_access_verified: true,
    unpaired_test_alias_verified: true,
    state_verified: true,
    start_match_verified: true,
    visit_verified: true,
    undo_verified: true,
    unpair_verified: true,
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
  const cleanupProvider = makeProvider();
  await cleanupFixture(cleanupProvider);
  await cleanupProvider.close();
}

function makeProvider() {
  return new MySql2SessionProvider({
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
}

async function createFixture(dbProvider) {
  await dbProvider.withConnection(async (sql) => {
    const club = await sql.execute(
      `INSERT INTO \`${prefix}clubs\` (name,slug) VALUES (?,?)`,
      [`Kiosk scoring E2E ${suffix}`, `kiosk-scoring-e2e-${suffix}`],
    );
    fixture.club = requireInsertId(club, "club");

    const playerA = await sql.execute(
      `INSERT INTO \`${prefix}players\` (club_id,display_name,is_active) VALUES (?,?,1)`,
      [fixture.club, `Kiosk scoring A ${suffix}`],
    );
    fixture.playerA = requireInsertId(playerA, "player A");
    const playerB = await sql.execute(
      `INSERT INTO \`${prefix}players\` (club_id,display_name,is_active) VALUES (?,?,1)`,
      [fixture.club, `Kiosk scoring B ${suffix}`],
    );
    fixture.playerB = requireInsertId(playerB, "player B");

    const kiosk = await sql.execute(
      `INSERT INTO \`${prefix}kiosks\`
        (club_id,code,name,board_number,scoring_mode,pairing_token_hash,paired_device_name,paired_at,is_active)
       VALUES (?,?,?,9997,'manual',?,?,NOW(),1)`,
      [fixture.club, code, `Kiosk scoring E2E ${suffix}`, pairingHash, `E2E paired device ${suffix}`],
    );
    fixture.kiosk = requireInsertId(kiosk, "paired kiosk");

    const idleKiosk = await sql.execute(
      `INSERT INTO \`${prefix}kiosks\`
        (club_id,code,name,board_number,scoring_mode,pairing_token_hash,is_active)
       VALUES (?,?,?,9998,'manual',NULL,1)`,
      [fixture.club, idleCode, `Kiosk scoring idle ${suffix}`],
    );
    fixture.idleKiosk = requireInsertId(idleKiosk, "idle kiosk");

    const tournament = await sql.execute(
      `INSERT INTO \`${prefix}tournaments\` (club_id,name,slug,provider_system,status,start_at)
       VALUES (?,?,?,'local','ready',NOW())`,
      [fixture.club, `Kiosk scoring tournament ${suffix}`, `kiosk-scoring-t-${suffix}`],
    );
    fixture.tournament = requireInsertId(tournament, "tournament");

    const match = await sql.execute(
      `INSERT INTO \`${prefix}matches\`
        (tournament_id,kiosk_id,status,best_of_legs,legs_to_win,player_a_id,player_b_id,round_label)
       VALUES (?,?,'assigned',3,2,?,?,?)`,
      [fixture.tournament, fixture.kiosk, fixture.playerA, fixture.playerB, "Kiosk scoring E2E"],
    );
    fixture.match = requireInsertId(match, "match");
  });
}

async function cleanupFixture(dbProvider) {
  if (!fixture.club) return;
  try {
    await dbProvider.withConnection(async (sql) => {
      if (fixture.match) {
        await sql.execute(`DELETE FROM \`${prefix}match_statistics\` WHERE match_id=?`, [fixture.match]);
        await sql.execute(`DELETE FROM \`${prefix}live_match_states\` WHERE match_id=?`, [fixture.match]);
        await sql.execute(`DELETE FROM \`${prefix}visits\` WHERE match_id=?`, [fixture.match]);
        await sql.execute(`DELETE FROM \`${prefix}legs\` WHERE match_id=?`, [fixture.match]);
        await sql.execute(`DELETE FROM \`${prefix}matches\` WHERE id=?`, [fixture.match]);
      }
      if (fixture.tournament) {
        await sql.execute(`DELETE FROM \`${prefix}tournament_summaries\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}tournaments\` WHERE id=?`, [fixture.tournament]);
      }
      if (fixture.kiosk) await sql.execute(`DELETE FROM \`${prefix}kiosks\` WHERE id=?`, [fixture.kiosk]);
      if (fixture.idleKiosk) await sql.execute(`DELETE FROM \`${prefix}kiosks\` WHERE id=?`, [fixture.idleKiosk]);
      if (fixture.playerA) await sql.execute(`DELETE FROM \`${prefix}players\` WHERE id=?`, [fixture.playerA]);
      if (fixture.playerB) await sql.execute(`DELETE FROM \`${prefix}players\` WHERE id=?`, [fixture.playerB]);
      await sql.execute(`DELETE FROM \`${prefix}clubs\` WHERE id=?`, [fixture.club]);
    });
  } catch (cleanupError) {
    console.error("backend-v2 kiosk scoring frontdoor cleanup failed", cleanupError);
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
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (server?.exitCode !== null) throw new Error(`backend-v2 exited before readiness. ${serverOutput}`);
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

async function requestJson(path, { method = "GET", pairingToken: token, body, expectedStatus = 200 } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["x-kiosk-pairing-token"] = token;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  const json = await response.json();
  assert.equal(response.status, expectedStatus, `${method} ${path} returned ${response.status}: ${JSON.stringify(json)}`);
  assert.equal(response.ok, expectedStatus >= 200 && expectedStatus < 300, `${method} ${path} response.ok mismatch`);
  return json;
}

function requireInsertId(result, name) {
  assert.ok(result.insertId, `${name} insert did not return an id`);
  return String(result.insertId);
}
