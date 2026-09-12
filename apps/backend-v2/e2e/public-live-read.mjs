import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";
import { loadRuntimeConfig } from "../dist/runtime/config.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test", "Public-live E2E may only run with BD_APP_ENV=test");
assert.equal(config.mode, "test-write", "Public-live E2E expects the deployed TEST runtime mode");
assert.equal(config.prefixes.runtime, "bd_test_", "Public-live E2E must use bd_test_ runtime data");
assert.equal(config.prefixes.identity, "bd_prod_", "Public-live E2E must preserve the shared PROD identity boundary");
assert.equal(config.prefixes.hardware, "bd_prod_", "Public-live E2E must preserve canonical PROD hardware scope");
assert.equal(config.mysql.budget.maxConcurrentConnections, 1, "Public-live E2E must use one backend connection");

const baseUrl = `http://127.0.0.1:${config.port}`;
let server = null;
let serverOutput = "";
let fixture = null;
let before = null;

const discovery = makeProvider(false);
try {
  ({ fixture, state: before } = await discovery.withConnection(async (sql) => {
    const rows = await sql.query(
      `SELECT t.id AS tournament_id,t.club_id,c.slug AS club_slug
         FROM \`${config.prefixes.runtime}tournaments\` t
         INNER JOIN \`${config.prefixes.runtime}clubs\` c ON c.id=t.club_id
        WHERE t.status='completed'
          AND EXISTS (
            SELECT 1 FROM \`${config.prefixes.runtime}matches\` m
             WHERE m.tournament_id=t.id AND m.status='completed'
          )
        ORDER BY COALESCE(t.end_at,t.start_at) DESC,t.id DESC
        LIMIT 1`,
    );
    const row = rows[0];
    const tournamentId = String(row?.tournament_id ?? "");
    const clubId = String(row?.club_id ?? "");
    const clubSlug = String(row?.club_slug ?? "");
    assert.match(tournamentId, /^[1-9][0-9]*$/, "TEST runtime has no completed public-live fixture");
    assert.match(clubId, /^[1-9][0-9]*$/, "Public-live fixture has no club id");
    assert.notEqual(clubSlug, "", "Public-live fixture has no club slug");

    const screens = await sql.query(
      `SELECT sd.id,sd.access_token,sd.last_connected_at
         FROM \`${config.prefixes.hardware}screen_devices\` sd
         INNER JOIN \`${config.prefixes.hardware}clubs\` c ON c.id=sd.club_id
        WHERE c.slug=? AND sd.is_active=1
        ORDER BY sd.id ASC`,
      [clubSlug],
    );
    const screenToken = String(screens[0]?.access_token ?? "").trim() || null;

    return {
      fixture: { tournamentId, clubId, clubSlug, screenToken },
      state: await captureState(sql, tournamentId, clubId, clubSlug),
    };
  }));

  await discovery.close();

  server = startServer();
  await waitForReady();

  const tournamentLive = await requestJson(`/v1/public/tournaments/${fixture.tournamentId}/live`);
  assert.equal(tournamentLive.ok, true);
  assert.equal(String(tournamentLive.tournament?.id ?? ""), fixture.tournamentId);
  assert.equal(String(tournamentLive.club?.id ?? ""), fixture.clubId);
  assert.ok(tournamentLive.progress && typeof tournamentLive.progress === "object");
  assert.ok(Array.isArray(tournamentLive.boards));
  assert.ok(Array.isArray(tournamentLive.next_matches));
  assert.ok(Array.isArray(tournamentLive.recent_results));
  assert.ok(Array.isArray(tournamentLive.elo));
  assert.ok(tournamentLive.highlights && typeof tournamentLive.highlights === "object");

  const clubLive = await requestJson(`/v1/public/clubs/${encodeURIComponent(fixture.clubSlug)}/live`);
  assert.equal(clubLive.ok, true);
  assert.equal(String(clubLive.club?.id ?? ""), fixture.clubId);

  const checkinByClub = await requestJson(
    `/v1/public/check-in-display?club_slug=${encodeURIComponent(fixture.clubSlug)}`,
  );
  assert.equal(checkinByClub.ok, true);
  assert.equal(typeof checkinByClub.active, "boolean");
  assert.ok(checkinByClub.checkin === null || typeof checkinByClub.checkin === "object");

  let screenTokenVerified = false;
  if (fixture.screenToken !== null) {
    const checkinByScreen = await requestJson(
      `/v1/public/check-in-display?screen_token=${encodeURIComponent(fixture.screenToken)}`,
    );
    assert.equal(checkinByScreen.ok, true);
    assert.equal(typeof checkinByScreen.active, "boolean");
    screenTokenVerified = true;
  }

  await stopServer();
  server = null;

  const verification = makeProvider(false);
  try {
    const after = await verification.withConnection((sql) => captureState(
      sql,
      fixture.tournamentId,
      fixture.clubId,
      fixture.clubSlug,
    ));
    assert.deepEqual(
      after.eloSnapshots,
      before.eloSnapshots,
      "Public live GET must not capture, repair or otherwise mutate tournament ELO snapshots",
    );
    assert.deepEqual(
      after.checkinSettings,
      before.checkinSettings,
      "Public check-in display GET must not rotate or persist check-in codes/settings",
    );
    assert.deepEqual(
      after.screenHeartbeats,
      before.screenHeartbeats,
      "Public check-in display GET must not touch canonical hardware screen last_connected_at",
    );
  } finally {
    await verification.close().catch(() => undefined);
  }

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-public-live-read-purity",
    release_sha: config.releaseSha,
    runtime_prefix: config.prefixes.runtime,
    hardware_prefix: config.prefixes.hardware,
    tournament_id: fixture.tournamentId,
    club_id: fixture.clubId,
    club_slug: fixture.clubSlug,
    tournament_live_verified: true,
    club_live_verified: true,
    checkin_display_verified: true,
    screen_token_verified: screenTokenVerified,
    elo_snapshot_write_free: true,
    checkin_code_write_free: true,
    screen_heartbeat_write_free: true,
  }));
} catch (error) {
  if (serverOutput) process.stderr.write(`\n--- backend-v2 server output ---\n${serverOutput}\n`);
  throw error;
} finally {
  await stopServer().catch(() => undefined);
  await discovery.close().catch(() => undefined);
}

async function captureState(sql, tournamentId, clubId, clubSlug) {
  const eloSnapshots = await sql.query(
    `SELECT player_id,elo_before,elo_after,matches_before,matches_after,
            rank_before,rank_after,rank_baseline_kind,captured_start_at,captured_end_at
       FROM \`${config.prefixes.runtime}tournament_elo_snapshots\`
      WHERE tournament_id=?
      ORDER BY player_id ASC`,
    [tournamentId],
  );
  const checkinSettings = await sql.query(
    `SELECT id,checkin_code,checkin_method,checkin_opens_at,checkin_closes_at
       FROM \`${config.prefixes.runtime}tournaments\`
      WHERE club_id=?
      ORDER BY id ASC`,
    [clubId],
  );
  const screenHeartbeats = await sql.query(
    `SELECT sd.id,sd.access_token,sd.last_connected_at
       FROM \`${config.prefixes.hardware}screen_devices\` sd
       INNER JOIN \`${config.prefixes.hardware}clubs\` c ON c.id=sd.club_id
      WHERE c.slug=?
      ORDER BY sd.id ASC`,
    [clubSlug],
  );
  return {
    eloSnapshots: normalizeRows(eloSnapshots),
    checkinSettings: normalizeRows(checkinSettings),
    screenHeartbeats: normalizeRows(screenHeartbeats),
  };
}

function normalizeRows(rows) {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]),
  ));
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
  child.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  child.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
  return child;
}

async function stopServer() {
  if (!server) return;
  if (server.exitCode === null) server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
}

async function waitForReady() {
  let lastError = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server?.exitCode !== null) throw new Error(`backend-v2 exited before readiness. ${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        const health = await response.json();
        if (
          health.ok === true
          && health.environment === "test"
          && health.runtime_prefix === "bd_test_"
          && health.identity_prefix === "bd_prod_"
          && health.hardware_prefix === "bd_prod_"
          && health.max_connections === 1
          && health.connection_mode === "idle-reuse"
        ) return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`backend-v2 did not become ready: ${String(lastError ?? "unknown")}`);
}

async function requestJson(path, { expectedStatus = 200 } = {}) {
  const response = await fetch(`${baseUrl}${path}`, { method: "GET" });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`GET ${path} returned non-JSON ${response.status}: ${text}`);
  }
  assert.equal(response.status, expectedStatus, `GET ${path}: ${text}`);
  return payload;
}
