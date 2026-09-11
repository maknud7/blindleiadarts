import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";
import { MySqlPlayerLiveReadRepository } from "../dist/mysql/player-live-read-repository.js";
import { loadRuntimeConfig } from "../dist/runtime/config.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test", "Player/live E2E may only run with BD_APP_ENV=test");
assert.equal(config.mode, "test-write", "Player/live E2E expects the deployed TEST runtime mode");
assert.equal(config.prefixes.runtime, "bd_test_", "Player/live E2E must read bd_test_ runtime data");
assert.equal(config.prefixes.identity, "bd_prod_", "Player/live E2E must preserve the shared PROD identity boundary");
assert.equal(config.prefixes.hardware, "bd_prod_", "Player/live E2E must preserve canonical PROD hardware scope");
assert.equal(config.mysql.budget.maxConcurrentConnections, 1, "Player/live E2E must use one backend connection");

const baseUrl = `http://127.0.0.1:${config.port}`;
let server = null;
let serverOutput = "";
let playerId = null;
let tournamentId = null;
let seasonId = null;
let seasonClubId = null;

const provider = makeProvider(false);
try {
  await provider.withConnection(async (sql) => {
    const players = await sql.query(
      `SELECT p.id
         FROM \`${config.prefixes.runtime}players\` p
        WHERE p.is_active=1
        ORDER BY (
          SELECT COUNT(*) FROM \`${config.prefixes.runtime}matches\` m
           WHERE m.player_a_id=p.id OR m.player_b_id=p.id
        ) DESC,p.id ASC
        LIMIT 1`,
    );
    playerId = String(players[0]?.id ?? "");
    assert.match(playerId, /^[1-9][0-9]*$/, "TEST runtime has no active player fixture");

    // Pick canonical historical data rather than the newest active tournament.
    // Other hosted E2Es create/delete active fixtures concurrently, so choosing
    // a completed tournament with completed matches keeps this read-only test
    // independent of those temporary lifecycle fixtures.
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

    const seasons = await sql.query(
      `SELECT s.id,s.club_id
         FROM \`${config.prefixes.runtime}seasons\` s
        WHERE EXISTS (
          SELECT 1 FROM \`${config.prefixes.runtime}tournaments\` t
           WHERE t.season_id=s.id
             AND EXISTS (
               SELECT 1 FROM \`${config.prefixes.runtime}matches\` m
                WHERE m.tournament_id=t.id AND m.status='completed'
             )
        )
        ORDER BY s.id ASC
        LIMIT 1`,
    );
    seasonId = String(seasons[0]?.id ?? "");
    seasonClubId = String(seasons[0]?.club_id ?? "");
    assert.match(seasonId, /^[1-9][0-9]*$/, "TEST runtime has no stable season fixture");
    assert.match(seasonClubId, /^[1-9][0-9]*$/, "Stable TEST season has no club id");
  });

  const reads = new MySqlPlayerLiveReadRepository(provider, config.prefixes.runtime);
  const dashboard = await reads.memberDashboard({
    id: "999999999999999999",
    email: "player-live-e2e@example.invalid",
    display_name: "Player Live E2E",
    role: "player",
    is_active: 1,
    account_status: "active",
    contact_phone: null,
    player_id: playerId,
    player_display_name: "Player Live E2E",
    player_club_id: null,
    member_id: null,
    admin_club_ids: "",
    global_roles: "",
  });
  assert.ok(dashboard && typeof dashboard === "object");
  assert.ok(Array.isArray(dashboard.registrations));
  assert.ok(dashboard.stats && typeof dashboard.stats === "object");

  // Never keep a discovery connection open alongside the server under the
  // single-connection hosted TEST budget.
  await provider.close();

  server = startServer();
  await waitForReady();

  const profile = await requestJson(`/v1/players/${playerId}/profile`);
  assert.equal(profile.ok, true);
  assert.equal(String(profile.player.id), playerId);
  assert.ok(Array.isArray(profile.player.alias_player_ids));
  assert.ok(profile.stats && typeof profile.stats === "object");
  assert.ok(Array.isArray(profile.recent_matches));
  assert.ok(Array.isArray(profile.elo_history));

  const elo = await requestJson(`/v1/players/${playerId}/elo-tournaments`);
  assert.equal(elo.ok, true);
  assert.equal(String(elo.player_id), playerId);
  assert.ok(Array.isArray(elo.alias_player_ids));
  assert.ok(Array.isArray(elo.items));

  const highlights = await requestJson(`/v1/tournaments/${tournamentId}/live-highlights`);
  assert.equal(highlights.ok, true);
  assert.equal(String(highlights.tournament.id), tournamentId);
  assert.ok(Array.isArray(highlights.standings));
  assert.ok(Array.isArray(highlights.top_visits));
  assert.ok(Array.isArray(highlights.top_checkouts));
  assert.ok(Array.isArray(highlights.top_three_dart_averages));

  const seasonList = await requestJson(`/v1/clubs/${seasonClubId}/seasons`);
  assert.equal(seasonList.ok, true);
  assert.equal(String(seasonList.club_id), seasonClubId);
  assert.ok(Array.isArray(seasonList.items));
  assert.ok(seasonList.items.some((season) => String(season.id) === seasonId));

  const season = await requestJson(`/v1/seasons/${seasonId}`);
  assert.equal(season.ok, true);
  assert.equal(String(season.season.id), seasonId);
  assert.equal(String(season.season.club_id), seasonClubId);

  const standings = await requestJson(`/v1/seasons/${seasonId}/standings`);
  assert.equal(standings.ok, true);
  assert.equal(String(standings.season.id), seasonId);
  assert.ok(Array.isArray(standings.items));
  assert.ok(standings.items.length > 0, "Stable TEST season should expose standings");
  assert.ok(standings.items.every((row, index) => Number(row.position) === index + 1));
  assert.ok(standings.items.every((row) => typeof row.points === "number" && typeof row.elo_rating === "number"));

  const unauthenticatedDashboard = await requestJson("/v1/me/dashboard", { expectedStatus: 401 });
  assert.equal(unauthenticatedDashboard.ok, false);
  assert.equal(unauthenticatedDashboard.error.code, "authentication_required");

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-player-live-read",
    release_sha: config.releaseSha,
    runtime_prefix: config.prefixes.runtime,
    identity_prefix: config.prefixes.identity,
    player_id: playerId,
    tournament_id: tournamentId,
    season_id: seasonId,
    season_club_id: seasonClubId,
    profile_verified: true,
    tournament_elo_verified: true,
    live_highlights_verified: true,
    season_reads_verified: true,
    dashboard_read_model_verified: true,
    shared_identity_write_not_required: true,
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
