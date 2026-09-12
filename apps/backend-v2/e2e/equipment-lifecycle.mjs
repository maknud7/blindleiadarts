import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { loadRuntimeConfig } from "../dist/runtime/config.js";
import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test", "Equipment E2E may only run with BD_APP_ENV=test");
assert.equal(config.mode, "test-write", "Equipment E2E requires guarded test-write mode");
assert.equal(config.prefixes.runtime, "bd_test_", "Equipment E2E may only mutate bd_test_ runtime tables");
assert.equal(config.prefixes.identity, "bd_test_", "Equipment E2E may only mutate bd_test_ identities");
assert.equal(config.prefixes.hardware, "bd_prod_", "Equipment E2E must read canonical bd_prod_ hardware");
assert.equal(config.mysql.budget.maxConcurrentConnections, 1, "Equipment E2E must use one connection per runtime");

const suffix = randomBytes(6).toString("hex");
const bearer = `equipment-e2e-${randomBytes(24).toString("hex")}`;
const bearerHash = createHash("sha256").update(bearer).digest("hex");
const pairingToken = `equipment-pair-${randomBytes(24).toString("hex")}`;
const fixture = { club: null, user: null, session: null, pairingRequest: null };
const baseUrl = `http://127.0.0.1:${config.port}`;
let server = null;
let serverOutput = "";

const provider = makeProvider();
try {
  await createFixture(provider);
  // Do not keep a second idle DB connection while backend-v2 is under test.
  await provider.close();

  server = startServer();
  await waitForReady();

  const kiosks = await requestJson(`/v1/clubs/${fixture.club}/kiosks`, { method: "GET" });
  assert.equal(kiosks.ok, true);
  assert.ok(Array.isArray(kiosks.items));
  assert.ok(kiosks.items.length > 0, "Shared TEST/PROD club must expose at least one canonical physical board");
  assert.ok(kiosks.items.every((board) => typeof board.id === "string"));
  assert.ok(kiosks.items.every((board) => board.configuration_table_prefix === "bd_prod_"));
  assert.ok(kiosks.items.every((board) => board.runtime_table_prefix === "bd_test_"));

  const physicalBoard = kiosks.items[0];
  assert.match(physicalBoard.id, /^[1-9][0-9]*$/);

  const dashboard = await requestJson(`/v1/clubs/${fixture.club}/scolia`, { method: "GET", auth: true });
  assert.equal(dashboard.ok, true);
  assert.equal(dashboard.configuration_table_prefix, "bd_prod_");
  assert.equal(dashboard.runtime_table_prefix, "bd_test_");
  assert.ok(Array.isArray(dashboard.boards));

  const board = await requestJson(`/v1/clubs/${fixture.club}/kiosks/${physicalBoard.id}/scolia`, {
    method: "GET",
    auth: true,
  });
  assert.equal(board.ok, true);
  assert.equal(String(board.board.physical_kiosk_id), physicalBoard.id);
  assert.equal(board.board.configuration_table_prefix, "bd_prod_");
  assert.equal(board.board.runtime_table_prefix, "bd_test_");
  assert.equal(board.board.can_change_bridge, false, "TEST must expose canonical Scolia ownership as read-only");

  const blockedBoardWrite = await requestJson(`/v1/clubs/${fixture.club}/kiosks/${physicalBoard.id}`, {
    method: "PATCH",
    auth: true,
    body: { name: "MUST NOT WRITE FROM TEST" },
    expectedStatus: 403,
  });
  assert.equal(blockedBoardWrite.error.code, "production_hardware_read_only");

  const blockedScoliaWrite = await requestJson(`/v1/clubs/${fixture.club}/kiosks/${physicalBoard.id}/scolia`, {
    method: "PATCH",
    auth: true,
    body: { mode: "off" },
    expectedStatus: 403,
  });
  assert.equal(blockedScoliaWrite.error.code, "production_hardware_read_only");

  const blockedBridgeRelease = await requestJson(`/v1/clubs/${fixture.club}/kiosks/${physicalBoard.id}/scolia`, {
    method: "PATCH",
    auth: true,
    body: { bridge_attached: false },
    expectedStatus: 403,
  });
  assert.equal(blockedBridgeRelease.error.code, "production_hardware_read_only");

  const blockedBoardDelete = await requestJson(`/v1/clubs/${fixture.club}/kiosks/${physicalBoard.id}`, {
    method: "DELETE",
    auth: true,
    expectedStatus: 403,
  });
  assert.equal(blockedBoardDelete.error.code, "production_hardware_read_only");

  const pairing = await requestJson("/v1/kiosk-pairing-requests", {
    method: "POST",
    body: { club_id: fixture.club, device_name: `Equipment E2E ${suffix}` },
    pairing: true,
    expectedStatus: 201,
  });
  assert.equal(pairing.ok, true);
  assert.match(String(pairing.request.id), /^[1-9][0-9]*$/);
  assert.match(String(pairing.request.request_code), /^[A-Z0-9]{6}$/);
  fixture.pairingRequest = String(pairing.request.id);

  const pairingStatus = await requestJson(`/v1/kiosk-pairing-requests/${pairing.request.request_code}`, {
    method: "GET",
    pairing: true,
  });
  assert.equal(pairingStatus.ok, true);
  assert.equal(pairingStatus.status, "pending");
  assert.equal(String(pairingStatus.request.id), fixture.pairingRequest);

  const pending = await requestJson(`/v1/clubs/${fixture.club}/kiosk-pairing-requests`, {
    method: "GET",
    auth: true,
  });
  assert.equal(pending.ok, true);
  assert.ok(pending.items.some((item) => String(item.id) === fixture.pairingRequest));
  assert.ok(pending.items.every((item) => String(item.club_id) === fixture.club));

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-equipment-lifecycle",
    release_sha: config.releaseSha,
    runtime_prefix: config.prefixes.runtime,
    hardware_prefix: config.prefixes.hardware,
    canonical_board_count: kiosks.items.length,
    hardware_write_guard_verified: true,
    scolia_release_guard_verified: true,
    board_delete_guard_verified: true,
    pairing_request_verified: true,
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
    const shared = await sql.query(
      `SELECT t.id AS test_club_id
         FROM \`${config.prefixes.runtime}clubs\` t
         INNER JOIN \`${config.prefixes.hardware}clubs\` p ON p.slug=t.slug
        WHERE EXISTS (
          SELECT 1 FROM \`${config.prefixes.hardware}kiosks\` k
           WHERE k.club_id=p.id AND k.is_active=1
        )
        ORDER BY t.id LIMIT 1`,
    );
    const clubId = String(shared[0]?.test_club_id ?? "");
    assert.match(clubId, /^[1-9][0-9]*$/, "No TEST club maps to a PROD club with active physical boards");
    fixture.club = clubId;

    const username = `equipment-e2e-${suffix}`;
    const user = await sql.execute(
      `INSERT INTO \`${config.prefixes.runtime}user_accounts\`
        (username,email,password_hash,display_name,role,is_active,account_status)
       VALUES (?,?,NULL,?,'player',1,'active')`,
      [username, `${username}@example.invalid`, `Equipment E2E ${suffix}`],
    );
    fixture.user = requireInsertId(user, "user");
    await sql.execute(
      `INSERT INTO \`${config.prefixes.runtime}global_user_roles\` (user_account_id,role) VALUES (?,'super_admin')`,
      [fixture.user],
    );
    const session = await sql.execute(
      `INSERT INTO \`${config.prefixes.runtime}auth_sessions\`
        (user_account_id,session_token_hash,expires_at,last_used_at)
       VALUES (?,?,DATE_ADD(NOW(),INTERVAL 1 DAY),NOW())`,
      [fixture.user, bearerHash],
    );
    fixture.session = requireInsertId(session, "session");
  });
}

async function cleanupFixture(dbProvider) {
  try {
    await dbProvider.withConnection(async (sql) => {
      if (fixture.pairingRequest) {
        await sql.execute(
          `DELETE FROM \`${config.prefixes.runtime}kiosk_pairing_requests\` WHERE id=?`,
          [fixture.pairingRequest],
        );
      }
      if (fixture.session) {
        await sql.execute(`DELETE FROM \`${config.prefixes.runtime}auth_sessions\` WHERE id=?`, [fixture.session]);
      }
      if (fixture.user) {
        await sql.execute(`DELETE FROM \`${config.prefixes.runtime}global_user_roles\` WHERE user_account_id=?`, [fixture.user]);
        await sql.execute(`DELETE FROM \`${config.prefixes.runtime}club_user_roles\` WHERE user_account_id=?`, [fixture.user]);
        await sql.execute(`DELETE FROM \`${config.prefixes.runtime}user_accounts\` WHERE id=?`, [fixture.user]);
      }
    });
  } catch (cleanupError) {
    console.error("backend-v2 equipment E2E cleanup failed", cleanupError);
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
          health.hardware_prefix === "bd_prod_"
        ) return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`backend-v2 did not become ready: ${String(lastError ?? "unknown")}`);
}

async function requestJson(path, {
  method,
  body = undefined,
  expectedStatus = 200,
  auth = false,
  pairing = false,
}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${bearer}` } : {}),
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
