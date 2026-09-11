import assert from "node:assert/strict";
import test from "node:test";

import { asDbId } from "../dist/contracts/scoring.js";
import { asTablePrefix } from "../dist/mysql/contracts.js";
import { maximumLinearPoints, MySqlLinearRankingProjection } from "../dist/mysql/linear-ranking-projection.js";

const ids = {
  match: asDbId("9007199254745001"),
  tournament: "9007199254745003",
  season: "9007199254745005",
  playoff: "9007199254745007",
  a: "9007199254745101",
  b: "9007199254745103",
  c: "9007199254745105",
  d: "9007199254745107",
};

class RankingSessions {
  constructor({ status = "completed", playoff = null, participants = [ids.a, ids.b, ids.c], wins = [] , nodes = [], entries = [] } = {}) {
    this.status = status;
    this.playoff = playoff;
    this.participants = participants;
    this.wins = wins;
    this.nodes = nodes;
    this.entries = entries;
    this.operations = [];
    this.transactions = 0;
  }

  async withConnection() {
    throw new Error("linear ranking must stay transaction-scoped");
  }

  async withTransaction(work) {
    this.transactions += 1;
    return work({
      query: async (sql, params = []) => {
        this.operations.push({ kind: "query", sql, params });
        if (sql.includes("FROM `bd_test_matches` m") && sql.includes("ranking_method")) {
          return [{
            tournament_id: ids.tournament,
            season_id: ids.season,
            status: this.status,
            ranking_method: "linear",
          }];
        }
        if (sql.includes("SELECT DISTINCT player_id FROM")) {
          return this.participants.map((player_id) => ({ player_id }));
        }
        if (sql.includes("FROM `bd_test_tournament_playoffs`")) {
          return this.playoff === null ? [] : [{ ...this.playoff }];
        }
        if (sql.includes("FROM `bd_test_tournament_playoff_entries`")) {
          return this.entries.map((player_id, index) => ({ player_id, seed_number: index + 1 }));
        }
        if (sql.includes("FROM `bd_test_tournament_playoff_nodes`")) {
          return this.nodes.map((row) => ({ ...row }));
        }
        if (sql.includes("COUNT(*) AS wins")) {
          return this.wins.map(([winner_player_id, wins]) => ({ winner_player_id, wins }));
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      execute: async (sql, params = []) => {
        this.operations.push({ kind: "execute", sql, params });
        return { affectedRows: 1 };
      },
    });
  }
}

function executes(sessions, fragment) {
  return sessions.operations.filter((operation) => operation.kind === "execute" && operation.sql.includes(fragment));
}

function upserts(sessions) {
  return executes(sessions, "INSERT INTO `bd_test_season_ranking_events`");
}

test("maximum points mirrors linear_v1 field-size ceiling", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 8, 9, 16, 17, 32].map((entrants) => [entrants, maximumLinearPoints(entrants)]),
    [[0, 1], [1, 1], [2, 2], [3, 3], [4, 3], [5, 4], [8, 4], [9, 5], [16, 5], [17, 6], [32, 6]],
  );
  assert.throws(() => maximumLinearPoints(-1));
  assert.throws(() => maximumLinearPoints(2.5));
});

test("completed tournament without playoff uses one point plus completed wins", async () => {
  const sessions = new RankingSessions({
    wins: [[ids.a, 2], [ids.b, 1]],
  });
  const projection = new MySqlLinearRankingProjection(sessions, asTablePrefix("bd_test_"));

  await projection.reconcileLinearRanking(ids.match);

  assert.equal(sessions.transactions, 1);
  const writes = upserts(sessions);
  assert.equal(writes.length, 3);
  const byPlayer = new Map(writes.map((write) => [write.params[2], write.params]));
  assert.deepEqual(byPlayer.get(ids.a)?.slice(3, 8), [3, "Sluttplassering", 2, 3, JSON.stringify({ calculation: "completed_match_wins_fallback" })]);
  assert.deepEqual(byPlayer.get(ids.b)?.slice(3, 8), [3, "Sluttplassering", 1, 2, JSON.stringify({ calculation: "completed_match_wins_fallback" })]);
  assert.deepEqual(byPlayer.get(ids.c)?.slice(3, 8), [3, "Deltaker", 0, 1, JSON.stringify({ calculation: "field_size_and_stage" })]);

  const cleanup = executes(sessions, "player_id NOT IN");
  assert.equal(cleanup.length, 1);
  assert.deepEqual(cleanup[0].params, [ids.tournament, ids.a, ids.b, ids.c]);
  assert.match(sessions.operations[0].sql, /FOR UPDATE/);
});

test("playoff ranking awards champion maximum and stage points to other entrants", async () => {
  const sessions = new RankingSessions({
    participants: [ids.a, ids.b, ids.c, ids.d],
    playoff: { id: ids.playoff, bracket_size: 4, champion_player_id: ids.a },
    entries: [ids.a, ids.b, ids.c, ids.d],
    nodes: [
      { round_number: 1, round_label: "Semifinale", player_a_id: ids.a, player_b_id: ids.d, winner_player_id: ids.a },
      { round_number: 1, round_label: "Semifinale", player_a_id: ids.b, player_b_id: ids.c, winner_player_id: ids.b },
      { round_number: 2, round_label: "Finale", player_a_id: ids.a, player_b_id: ids.b, winner_player_id: ids.a },
    ],
  });
  const projection = new MySqlLinearRankingProjection(sessions, asTablePrefix("bd_test_"));

  await projection.reconcileLinearRanking(ids.match);

  const writes = upserts(sessions);
  const byPlayer = new Map(writes.map((write) => [write.params[2], write.params]));
  assert.deepEqual(byPlayer.get(ids.a)?.slice(4, 7), ["Finale", 2, 3]);
  assert.deepEqual(byPlayer.get(ids.b)?.slice(4, 7), ["Finale", 2, 2]);
  assert.deepEqual(byPlayer.get(ids.c)?.slice(4, 7), ["Semifinale", 1, 1]);
  assert.deepEqual(byPlayer.get(ids.d)?.slice(4, 7), ["Semifinale", 1, 1]);
  assert.deepEqual(JSON.parse(byPlayer.get(ids.a)?.[7]), {
    calculation: "field_size_and_stage",
    bracket_size: 4,
    playoff_rounds: 2,
  });
});

test("non-completed linear tournament reverts current linear_v1 events and writes no new rows", async () => {
  const sessions = new RankingSessions({ status: "in_progress" });
  const projection = new MySqlLinearRankingProjection(sessions, asTablePrefix("bd_test_"));

  await projection.reconcileLinearRanking(ids.match);

  assert.equal(upserts(sessions).length, 0);
  const reverts = executes(sessions, "SET status=\"reverted\"");
  assert.equal(reverts.length, 1);
  assert.deepEqual(reverts[0].params, [ids.tournament]);
});

test("null match is a zero-session no-op and BIGINT ids stay decimal strings", async () => {
  const sessions = new RankingSessions();
  const projection = new MySqlLinearRankingProjection(sessions, asTablePrefix("bd_test_"));

  await projection.reconcileLinearRanking(null);
  assert.equal(sessions.transactions, 0);

  await projection.reconcileLinearRanking(ids.match);
  for (const write of upserts(sessions)) {
    assert.equal(typeof write.params[0], "string");
    assert.equal(typeof write.params[1], "string");
    assert.equal(typeof write.params[2], "string");
  }
});
