import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";
import { loadRuntimeConfig } from "../dist/runtime/config.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test", "Tournament public read E2E may only run with BD_APP_ENV=test");
assert.equal(config.mode, "test-write", "Tournament public read E2E expects TEST runtime mode");
assert.equal(config.prefixes.runtime, "bd_test_", "Tournament public read E2E must read bd_test_ runtime data");
assert.equal(config.prefixes.identity, "bd_prod_", "Tournament public read E2E must preserve shared PROD identity scope");
assert.equal(config.prefixes.hardware, "bd_prod_", "Tournament public read E2E must preserve canonical PROD hardware scope");
assert.equal(config.mysql.budget.maxConcurrentConnections, 1, "Tournament public read E2E must use one backend connection");

const baseUrl = `http://127.0.0.1:${config.port}`;
let server = null;
let serverOutput = "";
let tournamentId = null;
let matchId = null;
let summaryTournamentId = null;
let summaryClubId = null;

const provider = new MySql2SessionProvider({
  host: config.mysql.host,
  port: config.mysql.port,
  database: config.mysql.database,
  username: config.mysql.username,
  password: config.mysql.password,
  connectTimeoutMs: config.mysql.connectTimeoutMs,
  budget: config.mysql.budget,
  writable: false,
  connectionReuse: "idle-reuse",
  idleConnectionTimeoutMs: config.mysql.idleConnectionTimeoutMs,
});

try {
  await provider.withConnection(async (sql) => {
    const tournaments = await sql.query(
      `SELECT t.id
         FROM \`${config.prefixes.runtime}tournaments\` t
        WHERE t.status='completed'
          AND EXISTS (
            SELECT 1 FROM \`${config.prefixes.runtime}matches\` m
             WHERE m.tournament_id=t.id AND m.status='completed'
          )
          AND EXISTS (
            SELECT 1 FROM \`${config.prefixes.runtime}tournament_players\` tp
             WHERE tp.tournament_id=t.id AND tp.status NOT IN ('withdrawn','no_show')
          )
        ORDER BY t.id ASC
        LIMIT 1`,
    );
    tournamentId = String(tournaments[0]?.id ?? "");
    assert.match(tournamentId, /^[1-9][0-9]*$/, "TEST runtime has no stable completed tournament fixture");

    const matches = await sql.query(
      `SELECT id FROM \`${config.prefixes.runtime}matches\`
        WHERE tournament_id=? AND status='completed'
        ORDER BY id ASC LIMIT 1`,
      [tournamentId],
    );
    matchId = String(matches[0]?.id ?? "");
    assert.match(matchId, /^[1-9][0-9]*$/, "Completed TEST tournament has no completed match fixture");

    const summaries = await sql.query(
      `SELECT s.tournament_id,t.club_id
         FROM \`${config.prefixes.runtime}tournament_summaries\` s
         INNER JOIN \`${config.prefixes.runtime}tournaments\` t ON t.id=s.tournament_id
        WHERE s.status='published'
        ORDER BY s.id ASC LIMIT 1`,
    );
    summaryTournamentId = String(summaries[0]?.tournament_id ?? "");
    summaryClubId = String(summaries[0]?.club_id ?? "");
    assert.match(summaryTournamentId, /^[1-9][0-9]*$/, "TEST runtime has no published tournament summary fixture");
    assert.match(summaryClubId, /^[1-9][0-9]*$/, "Published TEST summary has no club fixture");
  });

  // Release the discovery connection before the HTTP server starts so the
  // hosted TEST environment never exceeds its single-connection budget.
  await provider.close();

  server = startServer();
  await waitForReady();

  const tables = await requestJson(`/v1/tournaments/${tournamentId}/tables`);
  assert.equal(tables.ok, true);
  assert.equal(String(tables.tournament.id), tournamentId);
  assert.ok(Array.isArray(tables.groups));
  assert.ok(tables.groups.length > 0, "Stable tournament should expose at least one table group");
  assert.deepEqual(tables.tie_break_order, ["leg_difference", "head_to_head", "three_dart_average"]);
  assert.ok(tables.groups.every((group) => Array.isArray(group.rows)));

  const results = await requestJson(`/v1/tournaments/${tournamentId}/results`);
  assert.equal(results.ok, true);
  assert.equal(String(results.tournament.id), tournamentId);
  assert.ok(Array.isArray(results.items));
  assert.ok(results.items.length > 0, "Stable tournament should expose completed results");
  assert.ok(results.items.some((item) => String(item.id) === matchId));

  const detail = await requestJson(`/v1/matches/${matchId}/detail`);
  assert.equal(detail.ok, true);
  assert.equal(String(detail.match.id), matchId);
  assert.equal(String(detail.match.tournament_id), tournamentId);
  assert.ok(Array.isArray(detail.legs));
  assert.ok(Array.isArray(detail.visits));

  const summaries = await requestJson(`/v1/clubs/${summaryClubId}/summaries`);
  assert.equal(summaries.ok, true);
  assert.equal(String(summaries.club_id), summaryClubId);
  assert.ok(Array.isArray(summaries.items));
  assert.ok(summaries.items.some((item) => String(item.tournament_id) === summaryTournamentId));

  const summary = await requestJson(`/v1/tournaments/${summaryTournamentId}/summary`);
  assert.equal(summary.ok, true);
  assert.equal(String(summary.summary.tournament_id), summaryTournamentId);
  assert.equal(String(summary.summary.club_id), summaryClubId);
  assert.equal(summary.summary.status, "published");

  const missingDetail = await requestJson("/v1/matches/999999999999999999/detail", { expectedStatus: 404 });
  assert.equal(missingDetail.ok, false);
  assert.equal(missingDetail.error.code, "match_not_found");

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-tournament-public-read",
    release_sha: config.releaseSha,
    runtime_prefix: config.prefixes.runtime,
    tournament_id: tournamentId,
    match_id: matchId,
    summary_tournament_id: summaryTournamentId,
    summary_club_id: summaryClubId,
    tables_verified: true,
    results_verified: true,
    match_detail_verified: true,
    published_summaries_verified: true,
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
  await provider.close().catch(() => undefined);
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
          health.runtime_prefix === "bd_test_" &&
          health.identity_prefix === "bd_prod_" &&
          health.hardware_prefix === "bd_prod_" &&
          health.max_connections === 1 &&
          health.connection_mode === "idle-reuse"
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
