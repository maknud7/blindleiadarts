import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { DomainValidationError } from "../dist/domain/errors.js";
import { MySqlCanonicalPlayoffReconciliation } from "../dist/mysql/canonical-playoff-reconciliation.js";
import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";
import { loadRuntimeConfig } from "../dist/runtime/config.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test", "playoff E2E may only run with BD_APP_ENV=test");
assert.equal(config.mode, "test-write", "playoff E2E requires guarded test-write mode");
assert.equal(config.prefixes.runtime, "bd_test_", "playoff E2E may only mutate bd_test_ runtime tables");
assert.equal(config.mysql.budget.maxConcurrentConnections, 1, "playoff E2E must keep backend-v2 at one connection");

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
const playoffs = new MySqlCanonicalPlayoffReconciliation(provider, prefix);
const suffix = randomBytes(6).toString("hex");
const fixture = {
  club: null,
  players: [],
  kiosks: [],
  tournament: null,
  tournamentPlayers: [],
  groups: [],
  groupMatches: [],
  playoff: null,
};

try {
  // Only this read-only probe may retry. Once fixture creation starts, every
  // write and canonical playoff unit is single-attempt work.
  await establishReadOnlyConnection();
  await createFixture();

  const lastGroupMatch = fixture.groupMatches[1];
  assert.ok(lastGroupMatch);
  await playoffs.afterMutation(lastGroupMatch, false);

  let snapshot = await playoffSnapshot();
  assert.equal(snapshot.playoff?.bracket_size, 4);
  assert.equal(snapshot.playoff?.qualifiers_per_group, 2);
  assert.equal(snapshot.playoff?.status, "ready");
  assert.equal(snapshot.entries.length, 4);
  assert.equal(snapshot.nodes.length, 3);

  let semifinals = snapshot.nodes.filter((row) => row.round_number === 1);
  let finalNode = snapshot.nodes.find((row) => row.round_number === 2);
  assert.equal(semifinals.length, 2);
  assert.ok(semifinals.every((row) => row.match_id !== null && row.status === "ready"));
  assert.ok(finalNode);
  assert.equal(finalNode.match_id, null);
  assert.equal(finalNode.status, "waiting");

  const semiOne = semifinals[0];
  const semiTwo = semifinals[1];
  assert.ok(semiOne?.match_id && semiOne.player_a_id);
  assert.ok(semiTwo?.match_id && semiTwo.player_a_id);

  await completeMatch(semiOne.match_id, semiOne.player_a_id, null);
  await playoffs.afterMutation(semiOne.match_id, false);
  snapshot = await playoffSnapshot();
  finalNode = snapshot.nodes.find((row) => row.round_number === 2);
  assert.equal(finalNode?.match_id, null, "final must wait until both semifinals resolve");

  await completeMatch(semiTwo.match_id, semiTwo.player_a_id, fixture.kiosks[0]);
  await playoffs.afterMutation(semiTwo.match_id, false);
  snapshot = await playoffSnapshot();
  finalNode = snapshot.nodes.find((row) => row.round_number === 2);
  assert.ok(finalNode?.match_id, "final must materialize after both semifinals resolve");
  assert.equal(finalNode.status, "ready");
  const firstFinalMatch = finalNode.match_id;

  // Safe rewind: downstream final exists but is still pending and unassigned.
  assert.equal(await playoffs.assertUndoAllowed(fixture.kiosks[0]), semiTwo.match_id);
  await reopenMatch(semiTwo.match_id);
  await playoffs.afterMutation(semiTwo.match_id, true);

  snapshot = await playoffSnapshot();
  semifinals = snapshot.nodes.filter((row) => row.round_number === 1);
  const rewoundSemi = semifinals.find((row) => row.match_id === semiTwo.match_id);
  finalNode = snapshot.nodes.find((row) => row.round_number === 2);
  assert.equal(rewoundSemi?.winner_player_id, null);
  assert.equal(rewoundSemi?.status, "ready");
  assert.equal(finalNode?.match_id, null);
  assert.equal(finalNode?.winner_player_id, null);
  assert.equal(await matchExists(firstFinalMatch), false, "safe rewind must delete untouched pending final");

  // Re-completing the semifinal must rebuild exactly one final.
  await completeMatch(semiTwo.match_id, semiTwo.player_a_id, fixture.kiosks[0]);
  await playoffs.afterMutation(semiTwo.match_id, false);
  snapshot = await playoffSnapshot();
  finalNode = snapshot.nodes.find((row) => row.round_number === 2);
  assert.ok(finalNode?.match_id);
  assert.notEqual(finalNode.match_id, firstFinalMatch);
  const finalMatch = finalNode.match_id;
  const finalWinner = finalNode.player_a_id;
  assert.ok(finalWinner);

  // Once downstream is called on another board, semifinal undo must fail before
  // any scoring mutation can occur.
  await provider.withConnection((sql) => sql.execute(
    `UPDATE \`${prefix}matches\` SET status="assigned",kiosk_id=? WHERE id=?`,
    [fixture.kiosks[1], finalMatch],
  ));
  await assert.rejects(
    () => playoffs.assertUndoAllowed(fixture.kiosks[0]),
    (error) => error instanceof DomainValidationError && error.code === "playoff_downstream_started" && error.statusCode === 409,
  );
  const guardedSemi = await matchRow(semiTwo.match_id);
  assert.equal(guardedSemi.status, "completed");
  assert.equal(guardedSemi.winner_player_id, semiTwo.player_a_id);
  const calledFinal = await matchRow(finalMatch);
  assert.equal(calledFinal.status, "assigned");
  assert.equal(calledFinal.kiosk_id, fixture.kiosks[1]);

  await completeMatch(finalMatch, finalWinner, fixture.kiosks[1]);
  await playoffs.afterMutation(finalMatch, false);
  snapshot = await playoffSnapshot();
  assert.equal(snapshot.playoff?.status, "completed");
  assert.equal(snapshot.playoff?.champion_player_id, finalWinner);
  let tournament = await tournamentRow();
  assert.equal(tournament.status, "completed");
  assert.ok(tournament.end_at);

  // The final has no parent, so its own undo remains allowed and reopens the
  // tournament/playoff without touching resolved semifinals.
  assert.equal(await playoffs.assertUndoAllowed(fixture.kiosks[1]), finalMatch);
  await reopenMatch(finalMatch);
  await playoffs.afterMutation(finalMatch, true);
  snapshot = await playoffSnapshot();
  finalNode = snapshot.nodes.find((row) => row.round_number === 2);
  assert.equal(finalNode?.winner_player_id, null);
  assert.equal(finalNode?.status, "ready");
  assert.equal(snapshot.playoff?.status, "in_progress");
  assert.equal(snapshot.playoff?.champion_player_id, null);
  tournament = await tournamentRow();
  assert.equal(tournament.status, "in_progress");
  assert.equal(tournament.end_at, null);

  await completeMatch(finalMatch, finalWinner, fixture.kiosks[1]);
  await playoffs.afterMutation(finalMatch, false);
  snapshot = await playoffSnapshot();
  assert.equal(snapshot.playoff?.status, "completed");
  assert.equal(snapshot.playoff?.champion_player_id, finalWinner);

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-playoff-lifecycle",
    release_sha: config.releaseSha,
    tournament_id: fixture.tournament,
    playoff_id: fixture.playoff,
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

async function createFixture() {
  await provider.withConnection(async (sql) => {
    const club = await sql.execute(
      `INSERT INTO \`${prefix}clubs\` (name,slug) VALUES (?,?)`,
      [`Backend v2 Playoff E2E ${suffix}`, `backend-v2-playoff-club-${suffix}`],
    );
    fixture.club = requireInsertId(club, "club");

    for (let index = 0; index < 4; index += 1) {
      const player = await sql.execute(
        `INSERT INTO \`${prefix}players\` (club_id,display_name,is_active) VALUES (?,?,1)`,
        [fixture.club, `Backend v2 Playoff Player ${index + 1} ${suffix}`],
      );
      fixture.players.push(requireInsertId(player, `player ${index + 1}`));
    }

    const boardRows = await sql.query(`SELECT COALESCE(MAX(board_number),0)+100 AS base_board FROM \`${prefix}kiosks\``);
    const baseBoard = Number(boardRows[0]?.base_board ?? 100000);
    assert.ok(Number.isSafeInteger(baseBoard) && baseBoard > 0);
    for (let index = 0; index < 2; index += 1) {
      const kiosk = await sql.execute(
        `INSERT INTO \`${prefix}kiosks\` (club_id,code,name,board_number,is_active) VALUES (?,?,?,?,1)`,
        [fixture.club, `backend-v2-playoff-${suffix}-${index + 1}`, `Backend v2 Playoff Board ${index + 1}`, baseBoard + index],
      );
      fixture.kiosks.push(requireInsertId(kiosk, `kiosk ${index + 1}`));
    }

    const tournament = await sql.execute(
      `INSERT INTO \`${prefix}tournaments\`
       (club_id,season_id,name,slug,provider_system,status,start_at,
        planned_group_count,planned_group_draw_mode,planned_group_best_of_legs,
        planned_qualifiers_per_group,planned_playoff_best_of_legs,
        planned_auto_create_playoff,planned_tournament_format,planned_starting_score)
       VALUES (?,NULL,?,?,"local","in_progress",NOW(),2,"random",1,2,1,1,"groups_playoff",501)`,
      [fixture.club, `Backend v2 Playoff Tournament ${suffix}`, `backend-v2-playoff-tournament-${suffix}`],
    );
    fixture.tournament = requireInsertId(tournament, "tournament");

    for (let index = 0; index < fixture.players.length; index += 1) {
      const registration = await sql.execute(
        `INSERT INTO \`${prefix}tournament_players\` (tournament_id,player_id,seed,status,registration_source)
         VALUES (?,?,?,"checked_in","admin")`,
        [fixture.tournament, fixture.players[index], index + 1],
      );
      fixture.tournamentPlayers.push(requireInsertId(registration, `tournament player ${index + 1}`));
    }

    for (let index = 0; index < 2; index += 1) {
      const group = await sql.execute(
        `INSERT INTO \`${prefix}tournament_groups\` (tournament_id,name,sort_order,draw_mode,draw_seed)
         VALUES (?,?,?,?,?)`,
        [fixture.tournament, `Group ${index === 0 ? "A" : "B"}`, index + 1, "random", 10_000 + index],
      );
      fixture.groups.push(requireInsertId(group, `group ${index + 1}`));
    }

    for (let index = 0; index < fixture.tournamentPlayers.length; index += 1) {
      const groupIndex = index < 2 ? 0 : 1;
      const position = (index % 2) + 1;
      await sql.execute(
        `INSERT INTO \`${prefix}tournament_group_players\`
         (group_id,tournament_player_id,position,seed_number) VALUES (?,?,?,?)`,
        [fixture.groups[groupIndex], fixture.tournamentPlayers[index], position, index + 1],
      );
    }

    const groupPairs = [[0, 1], [2, 3]];
    for (let index = 0; index < groupPairs.length; index += 1) {
      const [aIndex, bIndex] = groupPairs[index];
      const match = await sql.execute(
        `INSERT INTO \`${prefix}matches\`
         (tournament_id,tournament_group_id,round_label,round_number,bracket_label,status,
          best_of_legs,legs_to_win,player_a_id,player_b_id,winner_player_id,starts_at,finished_at)
         VALUES (?,?,?,1,"Gruppespill","completed",1,1,?,?,?,NOW(),NOW())`,
        [
          fixture.tournament,
          fixture.groups[index],
          `Gruppe ${index === 0 ? "A" : "B"}`,
          fixture.players[aIndex],
          fixture.players[bIndex],
          fixture.players[aIndex],
        ],
      );
      fixture.groupMatches.push(requireInsertId(match, `group match ${index + 1}`));
    }
  });
}

async function playoffSnapshot() {
  return provider.withConnection(async (sql) => {
    const playoffRows = await sql.query(
      `SELECT CAST(id AS CHAR) AS id,qualifiers_per_group,bracket_size,status,
              CAST(champion_player_id AS CHAR) AS champion_player_id
       FROM \`${prefix}tournament_playoffs\` WHERE tournament_id=? LIMIT 1`,
      [fixture.tournament],
    );
    const playoff = playoffRows[0] ? {
      id: String(playoffRows[0].id),
      qualifiers_per_group: Number(playoffRows[0].qualifiers_per_group),
      bracket_size: Number(playoffRows[0].bracket_size),
      status: String(playoffRows[0].status),
      champion_player_id: nullableId(playoffRows[0].champion_player_id),
    } : null;
    if (!playoff) return { playoff: null, entries: [], nodes: [] };
    fixture.playoff = playoff.id;

    const entries = await sql.query(
      `SELECT CAST(player_id AS CHAR) AS player_id,seed_number,CAST(source_group_id AS CHAR) AS source_group_id,
              source_group_position,source_points,source_leg_diff,source_legs_won
       FROM \`${prefix}tournament_playoff_entries\` WHERE playoff_id=? ORDER BY seed_number`,
      [playoff.id],
    );
    const nodeRows = await sql.query(
      `SELECT CAST(id AS CHAR) AS id,round_number,position,round_label,
              CAST(player_a_id AS CHAR) AS player_a_id,CAST(player_b_id AS CHAR) AS player_b_id,
              CAST(match_id AS CHAR) AS match_id,CAST(winner_player_id AS CHAR) AS winner_player_id,status
       FROM \`${prefix}tournament_playoff_nodes\` WHERE playoff_id=? ORDER BY round_number,position`,
      [playoff.id],
    );
    const nodes = nodeRows.map((row) => ({
      id: String(row.id),
      round_number: Number(row.round_number),
      position: Number(row.position),
      round_label: String(row.round_label),
      player_a_id: nullableId(row.player_a_id),
      player_b_id: nullableId(row.player_b_id),
      match_id: nullableId(row.match_id),
      winner_player_id: nullableId(row.winner_player_id),
      status: String(row.status),
    }));
    return { playoff, entries, nodes };
  });
}

async function completeMatch(matchId, winnerPlayerId, kioskId) {
  await provider.withConnection((sql) => sql.execute(
    `UPDATE \`${prefix}matches\`
     SET status="completed",winner_player_id=?,kiosk_id=?,starts_at=COALESCE(starts_at,NOW()),finished_at=NOW()
     WHERE id=?`,
    [winnerPlayerId, kioskId, matchId],
  ));
}

async function reopenMatch(matchId) {
  await provider.withConnection((sql) => sql.execute(
    `UPDATE \`${prefix}matches\` SET status="in_progress",winner_player_id=NULL,finished_at=NULL WHERE id=?`,
    [matchId],
  ));
}

async function matchExists(matchId) {
  return provider.withConnection(async (sql) => {
    const rows = await sql.query(`SELECT 1 AS present FROM \`${prefix}matches\` WHERE id=? LIMIT 1`, [matchId]);
    return rows.length > 0;
  });
}

async function matchRow(matchId) {
  return provider.withConnection(async (sql) => {
    const rows = await sql.query(
      `SELECT status,CAST(winner_player_id AS CHAR) AS winner_player_id,CAST(kiosk_id AS CHAR) AS kiosk_id
       FROM \`${prefix}matches\` WHERE id=? LIMIT 1`,
      [matchId],
    );
    assert.ok(rows[0], `match ${matchId} must exist`);
    return {
      status: String(rows[0].status),
      winner_player_id: nullableId(rows[0].winner_player_id),
      kiosk_id: nullableId(rows[0].kiosk_id),
    };
  });
}

async function tournamentRow() {
  return provider.withConnection(async (sql) => {
    const rows = await sql.query(
      `SELECT status,end_at FROM \`${prefix}tournaments\` WHERE id=? LIMIT 1`,
      [fixture.tournament],
    );
    assert.ok(rows[0]);
    return { status: String(rows[0].status), end_at: rows[0].end_at ?? null };
  });
}

async function cleanupFixture() {
  if (!fixture.club) return;
  try {
    await provider.withConnection(async (sql) => {
      if (fixture.tournament) {
        await sql.execute(`DELETE FROM \`${prefix}tournament_player_breaks\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}tournament_playoffs\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE v FROM \`${prefix}visits\` v INNER JOIN \`${prefix}matches\` m ON m.id=v.match_id WHERE m.tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE l FROM \`${prefix}legs\` l INNER JOIN \`${prefix}matches\` m ON m.id=l.match_id WHERE m.tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE ms FROM \`${prefix}match_statistics\` ms INNER JOIN \`${prefix}matches\` m ON m.id=ms.match_id WHERE m.tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}matches\` WHERE tournament_id=?`, [fixture.tournament]);
        for (const groupId of fixture.groups) {
          await sql.execute(`DELETE FROM \`${prefix}tournament_group_players\` WHERE group_id=?`, [groupId]);
        }
        await sql.execute(`DELETE FROM \`${prefix}tournament_groups\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}tournament_players\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}tournaments\` WHERE id=?`, [fixture.tournament]);
      }
      for (const kioskId of fixture.kiosks) await sql.execute(`DELETE FROM \`${prefix}kiosks\` WHERE id=?`, [kioskId]);
      for (const playerId of fixture.players) await sql.execute(`DELETE FROM \`${prefix}players\` WHERE id=?`, [playerId]);
      await sql.execute(`DELETE FROM \`${prefix}clubs\` WHERE id=?`, [fixture.club]);
    });
  } catch (error) {
    console.error("backend-v2 playoff E2E cleanup failed", error);
  }
}

function nullableId(value) {
  return value === null || value === undefined ? null : String(value);
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
