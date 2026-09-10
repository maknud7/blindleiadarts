import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { loadRuntimeConfig } from "../dist/runtime/config.js";
import { MySqlCanonicalEloLedger } from "../dist/mysql/canonical-elo-ledger.js";
import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";
import { MySqlTournamentEloProjection } from "../dist/mysql/tournament-elo-projection.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test", "ELO E2E may only run with BD_APP_ENV=test");
assert.equal(config.mode, "test-write", "ELO E2E requires guarded test-write mode");
assert.equal(config.prefixes.runtime, "bd_test_", "ELO E2E may only mutate bd_test_ runtime tables");
assert.equal(config.mysql.budget.maxConcurrentConnections, 1, "ELO E2E must keep backend-v2 at one connection");

const provider = new MySql2SessionProvider({
  host: config.mysql.host,
  port: config.mysql.port,
  database: config.mysql.database,
  username: config.mysql.username,
  password: config.mysql.password,
  connectTimeoutMs: config.mysql.connectTimeoutMs,
  budget: config.mysql.budget,
  writable: true,
});
const prefix = config.prefixes.runtime;
const suffix = randomBytes(6).toString("hex");
const fixture = {
  club: null,
  season: null,
  playerA: null,
  playerB: null,
  tournament: null,
  match: null,
};

const elo = new MySqlCanonicalEloLedger(provider, prefix);
const tournamentElo = new MySqlTournamentEloProjection(provider, prefix);

try {
  const players = await existingMemberPlayers();
  assert.equal(players.length, 2, "ELO E2E requires two existing member-linked TEST players in the same club");
  assert.equal(players[0].club_id, players[1].club_id, "ELO E2E players must belong to the same TEST club");
  fixture.club = players[0].club_id;
  fixture.playerA = players[0].player_id;
  fixture.playerB = players[1].player_id;
  await createFixture();

  await elo.applyCompletedMatch(fixture.match);

  const event = await one(
    `SELECT status,
            CAST(player_a_id AS CHAR) AS player_a_id,
            CAST(player_b_id AS CHAR) AS player_b_id,
            rating_a_before,rating_b_before,rating_a_after,rating_b_after,
            matches_before_a,matches_before_b,k_a,k_b
     FROM \`${prefix}elo_match_events\` WHERE match_id=?`,
    [fixture.match],
  );
  assert.equal(event.status, "applied");
  assert.equal(event.player_a_id, fixture.playerA);
  assert.equal(event.player_b_id, fixture.playerB);
  approx(event.rating_a_before, 1000, "rating_a_before");
  approx(event.rating_b_before, 1000, "rating_b_before");
  approx(event.rating_a_after, 1012.5, "rating_a_after");
  approx(event.rating_b_after, 987.5, "rating_b_after");
  assert.equal(Number(event.matches_before_a), 0);
  assert.equal(Number(event.matches_before_b), 0);
  approx(event.k_a, 25, "k_a");
  approx(event.k_b, 25, "k_b");

  const current = await all(
    `SELECT CAST(player_id AS CHAR) AS player_id,rating,matches_played
     FROM \`${prefix}elo_current_ratings\`
     WHERE season_id=? ORDER BY player_id ASC`,
    [fixture.season],
  );
  assert.equal(current.length, 2);
  const currentByPlayer = new Map(current.map((row) => [row.player_id, row]));
  approx(currentByPlayer.get(fixture.playerA)?.rating, 1012.5, "current A rating");
  approx(currentByPlayer.get(fixture.playerB)?.rating, 987.5, "current B rating");
  assert.equal(Number(currentByPlayer.get(fixture.playerA)?.matches_played), 1);
  assert.equal(Number(currentByPlayer.get(fixture.playerB)?.matches_played), 1);

  // First tournament snapshot intentionally happens after the completed match.
  // It must reconstruct the start state from the ELO event, not current ratings.
  await tournamentElo.syncTournamentElo(fixture.match);
  let snapshots = await snapshotRows();
  assert.equal(snapshots.length, 2);
  const startByPlayer = new Map(snapshots.map((row) => [row.player_id, row]));
  const startA = startByPlayer.get(fixture.playerA);
  const startB = startByPlayer.get(fixture.playerB);
  assert.ok(startA && startB, "both tournament participants need start snapshots");
  approx(startA.elo_before, 1000, "snapshot A elo_before");
  approx(startB.elo_before, 1000, "snapshot B elo_before");
  assert.equal(Number(startA.matches_before), 0);
  assert.equal(Number(startB.matches_before), 0);
  assert.equal(startA.rank_baseline_kind, "start");
  assert.equal(startB.rank_baseline_kind, "start");
  assert.equal(Number(startA.rank_before), 1);
  assert.equal(Number(startB.rank_before), 2);
  assert.equal(startA.elo_after, null);
  assert.equal(startB.elo_after, null);

  await provider.withConnection(async (sql) => {
    await sql.execute(
      `UPDATE \`${prefix}tournaments\` SET status="completed",end_at=NOW() WHERE id=?`,
      [fixture.tournament],
    );
  });
  await tournamentElo.syncTournamentElo(fixture.match);

  snapshots = await snapshotRows();
  const endByPlayer = new Map(snapshots.map((row) => [row.player_id, row]));
  const endA = endByPlayer.get(fixture.playerA);
  const endB = endByPlayer.get(fixture.playerB);
  assert.ok(endA && endB, "both tournament participants need end snapshots");
  approx(endA.elo_after, 1012.5, "snapshot A elo_after");
  approx(endB.elo_after, 987.5, "snapshot B elo_after");
  assert.equal(Number(endA.matches_after), 1);
  assert.equal(Number(endB.matches_after), 1);
  assert.equal(Number(endA.rank_after), 1);
  assert.equal(Number(endB.rank_after), 2);
  assert.ok(endA.captured_end_at, "A end snapshot timestamp missing");
  assert.ok(endB.captured_end_at, "B end snapshot timestamp missing");

  await elo.revertMatch(fixture.match);
  const reverted = await one(
    `SELECT status,reverted_at FROM \`${prefix}elo_match_events\` WHERE match_id=?`,
    [fixture.match],
  );
  assert.equal(reverted.status, "reverted");
  assert.ok(reverted.reverted_at, "reverted event timestamp missing");
  assert.equal(Number(await scalar(
    `SELECT COUNT(*) AS value FROM \`${prefix}elo_current_ratings\` WHERE season_id=?`,
    [fixture.season],
  )), 0, "revert must remove season current ratings when no applied events remain");

  await provider.withConnection(async (sql) => {
    await sql.execute(
      `UPDATE \`${prefix}tournaments\` SET status="in_progress",end_at=NULL WHERE id=?`,
      [fixture.tournament],
    );
  });
  await tournamentElo.syncTournamentElo(fixture.match);
  snapshots = await snapshotRows();
  for (const row of snapshots) {
    assert.equal(row.elo_after, null);
    assert.equal(row.rank_after, null);
    assert.equal(row.matches_after, null);
    assert.equal(row.captured_end_at, null);
  }

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-elo-lifecycle",
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

async function existingMemberPlayers() {
  return provider.withConnection(async (sql) => sql.query(
    `SELECT CAST(p.id AS CHAR) AS player_id,
            CAST(p.club_id AS CHAR) AS club_id,
            CAST(p.member_id AS CHAR) AS member_id
     FROM \`${prefix}players\` p
     WHERE p.club_id=(
       SELECT candidate.club_id
       FROM \`${prefix}players\` candidate
       WHERE candidate.member_id IS NOT NULL AND candidate.member_id>0 AND candidate.club_id IS NOT NULL
       GROUP BY candidate.club_id
       HAVING COUNT(*)>=2
       ORDER BY COUNT(*) DESC,candidate.club_id ASC
       LIMIT 1
     )
       AND p.member_id IS NOT NULL AND p.member_id>0
     ORDER BY p.id ASC
     LIMIT 2`,
  ));
}

async function createFixture() {
  await provider.withConnection(async (sql) => {
    const season = await sql.execute(
      `INSERT INTO \`${prefix}seasons\` (club_id,name,starts_on,is_active) VALUES (?,?,CURRENT_DATE,0)`,
      [fixture.club, `Backend v2 ELO E2E Season ${suffix}`],
    );
    fixture.season = requireInsertId(season, "season");

    const tournament = await sql.execute(
      `INSERT INTO \`${prefix}tournaments\`
       (club_id,season_id,name,slug,provider_system,status,start_at,elo_enabled)
       VALUES (?,?,?, ?,"local","in_progress",NOW(),1)`,
      [fixture.club, fixture.season, `Backend v2 ELO Tournament ${suffix}`, `backend-v2-elo-tournament-${suffix}`],
    );
    fixture.tournament = requireInsertId(tournament, "tournament");

    await sql.execute(
      `INSERT INTO \`${prefix}tournament_players\` (tournament_id,player_id,status) VALUES (?,? ,"checked_in"),(?,? ,"checked_in")`,
      [fixture.tournament, fixture.playerA, fixture.tournament, fixture.playerB],
    );

    const match = await sql.execute(
      `INSERT INTO \`${prefix}matches\`
       (tournament_id,status,best_of_legs,legs_to_win,player_a_id,player_b_id,winner_player_id,starts_at,finished_at)
       VALUES (?,"completed",1,1,?,?,?,NOW(),NOW())`,
      [fixture.tournament, fixture.playerA, fixture.playerB, fixture.playerA],
    );
    fixture.match = requireInsertId(match, "match");
  });
}

async function cleanupFixture() {
  if (!fixture.season) return;
  try {
    await provider.withConnection(async (sql) => {
      if (fixture.tournament) {
        await sql.execute(`DELETE FROM \`${prefix}tournament_elo_snapshots\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}season_ranking_events\` WHERE tournament_id=?`, [fixture.tournament]);
      }
      await sql.execute(`DELETE FROM \`${prefix}ranking_snapshots\` WHERE season_id=?`, [fixture.season]);
      await sql.execute(`DELETE FROM \`${prefix}elo_current_ratings\` WHERE season_id=?`, [fixture.season]);
      if (fixture.match) {
        await sql.execute(`DELETE FROM \`${prefix}elo_match_events\` WHERE match_id=?`, [fixture.match]);
        await sql.execute(`DELETE FROM \`${prefix}matches\` WHERE id=?`, [fixture.match]);
      }
      if (fixture.tournament) {
        await sql.execute(`DELETE FROM \`${prefix}tournament_players\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}tournament_summaries\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}tournaments\` WHERE id=?`, [fixture.tournament]);
      }
      await sql.execute(`DELETE FROM \`${prefix}seasons\` WHERE id=?`, [fixture.season]);
    });
  } catch (error) {
    console.error("backend-v2 ELO E2E cleanup failed", error);
  }
}

async function snapshotRows() {
  return all(
    `SELECT CAST(player_id AS CHAR) AS player_id,elo_before,elo_after,rank_before,rank_after,
            rank_baseline_kind,matches_before,matches_after,captured_start_at,captured_end_at
     FROM \`${prefix}tournament_elo_snapshots\`
     WHERE tournament_id=? ORDER BY player_id ASC`,
    [fixture.tournament],
  );
}

async function all(sqlText, params) {
  return provider.withConnection((sql) => sql.query(sqlText, params));
}

async function one(sqlText, params) {
  const rows = await all(sqlText, params);
  assert.ok(rows[0], `query returned no row: ${sqlText}`);
  return rows[0];
}

async function scalar(sqlText, params) {
  const row = await one(sqlText, params);
  return row.value;
}

function approx(actual, expected, label) {
  const number = Number(actual);
  assert.ok(Number.isFinite(number), `${label} is not numeric: ${actual}`);
  assert.ok(Math.abs(number - expected) < 0.000001, `${label}: expected ${expected}, got ${actual}`);
}

function requireInsertId(result, name) {
  assert.ok(result.insertId, `${name} insert did not return an id`);
  return result.insertId;
}
