import assert from "node:assert/strict";
import test from "node:test";

import { asDbId } from "../dist/contracts/scoring.js";
import { MySqlCanonicalScoringRepository } from "../dist/mysql/canonical-scoring-repository.js";
import { asTablePrefix } from "../dist/mysql/contracts.js";

class RecordingSessionProvider {
  constructor(resolver) {
    this.resolver = resolver;
    this.operations = [];
    this.connectionCalls = 0;
    this.transactionCalls = 0;
    this.active = 0;
    this.maxActive = 0;
  }

  async withConnection(work) {
    this.connectionCalls += 1;
    return this.run("connection", work);
  }

  async withTransaction(work) {
    this.transactionCalls += 1;
    return this.run("transaction", work);
  }

  async run(scope, work) {
    assert.equal(this.active, 0, "repository must never nest scarce MySQL sessions");
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    const executor = {
      query: async (sql, params = []) => {
        const operation = { scope, kind: "query", sql, params: [...params] };
        this.operations.push(operation);
        return this.resolver(operation) ?? [];
      },
      execute: async (sql, params = []) => {
        const operation = { scope, kind: "execute", sql, params: [...params] };
        this.operations.push(operation);
        return this.resolver(operation) ?? { affectedRows: 1 };
      },
    };
    try {
      return await work(executor);
    } finally {
      this.active -= 1;
    }
  }
}

const ids = {
  kiosk: asDbId("9007199254742001"),
  match: asDbId("9007199254742003"),
  leg1: asDbId("9007199254742005"),
  leg2: asDbId("9007199254742007"),
  visit: asDbId("9007199254742009"),
  playerA: asDbId("9007199254742011"),
  playerB: asDbId("9007199254742013"),
};

test("startMatch mirrors PHP assigned-to-in-progress transaction and opens one leg", async () => {
  const sessions = new RecordingSessionProvider(({ kind, sql }) => {
    if (kind === "query" && sql.includes("WHERE kiosk_id=?")) {
      return [{
        id: ids.match,
        status: "assigned",
        legs_to_win: "1",
        player_a_id: ids.playerA,
        player_b_id: ids.playerB,
      }];
    }
    if (kind === "query" && sql.includes('status IN ("pending","in_progress")')) return [];
    if (kind === "query" && sql.includes("ORDER BY leg_number DESC LIMIT 1 FOR UPDATE")) return [];
    if (kind === "execute" && sql.includes("INSERT INTO `bd_test_legs`")) {
      return { affectedRows: 1, insertId: ids.leg1 };
    }
    return { affectedRows: 1 };
  });
  const repository = new MySqlCanonicalScoringRepository(sessions, asTablePrefix("bd_test_"));

  const result = await repository.startMatch({ kiosk_id: ids.kiosk, source: "manual" });

  assert.deepEqual(result, { kind: "started", match_id: ids.match, leg_id: ids.leg1 });
  assert.equal(sessions.connectionCalls, 0);
  assert.equal(sessions.transactionCalls, 1);
  assert.equal(sessions.maxActive, 1);
  assert.equal(sessions.operations.length, 5);
  assert.match(sessions.operations[0].sql, /status IN \("in_progress","assigned"\)/);
  assert.match(sessions.operations[0].sql, /FOR UPDATE/);
  assert.match(sessions.operations[1].sql, /SET status="in_progress"/);
  assert.match(sessions.operations[2].sql, /`bd_test_legs`/);
  assert.match(sessions.operations[2].sql, /FOR UPDATE/);
  assert.match(sessions.operations[4].sql, /INSERT INTO `bd_test_legs`/);
});

test("undoLastVisit removes checkout-created empty leg, reopens completed state and rebuilds stats", async () => {
  let latestLegReads = 0;
  const sessions = new RecordingSessionProvider(({ kind, sql, params }) => {
    if (kind === "execute") return { affectedRows: 1 };

    if (sql.includes("WHERE kiosk_id=?")) {
      return [{
        id: ids.match,
        status: "completed",
        legs_to_win: "1",
        player_a_id: ids.playerA,
        player_b_id: ids.playerB,
      }];
    }
    if (sql.includes("ORDER BY leg_number DESC LIMIT 1 FOR UPDATE")) {
      latestLegReads += 1;
      if (latestLegReads === 1) {
        return [{
          id: ids.leg2,
          match_id: ids.match,
          leg_number: "2",
          starting_player_id: ids.playerB,
          status: "in_progress",
          start_score: "501",
        }];
      }
      return [{
        id: ids.leg1,
        match_id: ids.match,
        leg_number: "1",
        starting_player_id: ids.playerA,
        status: "completed",
        start_score: "501",
        winner_player_id: ids.playerA,
      }];
    }
    if (sql.includes("SELECT COUNT(*) AS c") && sql.includes("WHERE leg_id=?")) {
      return [{ c: params[0] === ids.leg2 ? "0" : "5" }];
    }
    if (sql.includes("FROM `bd_test_visits`") && sql.includes("ORDER BY id DESC LIMIT 1 FOR UPDATE")) {
      return [{
        id: ids.visit,
        leg_id: ids.leg1,
        player_id: ids.playerA,
        score: "161",
        darts_used: "3",
        is_bust: "0",
        remaining_after: "0",
      }];
    }
    if (sql.includes("SELECT player_a_id, player_b_id")) {
      return [{ player_a_id: ids.playerA, player_b_id: ids.playerB }];
    }
    if (sql.includes("COALESCE(SUM(CASE WHEN is_bust=0 THEN score")) {
      return [{
        effective_score: "340",
        darts_thrown: "6",
        highest_checkout: "0",
        score_100_plus: "0",
        score_140_plus: "1",
        score_180: "1",
      }];
    }
    if (sql.includes("SELECT COUNT(*) AS c") && sql.includes("winner_player_id=?")) {
      return [{ c: "0" }];
    }
    throw new Error(`Unexpected SQL in undo fixture: ${sql}`);
  });
  const repository = new MySqlCanonicalScoringRepository(sessions, asTablePrefix("bd_test_"));

  const result = await repository.undoLastVisit({ kiosk_id: ids.kiosk, source: "manual" });

  assert.deepEqual(result, {
    kind: "undone",
    match_id: ids.match,
    leg_id: ids.leg1,
    visit_id: ids.visit,
  });
  assert.equal(sessions.connectionCalls, 0);
  assert.equal(sessions.transactionCalls, 1);
  assert.equal(sessions.maxActive, 1);
  assert.match(sessions.operations[0].sql, /status IN \("in_progress","assigned","completed"\)/);
  assert.match(sessions.operations[0].sql, /FOR UPDATE/);

  const emptyLegDelete = sessions.operations.find(
    ({ kind, sql, params }) => kind === "execute" && sql.includes("DELETE FROM `bd_test_legs`") && params[0] === ids.leg2,
  );
  assert.ok(emptyLegDelete, "checkout-created trailing empty legs must be removed before undo");

  const reopenLeg = sessions.operations.find(
    ({ kind, sql }) => kind === "execute" && sql.includes('`bd_test_legs` SET winner_player_id=NULL, status="in_progress"'),
  );
  const reopenMatch = sessions.operations.find(
    ({ kind, sql }) => kind === "execute" && sql.includes('`bd_test_matches` SET status="in_progress", winner_player_id=NULL'),
  );
  const visitDelete = sessions.operations.find(
    ({ kind, sql }) => kind === "execute" && sql.includes("DELETE FROM `bd_test_visits`"),
  );
  assert.ok(reopenLeg);
  assert.ok(reopenMatch);
  assert.ok(visitDelete);

  const statisticsUpserts = sessions.operations.filter(
    ({ kind, sql }) => kind === "execute" && sql.includes("INSERT INTO `bd_test_match_statistics`"),
  );
  assert.equal(statisticsUpserts.length, 2);

  for (const operation of sessions.operations) {
    assert.equal(operation.sql.includes("hardware"), false);
    assert.equal(operation.sql.includes("identity"), false);
  }
});
