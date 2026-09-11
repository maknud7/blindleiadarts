import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { loadRuntimeConfig } from "../dist/runtime/config.js";
import { MySqlLinearRankingProjection } from "../dist/mysql/linear-ranking-projection.js";
import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test", "ranking E2E may only run with BD_APP_ENV=test");
assert.equal(config.mode, "test-write", "ranking E2E requires guarded test-write mode");
assert.equal(config.prefixes.runtime, "bd_test_", "ranking E2E may only mutate bd_test_ runtime tables");
assert.equal(config.mysql.budget.maxConcurrentConnections, 1, "ranking E2E must keep backend-v2 at one connection");

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
  idleConnectionTimeoutMs: 60_000,
});
const prefix = config.prefixes.runtime;
const suffix = randomBytes(6).toString("hex");
const fixture = { club: null, season: null, playerA: null, playerB: null, tournament: null, match: null };
const ranking = new MySqlLinearRankingProjection(provider, prefix);

try {
  // Only the initial read-only connectivity probe may retry. After the first
  // fixture write every ranking operation is single-attempt canonical work.
  await establishReadOnlyConnection();

  const players = await existingPlayers();
  assert.equal(players.length, 2, "ranking E2E requires two existing TEST players in the same club");
  fixture.club = players[0].club_id;
  fixture.playerA = players[0].player_id;
  fixture.playerB = players[1].player_id;
  await createFixture();

  await ranking.reconcileLinearRanking(fixture.match);
  let events = await rankingEvents();
  assert.equal(events.length, 2);
  const byPlayer = new Map(events.map((row) => [row.player_id, row]));
  assert.equal(Number(byPlayer.get(fixture.playerA)?.entrants), 2);
  assert.equal(Number(byPlayer.get(fixture.playerA)?.points), 2);
  assert.equal(byPlayer.get(fixture.playerA)?.stage_label, "Sluttplassering");
  assert.equal(Number(byPlayer.get(fixture.playerA)?.stage_number), 1);
  assert.equal(byPlayer.get(fixture.playerA)?.status, "applied");
  assert.equal(Number(byPlayer.get(fixture.playerB)?.points), 1);
  assert.equal(Number(byPlayer.get(fixture.playerB)?.stage_number), 0);
  assert.equal(byPlayer.get(fixture.playerB)?.status, "applied");
  assert.equal(byPlayer.get(fixture.playerA)?.ruleset, "linear_v1");

  const metadataA = JSON.parse(byPlayer.get(fixture.playerA)?.metadata_json ?? "{}");
  assert.equal(metadataA.calculation, "completed_match_wins_fallback");

  await provider.withConnection(async (sql) => {
    await sql.execute(`UPDATE \`${prefix}tournaments\` SET status="in_progress",end_at=NULL WHERE id=?`, [fixture.tournament]);
  });
  await ranking.reconcileLinearRanking(fixture.match);
  events = await rankingEvents();
  assert.equal(events.length, 2);
  assert.ok(events.every((row) => row.status === "reverted"));
  assert.ok(events.every((row) => row.reverted_at !== null));

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-linear-ranking-lifecycle",
    release_sha: config.releaseSha,
    season_id: fixture.season,
    tournament_id: fixture.tournament,
    match_id: fixture.match,
    runtime_prefix: prefix,
  }));
} finally {
  await cleanupFixture();
  await provider.close();
}

async function establishReadOnlyConnection() {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await provider.withConnection(async (sql) => {
        const rows = await sql.query("SELECT 1 AS ok");
        assert.equal(Number(rows[0]?.ok), 1, "TEST MySQL connectivity probe returned an unexpected value");
      });
      return;
    } catch (error) {
      if (attempt === attempts || !isInitialConnectivityError(error)) throw error;
      console.warn(`TEST MySQL initial connectivity failed (${connectionErrorCode(error)}); retrying read-only probe ${attempt + 1}/${attempts}`);
      await sleep(attempt * 3_000);
    }
  }
}

async function existingPlayers() {
  return provider.withConnection(async (sql) => sql.query(
    `SELECT CAST(p.id AS CHAR) AS player_id,CAST(p.club_id AS CHAR) AS club_id
     FROM \`${prefix}players\` p
     WHERE p.club_id=(
       SELECT candidate.club_id FROM \`${prefix}players\` candidate
       WHERE candidate.club_id IS NOT NULL
       GROUP BY candidate.club_id HAVING COUNT(*)>=2
       ORDER BY COUNT(*) DESC,candidate.club_id ASC LIMIT 1
     )
     ORDER BY p.id ASC LIMIT 2`,
  ));
}

async function createFixture() {
  await provider.withConnection(async (sql) => {
    const season = await sql.execute(
      `INSERT INTO \`${prefix}seasons\` (club_id,name,starts_on,is_active,ranking_method)
       VALUES (?,?,CURRENT_DATE,0,"linear")`,
      [fixture.club, `Backend v2 Ranking E2E Season ${suffix}`],
    );
    fixture.season = requireInsertId(season, "season");

    const tournament = await sql.execute(
      `INSERT INTO \`${prefix}tournaments\`
       (club_id,season_id,name,slug,provider_system,status,start_at,end_at,elo_enabled)
       VALUES (?,?,?, ?,"local","completed",NOW(),NOW(),0)`,
      [fixture.club, fixture.season, `Backend v2 Ranking Tournament ${suffix}`, `backend-v2-ranking-tournament-${suffix}`],
    );
    fixture.tournament = requireInsertId(tournament, "tournament");

    const match = await sql.execute(
      `INSERT INTO \`${prefix}matches\`
       (tournament_id,status,best_of_legs,legs_to_win,player_a_id,player_b_id,winner_player_id,starts_at,finished_at)
       VALUES (?,"completed",1,1,?,?,?,NOW(),NOW())`,
      [fixture.tournament, fixture.playerA, fixture.playerB, fixture.playerA],
    );
    fixture.match = requireInsertId(match, "match");
  });
}

async function rankingEvents() {
  return provider.withConnection((sql) => sql.query(
    `SELECT CAST(player_id AS CHAR) AS player_id,entrants,stage_label,stage_number,points,ruleset,status,metadata_json,reverted_at
     FROM \`${prefix}season_ranking_events\` WHERE tournament_id=? ORDER BY player_id`,
    [fixture.tournament],
  ));
}

async function cleanupFixture() {
  if (!fixture.season) return;
  try {
    await provider.withConnection(async (sql) => {
      if (fixture.tournament) {
        await sql.execute(`DELETE FROM \`${prefix}season_ranking_events\` WHERE tournament_id=?`, [fixture.tournament]);
      }
      if (fixture.match) await sql.execute(`DELETE FROM \`${prefix}matches\` WHERE id=?`, [fixture.match]);
      if (fixture.tournament) {
        await sql.execute(`DELETE FROM \`${prefix}tournament_summaries\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}tournaments\` WHERE id=?`, [fixture.tournament]);
      }
      await sql.execute(`DELETE FROM \`${prefix}seasons\` WHERE id=?`, [fixture.season]);
    });
  } catch (error) {
    console.error("backend-v2 ranking E2E cleanup failed", error);
  }
}

function isInitialConnectivityError(error) {
  return ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"].includes(connectionErrorCode(error));
}

function connectionErrorCode(error) {
  if (!error || typeof error !== "object" || !("code" in error)) return "unknown";
  return String(error.code ?? "unknown");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireInsertId(result, name) {
  assert.ok(result.insertId, `${name} insert did not return an id`);
  return result.insertId;
}
