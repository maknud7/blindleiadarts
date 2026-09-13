import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import { loadRuntimeConfig } from "../dist/runtime/config.js";
import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test", "Tournament catalog E2E may only run with BD_APP_ENV=test");
assert.equal(config.mode, "test-write", "Tournament catalog E2E requires guarded test-write mode");
assert.equal(config.prefixes.runtime, "bd_test_", "Tournament catalog E2E may only mutate bd_test_ runtime tables");
assert.equal(config.mysql.budget.maxConcurrentConnections, 1, "Tournament catalog E2E must use one MySQL connection");

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
const fixture = { club: null, tournament: null, players: [], match: null };
const baseUrl = `http://127.0.0.1:${config.port}`;
let server = null;
let serverOutput = "";

try {
  await createFixture();
  server = startServer();
  await waitForReady();

  const list = await getJson(`/v1/clubs/${fixture.club}/tournaments`);
  assert.equal(list.ok, true);
  assert.equal(String(list.club_id), fixture.club);
  const listed = list.items.find((item) => String(item.id) === fixture.tournament);
  assert.ok(listed, "Disposable TEST tournament missing from catalog list");
  assert.equal(typeof listed.id, "string");
  assert.equal(String(listed.club_id), fixture.club);
  assert.equal(listed.provider_system, "local");
  assert.equal(listed.registration_count, 2);
  assert.equal(listed.match_count, 1);
  assert.equal(listed.completed_match_count, 0);

  const detail = await getJson(`/v1/tournaments/${fixture.tournament}`);
  assert.equal(detail.ok, true);
  assert.equal(String(detail.tournament.id), fixture.tournament);
  assert.equal(detail.tournament.club_name, `Catalog E2E ${suffix}`);
  assert.equal(detail.tournament.registrations.length, 2);
  assert.ok(detail.tournament.registrations.every((registration) => typeof registration.id === "string"));
  assert.equal(detail.tournament.matches.length, 1);
  assert.equal(String(detail.tournament.matches[0].id), fixture.match);

  const matches = await getJson(`/v1/tournaments/${fixture.tournament}/matches`);
  assert.equal(matches.ok, true);
  assert.equal(String(matches.tournament_id), fixture.tournament);
  assert.equal(matches.items.length, 1);
  assert.equal(String(matches.items[0].id), fixture.match);
  assert.equal(matches.items[0].status, "pending");
  assert.equal(matches.items[0].best_of_legs, 3);
  assert.equal(matches.items[0].legs_to_win, 2);

  const missing = await requestJson("/v1/tournaments/9223372036854775807", { method: "GET", expectedStatus: 404 });
  assert.equal(missing.error.code, "tournament_not_found");

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-tournament-catalog-read",
    release_sha: config.releaseSha,
    runtime_prefix: prefix,
    tournament_id: fixture.tournament,
    exact_decimal_ids: true,
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
      `INSERT INTO \`${prefix}clubs\` (name,slug) VALUES (?,?)`,
      [`Catalog E2E ${suffix}`, `catalog-e2e-${suffix}`],
    );
    fixture.club = requireInsertId(club, "club");

    for (let index = 0; index < 2; index += 1) {
      const player = await sql.execute(
        `INSERT INTO \`${prefix}players\` (club_id,display_name,nickname) VALUES (?,?,?)`,
        [fixture.club, `Catalog Player ${index + 1} ${suffix}`, `Cat${index + 1}`],
      );
      fixture.players.push(requireInsertId(player, `player ${index + 1}`));
    }

    const tournament = await sql.execute(
      `INSERT INTO \`${prefix}tournaments\`
        (club_id,name,slug,provider_system,status,max_visits_per_leg,start_at)
       VALUES (?,?,?,'local','draft',50,DATE_ADD(NOW(),INTERVAL 1 DAY))`,
      [fixture.club, `Catalog Tournament ${suffix}`, `catalog-tournament-${suffix}`],
    );
    fixture.tournament = requireInsertId(tournament, "tournament");

    for (const playerId of fixture.players) {
      await sql.execute(
        `INSERT INTO \`${prefix}tournament_players\` (tournament_id,player_id,status,registration_source)
         VALUES (?,?,'registered','admin')`,
        [fixture.tournament, playerId],
      );
    }

    const match = await sql.execute(
      `INSERT INTO \`${prefix}matches\`
        (tournament_id,round_label,bracket_label,status,best_of_legs,legs_to_win,player_a_id,player_b_id)
       VALUES (?,'Runde 1','Gruppe A','pending',3,2,?,?)`,
      [fixture.tournament, fixture.players[0], fixture.players[1]],
    );
    fixture.match = requireInsertId(match, "match");
  });
}

async function cleanupFixture() {
  if (!fixture.club) return;
  try {
    await provider.withConnection(async (sql) => {
      if (fixture.tournament) {
        await sql.execute(`DELETE FROM \`${prefix}matches\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}tournament_players\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}tournaments\` WHERE id=?`, [fixture.tournament]);
      }
      for (const playerId of fixture.players) {
        await sql.execute(`DELETE FROM \`${prefix}players\` WHERE id=?`, [playerId]);
      }
      await sql.execute(`DELETE FROM \`${prefix}clubs\` WHERE id=?`, [fixture.club]);
    });
  } catch (cleanupError) {
    console.error("backend-v2 tournament catalog E2E cleanup failed", cleanupError);
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

async function requestJson(path, { method, expectedStatus = 200 }) {
  const response = await fetch(`${baseUrl}${path}`, { method });
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
