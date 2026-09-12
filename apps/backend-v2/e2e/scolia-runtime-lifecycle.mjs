import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

import { loadRuntimeConfig } from "../dist/runtime/config.js";
import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test", "Scolia E2E may only run with BD_APP_ENV=test");
assert.equal(config.mode, "test-write", "Scolia E2E requires guarded test-write mode");
assert.equal(config.prefixes.runtime, "bd_test_", "Scolia E2E may only mutate bd_test_ runtime tables");
assert.equal(config.prefixes.identity, "bd_test_", "Scolia E2E may only mutate bd_test_ identity fixtures");
assert.equal(config.prefixes.hardware, "bd_test_", "Isolated Scolia mutation E2E must never write bd_prod_ hardware");
assert.equal(config.mysql.budget.maxConcurrentConnections, 1, "Scolia E2E must use one backend connection");

const suffix = randomBytes(6).toString("hex");
const pairingToken = `scolia-e2e-pair-${randomBytes(24).toString("hex")}`;
const pairingHash = await bcrypt.hash(pairingToken, 10);
const serial = `E2E-${suffix.toUpperCase()}`;
const code = `scolia-e2e-${suffix}`;
const fixture = { club: null, kiosk: null, playerA: null, playerB: null, tournament: null, match: null };
const baseUrl = `http://127.0.0.1:${config.port}`;
let server = null;
let serverOutput = "";

const provider = makeProvider();
try {
  await createFixture(provider);
  await provider.close();

  server = startServer();
  await waitForHealth();

  const unauthorized = await requestJson("/v1/scolia/bridge/config", {
    method: "GET",
    bridgeAuth: false,
    expectedStatus: 401,
  });
  assert.equal(unauthorized.error.code, "scolia_bridge_unauthorized");

  const bridgeConfig = await requestJson("/v1/scolia/bridge/config", { method: "GET" });
  assert.equal(bridgeConfig.ok, true);
  assert.equal(bridgeConfig.configuration_table_prefix, "bd_test_");
  assert.equal(bridgeConfig.runtime_table_prefix, "bd_test_");
  assert.ok(Array.isArray(bridgeConfig.boards));
  const configuredBoard = bridgeConfig.boards.find((board) => String(board.kiosk_id) === fixture.kiosk);
  assert.ok(configuredBoard, "Temporary Scolia board must be visible to isolated bridge config");
  assert.equal(configuredBoard.serial_number, serial);
  assert.equal(configuredBoard.mode, "live");

  const bridgeRouter = await requestJson("/v1/scolia/bridge/router", { method: "GET" });
  assert.equal(bridgeRouter.ok, true);
  assert.equal(bridgeRouter.data.configuration_scope, "production_hardware");
  assert.ok(bridgeRouter.data.configured_boards >= 1);
  assert.equal(bridgeRouter.data.bridge_mode, "idle", "Ready fixture without start_at must not wake physical Scolia routing");

  const bridgeHealth = await requestJson("/v1/scolia/health", { method: "GET", bridgeAuth: false });
  assert.equal(bridgeHealth.ok, true);
  assert.equal(bridgeHealth.service, "scolia-bridge");
  assert.equal(bridgeHealth.data.configuration_scope, "production_hardware");
  assert.ok(bridgeHealth.data.configured_boards >= 1);
  assert.equal(bridgeHealth.data.bridge_status, "sleeping");

  const providerEventId = `hello-${suffix}`;
  const eventBody = {
    serial_number: serial,
    message: {
      id: providerEventId,
      type: "HELLO_CLIENT",
      payload: { boardStatus: "Ready", boardPhase: "Throw" },
    },
  };
  const queued = await requestJson("/v1/scolia/bridge/events", {
    method: "POST",
    body: eventBody,
    expectedStatus: 202,
  });
  assert.equal(queued.ok, true);
  assert.equal(queued.queued, true);
  assert.equal(queued.event.duplicate, false);
  assert.equal(String(queued.event.kiosk_id), fixture.kiosk);

  const duplicate = await requestJson("/v1/scolia/bridge/events", {
    method: "POST",
    body: eventBody,
    expectedStatus: 200,
  });
  assert.equal(duplicate.event.duplicate, true);
  assert.equal(String(duplicate.event.id), String(queued.event.id));

  const drain = await requestJson("/v1/scolia/bridge/drain", {
    method: "POST",
    body: { limit: 10 },
  });
  assert.equal(drain.ok, true);
  assert.equal(drain.claimed, 1);
  assert.equal(drain.processed, 1);
  assert.equal(drain.failed, 0);

  const statusAfterHello = await requestJson(`/v1/kiosks/${encodeURIComponent(code)}/scolia/status`, {
    method: "GET",
    pairing: true,
  });
  assert.equal(statusAfterHello.ok, true);
  assert.equal(String(statusAfterHello.board.runtime_kiosk_id ?? statusAfterHello.board.id), fixture.kiosk);
  assert.equal(statusAfterHello.board.connection_state, "connected");
  assert.equal(statusAfterHello.board.reported_board_status, "Ready");
  assert.equal(statusAfterHello.board.physical_board_status, "Ready");
  assert.equal(statusAfterHello.board.board_phase, "Throw");
  assert.equal(statusAfterHello.board.bridge_heartbeat_fresh, true);
  assert.equal(statusAfterHello.board.buffer, null);
  if (statusAfterHello.board.physical_status_fresh === true) {
    assert.equal(statusAfterHello.board.board_status, "Ready");
    assert.equal(statusAfterHello.board.physical_available, true);
  } else {
    assert.equal(statusAfterHello.board.board_status, "Offline");
    assert.equal(statusAfterHello.board.physical_available, false);
  }

  const statusProbePoll = await requestJson("/v1/scolia/bridge/commands/poll", {
    method: "POST",
    body: { kiosk_ids: [fixture.kiosk], limit: 10 },
  });
  assert.equal(statusProbePoll.items.length, 1, "Kiosk status should queue one rate-limited physical status probe");
  assert.equal(statusProbePoll.items[0].command_type, "GET_SBC_STATUS");
  await requestJson(`/v1/scolia/bridge/commands/${statusProbePoll.items[0].id}/result`, {
    method: "POST",
    body: { result: "acked" },
  });

  await seedVisitBuffer();

  const corrected = await requestJson(`/v1/kiosks/${encodeURIComponent(code)}/scolia/correct-throw`, {
    method: "POST",
    pairing: true,
    body: { throw_index: 0, sector: "T20" },
  });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.buffer.darts[0].multiplier, "T");
  assert.equal(corrected.buffer.darts[0].value, 20);
  assert.equal(corrected.buffer.event_ids.length, 2);
  assert.equal(corrected.buffer.provider_event_ids.length, 2);
  assert.equal(corrected.command.command_type, "CORRECT_THROW");
  assert.match(corrected.command.message_id, /^[0-9a-f-]{36}$/i);

  const undoneBuffered = await requestJson(`/v1/kiosks/${encodeURIComponent(code)}/scolia/undo`, {
    method: "POST",
    pairing: true,
    body: {},
  });
  assert.equal(undoneBuffered.ok, true);
  assert.equal(undoneBuffered.action, "buffered_throw_removed");
  assert.equal(undoneBuffered.result.buffer.darts.length, 1);
  assert.equal(undoneBuffered.result.buffer.event_ids.length, 1);
  assert.equal(undoneBuffered.result.buffer.provider_event_ids.length, 1);
  assert.equal(undoneBuffered.result.command.command_type, "DELETE_THROW");

  const firstPoll = await requestJson("/v1/scolia/bridge/commands/poll", {
    method: "POST",
    body: { kiosk_ids: [fixture.kiosk], limit: 10 },
  });
  assert.equal(firstPoll.ok, true);
  assert.equal(firstPoll.items.length, 1, "FIFO must expose only the first outstanding command");
  assert.equal(firstPoll.items[0].command_type, "CORRECT_THROW");
  assert.match(String(firstPoll.items[0].message_id), /^[0-9a-f-]{36}$/i);

  await requestJson(`/v1/scolia/bridge/commands/${firstPoll.items[0].id}/result`, {
    method: "POST",
    body: { result: "acked" },
  });

  const secondPoll = await requestJson(`/v1/scolia/bridge/commands/${fixture.kiosk}`, { method: "GET" });
  assert.equal(secondPoll.items.length, 1);
  assert.equal(secondPoll.items[0].command_type, "DELETE_THROW");
  await requestJson(`/v1/scolia/bridge/commands/${secondPoll.items[0].id}/result`, {
    method: "POST",
    body: { result: "ack" },
  });

  const emptyPoll = await requestJson("/v1/scolia/bridge/commands/poll", {
    method: "POST",
    body: { kiosk_ids: [fixture.kiosk], limit: 10 },
  });
  assert.deepEqual(emptyPoll.items, []);

  const fallback = await requestJson(`/v1/kiosks/${encodeURIComponent(code)}/scolia/fallback`, {
    method: "POST",
    pairing: true,
    body: {},
  });
  assert.equal(Number(fallback.board.fallback_active), 1);
  assert.equal(Number(fallback.board.needs_reconciliation), 1);

  const resumeRejected = await requestJson(`/v1/kiosks/${encodeURIComponent(code)}/scolia/resume`, {
    method: "POST",
    pairing: true,
    body: { reconciled: false },
    expectedStatus: 409,
  });
  assert.equal(resumeRejected.error.code, "scolia_reconciliation_required");

  const resumed = await requestJson(`/v1/kiosks/${encodeURIComponent(code)}/scolia/resume`, {
    method: "POST",
    pairing: true,
    body: { reconciled: true },
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.command.command_type, "RESET_PHASE");
  assert.match(resumed.command.message_id, /^[0-9a-f-]{36}$/i);

  const resetPoll = await requestJson("/v1/scolia/bridge/commands/poll", {
    method: "POST",
    body: { kiosk_ids: [fixture.kiosk], limit: 10 },
  });
  assert.equal(resetPoll.items.length, 1);
  assert.equal(resetPoll.items[0].command_type, "RESET_PHASE");
  await requestJson(`/v1/scolia/bridge/commands/${resetPoll.items[0].id}/result`, {
    method: "POST",
    body: { result: "acked" },
  });

  const finalStatus = await requestJson(`/v1/kiosks/${encodeURIComponent(code)}/scolia`, {
    method: "GET",
    pairing: true,
  });
  assert.equal(Number(finalStatus.board.fallback_active), 0);
  assert.equal(Number(finalStatus.board.needs_reconciliation), 0);
  assert.equal(finalStatus.board.buffer, null, "Resume must clear unfinished visit buffer");

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-scolia-runtime-lifecycle",
    release_sha: config.releaseSha,
    runtime_prefix: config.prefixes.runtime,
    hardware_prefix: config.prefixes.hardware,
    event_enqueue_dedupe_verified: true,
    queue_drain_verified: true,
    pairing_runtime_verified: true,
    kiosk_status_fail_closed_verified: true,
    status_probe_verified: true,
    buffered_undo_verified: true,
    buffer_correction_verified: true,
    command_fifo_ack_verified: true,
    fallback_resume_verified: true,
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
      `INSERT INTO \`${config.prefixes.runtime}clubs\` (name,slug) VALUES (?,?)`,
      [`Scolia E2E ${suffix}`, `scolia-e2e-${suffix}`],
    );
    fixture.club = requireInsertId(club, "club");

    const playerA = await sql.execute(
      `INSERT INTO \`${config.prefixes.runtime}players\` (club_id,display_name,is_active) VALUES (?,?,1)`,
      [fixture.club, `Scolia E2E A ${suffix}`],
    );
    fixture.playerA = requireInsertId(playerA, "player A");
    const playerB = await sql.execute(
      `INSERT INTO \`${config.prefixes.runtime}players\` (club_id,display_name,is_active) VALUES (?,?,1)`,
      [fixture.club, `Scolia E2E B ${suffix}`],
    );
    fixture.playerB = requireInsertId(playerB, "player B");

    const kiosk = await sql.execute(
      `INSERT INTO \`${config.prefixes.runtime}kiosks\`
        (club_id,code,name,board_number,scoring_mode,pairing_token_hash,paired_device_name,paired_at,is_active)
       VALUES (?,?,?,9999,'scolia',?,?,NOW(),1)`,
      [fixture.club, code, `Scolia E2E Board ${suffix}`, pairingHash, `Scolia E2E Device ${suffix}`],
    );
    fixture.kiosk = requireInsertId(kiosk, "kiosk");

    await sql.execute(
      `INSERT INTO \`${config.prefixes.runtime}scolia_club_settings\`
        (club_id,enabled,access_token,force_connect,forward_messages_to_scolia,disconnect_fallback_enabled,queue_max_attempts,queue_retry_base_seconds,event_retention_days)
       VALUES (?,1,?,1,0,1,3,1,1)`,
      [fixture.club, `token-${suffix}`],
    );
    await sql.execute(
      `INSERT INTO \`${config.prefixes.runtime}scolia_board_settings\`
        (kiosk_id,serial_number,mode,auto_fallback_to_manual)
       VALUES (?,?,'live',1)`,
      [fixture.kiosk, serial],
    );

    const tournament = await sql.execute(
      `INSERT INTO \`${config.prefixes.runtime}tournaments\`
        (club_id,name,slug,provider_system,status)
       VALUES (?,?,?,'local','ready')`,
      [fixture.club, `Scolia E2E Tournament ${suffix}`, `scolia-e2e-t-${suffix}`],
    );
    fixture.tournament = requireInsertId(tournament, "tournament");
    const match = await sql.execute(
      `INSERT INTO \`${config.prefixes.runtime}matches\`
        (tournament_id,kiosk_id,status,best_of_legs,legs_to_win,player_a_id,player_b_id)
       VALUES (?,?,'pending',3,2,?,?)`,
      [fixture.tournament, fixture.kiosk, fixture.playerA, fixture.playerB],
    );
    fixture.match = requireInsertId(match, "match");
  });
}

async function seedVisitBuffer() {
  const dbProvider = makeProvider();
  try {
    await dbProvider.withConnection(async (sql) => {
      await sql.execute(
        `INSERT INTO \`${config.prefixes.runtime}scolia_visit_buffers\`
          (kiosk_id,match_id,player_id,darts_json,event_ids_json,provider_event_ids_json)
         VALUES (?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE match_id=VALUES(match_id),player_id=VALUES(player_id),darts_json=VALUES(darts_json),
           event_ids_json=VALUES(event_ids_json),provider_event_ids_json=VALUES(provider_event_ids_json),updated_at=NOW(3)`,
        [
          fixture.kiosk,
          fixture.match,
          fixture.playerA,
          JSON.stringify([{ multiplier: "S", value: 20 }, { multiplier: "D", value: 10 }]),
          JSON.stringify(["900001", "900002"]),
          JSON.stringify([`provider-a-${suffix}`, `provider-b-${suffix}`]),
        ],
      );
    });
  } finally {
    await dbProvider.close();
  }
}

async function cleanupFixture(dbProvider) {
  if (!fixture.club) return;
  try {
    await dbProvider.withConnection(async (sql) => {
      if (fixture.kiosk) {
        await sql.execute(`DELETE FROM \`${config.prefixes.runtime}scolia_visit_buffers\` WHERE kiosk_id=?`, [fixture.kiosk]);
        await sql.execute(`DELETE FROM \`${config.prefixes.runtime}scolia_commands\` WHERE kiosk_id=?`, [fixture.kiosk]);
        await sql.execute(`DELETE FROM \`${config.prefixes.runtime}scolia_events\` WHERE kiosk_id=?`, [fixture.kiosk]);
        await sql.execute(`DELETE FROM \`${config.prefixes.runtime}scolia_incidents\` WHERE kiosk_id=?`, [fixture.kiosk]);
        await sql.execute(`DELETE FROM \`${config.prefixes.runtime}scolia_board_runtime\` WHERE kiosk_id=?`, [fixture.kiosk]);
        await sql.execute(`DELETE FROM \`${config.prefixes.runtime}scolia_board_settings\` WHERE kiosk_id=?`, [fixture.kiosk]);
      }
      await sql.execute(`DELETE FROM \`${config.prefixes.runtime}scolia_club_settings\` WHERE club_id=?`, [fixture.club]);
      if (fixture.match) await sql.execute(`DELETE FROM \`${config.prefixes.runtime}matches\` WHERE id=?`, [fixture.match]);
      if (fixture.tournament) await sql.execute(`DELETE FROM \`${config.prefixes.runtime}tournaments\` WHERE id=?`, [fixture.tournament]);
      if (fixture.kiosk) await sql.execute(`DELETE FROM \`${config.prefixes.runtime}kiosks\` WHERE id=?`, [fixture.kiosk]);
      if (fixture.playerA) await sql.execute(`DELETE FROM \`${config.prefixes.runtime}players\` WHERE id=?`, [fixture.playerA]);
      if (fixture.playerB) await sql.execute(`DELETE FROM \`${config.prefixes.runtime}players\` WHERE id=?`, [fixture.playerB]);
      await sql.execute(`DELETE FROM \`${config.prefixes.runtime}clubs\` WHERE id=?`, [fixture.club]);
    });
  } catch (cleanupError) {
    console.error("backend-v2 Scolia E2E cleanup failed", cleanupError);
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

async function waitForHealth() {
  let lastError = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (server?.exitCode !== null) throw new Error(`backend-v2 exited before health. ${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        const health = await response.json();
        if (
          health.ok === true &&
          health.environment === "test" &&
          health.writes_armed === true &&
          health.runtime_prefix === "bd_test_" &&
          health.hardware_prefix === "bd_test_"
        ) return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`backend-v2 did not become healthy: ${String(lastError ?? "unknown")}`);
}

async function requestJson(path, {
  method,
  body = undefined,
  expectedStatus = 200,
  pairing = false,
  bridgeAuth = true,
}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(bridgeAuth ? { "x-bd-backend-v2-token": process.env.BD_BACKEND_V2_INTERNAL_TOKEN } : {}),
      ...(pairing ? { "x-kiosk-pairing-token": pairingToken } : {}),
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