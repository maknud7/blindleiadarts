import assert from "node:assert/strict";
import test from "node:test";

import { asDbId } from "../dist/contracts/scoring.js";
import { asTablePrefix } from "../dist/mysql/contracts.js";
import { MySqlTournamentEloProjection } from "../dist/mysql/tournament-elo-projection.js";

class FixtureSessions {
  constructor({ status = "in_progress", snapshots = [] } = {}) {
    this.status = status;
    this.snapshots = snapshots.map((row) => ({ ...row }));
    this.operations = [];
    this.transactions = 0;
  }

  async withConnection() {
    throw new Error("tournament ELO sync must be transaction-scoped");
  }

  async withTransaction(work) {
    this.transactions += 1;
    return work({
      query: async (sql, params = []) => {
        this.operations.push({ kind: "query", sql, params });
        if (sql.includes("SELECT tournament_id FROM `bd_test_matches`")) {
          return [{ tournament_id: "9007199254741000" }];
        }
        if (sql.includes("FROM `bd_test_tournaments`") && sql.includes("FOR UPDATE")) {
          return [{
            id: "9007199254741000",
            club_id: "9007199254741300",
            season_id: "9007199254741400",
            status: this.status,
            start_at: "2026-09-10 18:00:00",
            end_at: this.status === "completed" ? "2026-09-10 21:00:00" : null,
            elo_enabled: 1,
          }];
        }
        if (sql.includes("FROM `bd_test_tournament_elo_snapshots` s")) {
          return this.snapshots.map((row) => ({ ...row }));
        }
        if (sql.includes("FROM `bd_test_players` p") && sql.includes("elo_current_ratings")) {
          return [
            { id: "9007199254741100", display_name: "Alice", elo_rating: "1012.500000", elo_matches_played: 1, local_matches_played: 1 },
            { id: "9007199254741200", display_name: "Bob", elo_rating: "987.500000", elo_matches_played: 1, local_matches_played: 1 },
          ];
        }
        if (sql.includes("FROM `bd_test_elo_match_events`")) {
          return [{
            player_a_id: "9007199254741100",
            rating_a_before: "1000.000000",
            rating_a_after: "1012.500000",
            matches_before_a: 0,
            player_b_id: "9007199254741200",
            rating_b_before: "1000.000000",
            rating_b_after: "987.500000",
            matches_before_b: 0,
          }];
        }
        if (sql.includes("FROM `bd_test_tournament_players`")) {
          return [
            { player_id: "9007199254741100" },
            { player_id: "9007199254741200" },
          ];
        }
        if (sql.includes("FROM `bd_test_elo_current_ratings`") && sql.includes("WHERE season_id=?")) {
          return [];
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      execute: async (sql, params = []) => {
        this.operations.push({ kind: "execute", sql, params });
        if (sql.includes("INSERT IGNORE INTO `bd_test_tournament_elo_snapshots`")) {
          const [tournament_id, season_id, club_id, player_id, elo_before, matches_before, rank_before, rank_baseline_kind, captured_start_at] = params;
          if (!this.snapshots.some((row) => row.player_id === player_id)) {
            const names = {
              "9007199254741100": "Alice",
              "9007199254741200": "Bob",
            };
            this.snapshots.push({
              tournament_id,
              season_id,
              club_id,
              player_id,
              display_name: names[player_id] ?? "",
              elo_before,
              elo_after: null,
              matches_before,
              matches_after: null,
              rank_before,
              rank_after: null,
              rank_baseline_kind,
              captured_start_at,
            });
          }
        }
        if (sql.includes("SET rank_before=?")) {
          const [rank, tournamentId, playerId] = params;
          const row = this.snapshots.find((snapshot) => snapshot.player_id === playerId && snapshot.tournament_id === tournamentId);
          if (row) row.rank_before = rank;
        }
        return { affectedRows: 1 };
      },
    });
  }
}

function executes(sessions, fragment) {
  return sessions.operations.filter((operation) => operation.kind === "execute" && operation.sql.includes(fragment));
}

test("first sync reconstructs tournament start from event-before ratings, not already changed current ratings", async () => {
  const sessions = new FixtureSessions();
  const projection = new MySqlTournamentEloProjection(sessions, asTablePrefix("bd_test_"));

  await projection.syncTournamentElo(asDbId("9007199254740993"));

  assert.equal(sessions.transactions, 1);
  const inserts = executes(sessions, "INSERT IGNORE INTO `bd_test_tournament_elo_snapshots`");
  assert.equal(inserts.length, 2);
  assert.deepEqual(inserts.map((entry) => entry.params.slice(3, 8)), [
    ["9007199254741100", 1000, 0, 1, "start"],
    ["9007199254741200", 1000, 0, 2, "start"],
  ]);
  assert.equal(executes(sessions, "elo_after=NULL").length, 1, "in-progress sync clears stale end snapshots");
  assert.match(sessions.operations.find((operation) => operation.sql.includes("FROM `bd_test_tournaments`"))?.sql ?? "", /FOR UPDATE/);
});

test("completed sync captures event-after rating and full-club rank after", async () => {
  const sessions = new FixtureSessions({
    status: "completed",
    snapshots: [
      { tournament_id: "9007199254741000", player_id: "9007199254741100", display_name: "Alice", elo_before: "1000.000000", matches_before: 0, rank_before: 1, rank_baseline_kind: "start" },
      { tournament_id: "9007199254741000", player_id: "9007199254741200", display_name: "Bob", elo_before: "1000.000000", matches_before: 0, rank_before: 2, rank_baseline_kind: "start" },
    ],
  });
  const projection = new MySqlTournamentEloProjection(sessions, asTablePrefix("bd_test_"));

  await projection.syncTournamentElo(asDbId("9007199254740993"));

  const endUpdates = executes(sessions, "SET elo_after=?");
  assert.equal(endUpdates.length, 2);
  const alice = endUpdates.find((entry) => entry.params[5] === "9007199254741100");
  const bob = endUpdates.find((entry) => entry.params[5] === "9007199254741200");
  assert.deepEqual(alice?.params.slice(0, 3), [1012.5, 1, 1]);
  assert.deepEqual(bob?.params.slice(0, 3), [987.5, 2, 1]);
});

test("null/missing match and non-ELO tournament are safe no-ops", async () => {
  let transactions = 0;
  const projection = new MySqlTournamentEloProjection({
    withConnection: async () => { throw new Error("not used"); },
    withTransaction: async (work) => {
      transactions += 1;
      return work({ query: async () => [], execute: async () => ({ affectedRows: 0 }) });
    },
  }, asTablePrefix("bd_test_"));

  await projection.syncTournamentElo(null);
  assert.equal(transactions, 0);
  await projection.syncTournamentElo(asDbId("9007199254740993"));
  assert.equal(transactions, 1);
});
