import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

import { loadRuntimeConfig } from "../dist/runtime/config.js";
import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test", "Kiosk unpair E2E may only run with BD_APP_ENV=test");
assert.equal(config.mode, "test-write", "Kiosk unpair E2E requires guarded test-write mode");
assert.equal(config.prefixes.runtime, "bd_test_", "Kiosk unpair E2E may only mutate bd_test_ runtime tables");
assert.equal(config.prefixes.identity, "bd_test_", "Isolated kiosk unpair E2E may only use bd_test_ identity fixtures");
assert.equal(config.prefixes.hardware, "bd_test_", "Isolated kiosk unpair E2E must never write bd_prod_ hardware");
assert.equal(config.mysql.budget.maxConcurrentConnections, 1, "Kiosk unpair E2E must use one backend connection");

const prefix = config.prefixes.runtime;
const suffix = randomBytes(6).toString("hex");
const pairingToken = `unpair-${randomBytes(24).toString("hex")}`;
const wrongToken = `wrong-${randomBytes(24).toString("hex")}`;
const pairingHash = await bcrypt.hash(pairingToken, 10);
const code = `kiosk-unpair-${suffix}`;
const fixture = { club: null, kiosk: null };
const baseUrl = `http://127.0.0.1:${config.port}`;
let server = null;
let serverOutput = "";

const provider = makeProvider();
try {
  await provider.withConnection(async (sql) => {
    const club = await sql.execute(
      `INSERT INTO \`${prefix}clubs\` (name,slug) VALUES (?,?)`,
      [`Kiosk Unpair E2E ${suffix}`, `kiosk-unpair-e2e-${suffix}`],
    );
    fixture.club = requireInsertId(club, "club");
    const kiosk = await sql.execute(
      `INSERT INTO \`${prefix}kiosks\`
        (club_id,code,name,board_number,scoring_mode,pairing_token_hash,paired_device_name,paired_at,is_active)
       VALUES (?,?,?,9998,'manual',?,?,NOW(),1)`,
      [fixture.club, code, `Kiosk Unpair E2E ${suffix}`, pairingHash, `E2E device ${suffix}`],
    );
    fixture.kiosk = requireInsertId(kiosk, "kiosk");
  });
  await provider.close();

  server = startServer();
  await waitForReady();

  const missing = await requestJson(`/v1/kiosks/${encodeURIComponent(code)}/unpair`, {
    method: "POST",
    expectedStatus: 403,
  });
  assert.equal(missing.error.code, "kiosk_pairing_required");

  const wrong = await requestJson(`/v1/kiosks/${encodeURIComponent(code)}/unpair`, {
    method: "POST",
    pairingToken: wrongToken,
    expectedStatus: 409,
  });
  assert.equal(wrong.error.code, "kiosk_paired_to_other_device");

  const unpaired = await requestJson(`/v1/kiosks/${encodeURIComponent(code)}/unpair`, {
    method: "POST",
    pairingToken,
  });
  assert.equal(unpaired.ok, true);
  assert.equal(String(unpaired.kiosk.id), fixture.kiosk);
  assert.equal(unpaired.kiosk.is_paired, false);
  assert.equal(unpaired.kiosk.paired_device_name, null);
  assert.equal(unpaired.kiosk.paired_at, null);
  assert.equal(unpaired.state, "idle");

  const stateWithoutToken = await requestJson(`/v1/kiosks/${encodeURIComponent(code)}/state`);
  assert.equal(stateWithoutToken.ok, true);
  assert.equal(stateWithoutToken.kiosk.is_paired, false);
  assert.equal(String(stateWithoutToken.kiosk.id), fixture.kiosk);

  const row = await makeProvider().withConnection(async (sql) => {
    const rows = await sql.query(
      `SELECT pairing_token_hash,paired_device_name,paired_at FROM \`${prefix}kiosks\` WHERE id=?`,
      [fixture.kiosk],
    );
    return rows[0];
  });
  assert.equal(row.pairing_token_hash, null);
  assert.equal(row.paired_device_name, null);
  assert.equal(row.paired_at, null);

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-kiosk-unpair-lifecycle",
    release_sha: config.releaseSha,
    runtime_prefix: prefix,
    max_connections: config.mysql.budget.maxConcurrentConnections,
    auth_fail_closed_verified: true,
    runtime_only_unpair_verified: true,
    post_unpair_state_verified: true,
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
  const cleanup = makeProvider();
  try {
    if (fixture.kiosk) await cleanup.withConnection((sql) => sql.execute(`DELETE FROM \`${prefix}kiosks\` WHERE id=?`, [fixture.kiosk]));
    if (fixture.club) await cleanup.withConnection((sql) => sql.execute(`DELETE FROM \`${prefix}clubs\` WHERE id=?`, [fixture.club]));
  } finally {
    await cleanup.close();
  }
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

async function requestJson(path, { method = "GET", body, pairingToken: token, expectedStatus = 200 } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["x-kiosk-pairing-token"] = token;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const json = await response.json();
  assert.equal(response.status, expectedStatus, `${method} ${path} returned ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

function requireInsertId(result, name) {
  assert.ok(result.insertId, `${name} insert did not return an id`);
  return String(result.insertId);
}
