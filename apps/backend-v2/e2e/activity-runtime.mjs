import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";
import { loadRuntimeConfig } from "../dist/runtime/config.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test", "Activity E2E may only run with BD_APP_ENV=test");
assert.equal(config.mode, "test-write", "Activity E2E expects TEST write mode");
assert.equal(config.prefixes.runtime, "bd_test_", "Activity E2E must write only bd_test_ runtime data");
assert.equal(config.prefixes.identity, "bd_prod_", "Activity E2E must preserve shared PROD identity reads");
assert.equal(config.prefixes.hardware, "bd_prod_", "Activity E2E must preserve canonical PROD hardware scope");
assert.equal(config.mysql.budget.maxConcurrentConnections, 1, "Activity E2E must use one backend connection");

const marker = `activity_e2e_${Date.now()}_${process.pid}`;
const markerPath = `/activity-e2e/${marker}`;
const baseUrl = `http://127.0.0.1:${config.port}`;
let server = null;
let serverOutput = "";
let provider = null;

try {
  server = startServer();
  await waitForHealth();

  const response = await fetch(`${baseUrl}/v1/activity`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      surface: "activity_e2e",
      event_name: marker,
      path: markerPath,
      metadata: {
        source: "backend_v2_activity_e2e",
        password: "must-not-be-persisted",
      },
    }),
  });
  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`Activity POST returned non-JSON ${response.status}: ${raw}`);
  }
  assert.equal(response.status, 201, `Activity POST failed: ${raw}`);
  assert.equal(payload.ok, true);
  assert.equal(payload.recorded, 1);

  // The server owns the single allowed backend connection. Stop it before
  // opening a direct verification connection against hosted TEST MySQL.
  await stopServer();

  provider = makeProvider(true);
  await provider.withConnection(async (db) => {
    const rows = await db.query(
      `SELECT id,user_account_id,auth_session_id,club_id,tournament_id,surface,event_name,path,metadata_json
         FROM \`${config.prefixes.runtime}activity_events\`
        WHERE event_name=? AND path=?
        ORDER BY id DESC LIMIT 1`,
      [marker, markerPath],
    );
    const row = rows[0];
    assert.ok(row, "Anonymous backend-v2 activity row was not persisted in TEST runtime");
    assert.equal(row.user_account_id, null, "Anonymous telemetry must not acquire a PROD user id");
    assert.equal(row.auth_session_id, null, "Anonymous telemetry must not acquire a PROD auth session id");
    assert.equal(row.club_id, null);
    assert.equal(row.tournament_id, null);
    assert.equal(row.surface, "activity_e2e");
    assert.equal(row.event_name, marker);
    assert.equal(row.path, markerPath);

    const metadata = JSON.parse(String(row.metadata_json ?? "{}"));
    assert.equal(metadata.source, "backend_v2_activity_e2e");
    assert.equal(Object.prototype.hasOwnProperty.call(metadata, "password"), false, "Activity metadata allowlist leaked a secret-like field");

    await db.execute(
      `DELETE FROM \`${config.prefixes.runtime}activity_events\` WHERE event_name=? AND path=?`,
      [marker, markerPath],
    );
  });

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-activity-runtime",
    release_sha: config.releaseSha,
    runtime_prefix: config.prefixes.runtime,
    identity_prefix: config.prefixes.identity,
    anonymous_runtime_write_verified: true,
    prod_identity_write_not_required: true,
    metadata_allowlist_verified: true,
    cleanup_verified: true,
  }));
} catch (error) {
  if (serverOutput) process.stderr.write(`\n--- backend-v2 server output ---\n${serverOutput}\n`);
  throw error;
} finally {
  await stopServer();
  if (provider !== null) {
    try {
      await provider.withConnection(async (db) => {
        await db.execute(
          `DELETE FROM \`${config.prefixes.runtime}activity_events\` WHERE event_name=? AND path=?`,
          [marker, markerPath],
        );
      });
    } catch (cleanupError) {
      console.warn(`Activity E2E cleanup warning: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
    await provider.close().catch(() => undefined);
  }
}

function makeProvider(writable) {
  return new MySql2SessionProvider({
    host: config.mysql.host,
    port: config.mysql.port,
    database: config.mysql.database,
    username: config.mysql.username,
    password: config.mysql.password,
    connectTimeoutMs: config.mysql.connectTimeoutMs,
    budget: config.mysql.budget,
    writable,
    connectionReuse: "idle-reuse",
    idleConnectionTimeoutMs: config.mysql.idleConnectionTimeoutMs,
  });
}

function startServer() {
  const child = spawn(process.execPath, ["apps/backend-v2/dist/server.js"], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(config.port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk) => {
    serverOutput += chunk.toString("utf8");
    if (serverOutput.length > 24_000) serverOutput = serverOutput.slice(-24_000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return child;
}

async function waitForHealth() {
  const deadline = Date.now() + 20_000;
  let lastError = "not started";
  while (Date.now() < deadline) {
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
          health.identity_prefix === "bd_prod_" &&
          health.max_connections === 1 &&
          health.connection_mode === "idle-reuse"
        ) return;
        lastError = JSON.stringify(health);
      } else {
        lastError = `${response.status} ${await response.text()}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`backend-v2 did not become healthy: ${lastError}`);
}

async function stopServer() {
  if (server === null) return;
  const child = server;
  server = null;
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
