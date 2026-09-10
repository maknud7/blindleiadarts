import assert from "node:assert/strict";
import test from "node:test";

import { asDbId } from "../dist/contracts/scoring.js";
import { MySqlCanonicalEloLedger } from "../dist/mysql/canonical-elo-ledger.js";
import { asTablePrefix } from "../dist/mysql/contracts.js";

class FakeSessions {
  constructor(queryHandler) {
    this.queryHandler = queryHandler;
    this.operations = [];
    this.transactions = 0;
  }

  async withConnection() {
    throw new Error("canonical ELO mutations must be transaction-scoped");
  }

  async withTransaction(work) {
    this.transactions += 1;
    return work({
      query: async (sql, params = []) => {
        this.operations.push({ kind: "query", sql, params });
        return this.queryHandler(sql, params, this.operations);
      },
      execute: async (sql, params = []) => {
        this.operations.push({ kind: "execute", sql, params });
        return { affectedRows: 1 };
      },
    });
  }
}

function match(overrides = {}) {
  return {
    id: "9007199254740993",
    tournament_id: "9007199254741000",
    status: "completed",
    player_a_id: "9007199254741100",
    player_b_id: "9007199254741200",
    winner_player_id: "9007199254741100",
    club_id: "9007199254741300",
    season_id: "9007199254741400",
    elo_enabled: 1,
    player_a_name: "Alice",
    player_a_member_id: "9007199254741500",
    player_b_name: "Bob",
    player_b_member_id: "9007199254741600",
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    id: "9007199254741700",
    match_id: "9007199254740993",
    tournament_id: "9007199254741000",
    season_id: "9007199254741400",
    club_id: "9007199254741300",
    player_a_id: "9007199254741100",
    player_b_id: "9007199254741200",
    winner_player_id: "9007199254741100",
    score_a: "1.0000",
    score_b: "0.0000",
    status: "applied",
    applied_at: "2026-09-10 19:30:00.000000",
    occurred_at: "2026-09-10 19:20:00",
    player_a_name: "Alice",
    player_a_member_id: "9007199254741500",
    player_b_name: "Bob",
    player_b_member_id: "9007199254741600",
    phase_order: 0,
    logical_round: 1,
    ...overrides,
  };
}

function handler({ matchRow = match(), existing = [], applied = [event()] } = {}) {
  return (sql) => {
    if (sql.includes("FROM `bd_test_matches` m")) return [matchRow];
    if (sql.includes("FROM `bd_test_seasons`")) return [{ id: matchRow.season_id ?? event().season_id }];
    if (sql.includes("SELECT * FROM `bd_test_elo_match_events`")) return existing;
    if (sql.includes("FROM `bd_test_elo_match_events` e")) return applied;
    throw new Error(`Unexpected query: ${sql}`);
  };
}

function executed(sessions, fragment) {
  return sessions.operations.filter((operation) => operation.kind === "execute" && operation.sql.includes(fragment));
}

test("eligible completed match is applied and season replay rebuilt atomically", async () => {
  const sessions = new FakeSessions(handler());
  const ledger = new MySqlCanonicalEloLedger(sessions, asTablePrefix("bd_test_"));

  await ledger.applyCompletedMatch(asDbId("9007199254740993"));

  assert.equal(sessions.transactions, 1);
  assert.equal(executed(sessions, "INSERT INTO `bd_test_elo_match_events`").length, 1);
  assert.equal(executed(sessions, "UPDATE `bd_test_elo_match_events`").length, 1);
  assert.equal(executed(sessions, "DELETE FROM `bd_test_elo_current_ratings`").length, 1);
  const ratings = executed(sessions, "INSERT INTO `bd_test_elo_current_ratings`");
  assert.equal(ratings.length, 2);
  assert.deepEqual(ratings.map((operation) => operation.params[1]), [
    "9007199254741100",
    "9007199254741200",
  ]);
  assert.equal(ratings[0].params[2], 1012.5);
  assert.equal(ratings[1].params[2], 987.5);
  const snapshots = executed(sessions, "INSERT INTO `bd_test_ranking_snapshots`");
  assert.equal(snapshots.length, 2);
  assert.match(snapshots[0].params[4], /"source":"elo_ledger"/);
  assert.equal(typeof snapshots[0].params[0], "string");
  assert.equal(typeof snapshots[0].params[2], "string");
});

test("same applied winner is idempotent and does not rebuild", async () => {
  const sessions = new FakeSessions(handler({ existing: [event()] }));
  const ledger = new MySqlCanonicalEloLedger(sessions, asTablePrefix("bd_test_"));

  await ledger.applyCompletedMatch(asDbId("9007199254740993"));

  assert.equal(sessions.transactions, 1);
  assert.equal(sessions.operations.some((operation) => operation.kind === "execute"), false);
});

test("true guest match remains ELO-neutral", async () => {
  const sessions = new FakeSessions(handler({
    matchRow: match({ player_b_member_id: null }),
    applied: [],
  }));
  const ledger = new MySqlCanonicalEloLedger(sessions, asTablePrefix("bd_test_"));

  await ledger.applyCompletedMatch(asDbId("9007199254740993"));

  assert.equal(sessions.operations.some((operation) => operation.kind === "execute"), false);
});

test("revert marks event and clears derived season state when no applied events remain", async () => {
  let eventReads = 0;
  const sessions = new FakeSessions((sql) => {
    if (sql.includes("SELECT * FROM `bd_test_elo_match_events`")) {
      eventReads += 1;
      return [event()];
    }
    if (sql.includes("FROM `bd_test_seasons`")) return [{ id: "9007199254741400" }];
    if (sql.includes("FROM `bd_test_elo_match_events` e")) return [];
    throw new Error(`Unexpected query: ${sql}`);
  });
  const ledger = new MySqlCanonicalEloLedger(sessions, asTablePrefix("bd_test_"));

  await ledger.revertMatch(asDbId("9007199254740993"));

  assert.equal(eventReads, 2, "event is rechecked after acquiring the season lock");
  assert.equal(executed(sessions, "SET status=\"reverted\"").length, 1);
  assert.equal(executed(sessions, "DELETE FROM `bd_test_elo_current_ratings`").length, 1);
  assert.equal(executed(sessions, "DELETE FROM `bd_test_ranking_snapshots`").length, 1);
});

test("historical player aliases sharing one member identity share replay state", async () => {
  const first = event({
    id: "9007199254741700",
    match_id: "9007199254740991",
    player_a_id: "9007199254741100",
    player_a_name: "Alice",
    player_a_member_id: "9007199254741500",
    occurred_at: "2026-09-10 18:00:00",
  });
  const second = event({
    id: "9007199254741701",
    match_id: "9007199254740993",
    player_a_id: "9007199254741101",
    player_a_name: "Alice",
    player_a_member_id: "9007199254741500",
    occurred_at: "2026-09-10 19:00:00",
    logical_round: 2,
  });
  const sessions = new FakeSessions(handler({ applied: [first, second] }));
  const ledger = new MySqlCanonicalEloLedger(sessions, asTablePrefix("bd_test_"));

  await ledger.applyCompletedMatch(asDbId("9007199254740993"));

  const calculations = executed(sessions, "UPDATE `bd_test_elo_match_events`");
  assert.equal(calculations.length, 2);
  assert.equal(calculations[0].params[2], 1012.5);
  assert.ok(calculations[1].params[0] > 1000, "alias starts second match from first player's post-match rating");

  const ratings = executed(sessions, "INSERT INTO `bd_test_elo_current_ratings`");
  const aliceRows = ratings.filter((operation) => ["9007199254741100", "9007199254741101"].includes(operation.params[1]));
  assert.equal(aliceRows.length, 2);
  assert.equal(aliceRows[0].params[2], aliceRows[1].params[2]);
  assert.equal(aliceRows[0].params[3], 2);
});
