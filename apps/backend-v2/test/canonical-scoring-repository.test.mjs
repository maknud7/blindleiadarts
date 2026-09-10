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
    this.transactionFailures = 0;
    this.active = 0;
    this.maxActive = 0;
  }

  async withConnection(work) {
    this.connectionCalls += 1;
    return this.run("connection", work, false);
  }

  async withTransaction(work) {
    this.transactionCalls += 1;
    try {
      return await this.run("transaction", work, true);
    } catch (error) {
      this.transactionFailures += 1;
      throw error;
    }
  }

  async run(scope, work, transactional) {
    assert.equal(this.active, 0, "repository must never nest scarce MySQL sessions");
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    const executor = {
      query: async (sql, params = []) => {
        this.operations.push({ scope, kind: "query", sql, params: [...params] });
        return this.resolver({ scope, kind: "query", sql, params: [...params], transactional });
      },
      execute: async (sql, params = []) => {
        this.operations.push({ scope, kind: "execute", sql, params: [...params] });
        const result = this.resolver({ scope, kind: "execute", sql, params: [...params], transactional });
        return result ?? { affectedRows: 1 };
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
  kiosk: asDbId("9007199254740993"),
  match: asDbId("9007199254740995"),
  leg: asDbId("9007199254740997"),
  playerA: asDbId("9007199254740999"),
  playerB: asDbId("9007199254741001"),
};

function normalVisitResolver(operation) {
  const { kind, sql, params } = operation;
  if (kind === "execute") return { affectedRows: 1 };

  if (sql.includes("WHERE request_key=? LIMIT 1")) return [];
  if (sql.includes("WHERE kiosk_id=?") && sql.includes("FOR UPDATE")) {
    return [{
      id: ids.match,
      status: "in_progress",
      legs_to_win: "2",
      player_a_id: ids.playerA,
      player_b_id: ids.playerB,
    }];
  }
  if (sql.includes('status IN ("pending","in_progress")') && sql.includes("FOR UPDATE")) {
    return [{
      id: ids.leg,
      match_id: ids.match,
      leg_number: "1",
      starting_player_id: ids.playerA,
      status: "in_progress",
      start_score: "501",
    }];
  }
  if (sql.includes("COUNT(v.id) AS total_visits")) {
    return [{ starting_player_id: ids.playerA, total_visits: "0" }];
  }
  if (sql.includes("SELECT player_id, score, is_bust")) return [];
  if (sql.includes("MAX(visit_number)")) return [{ n: "0" }];
  if (sql.includes("SELECT player_a_id, player_b_id")) {
    return [{ player_a_id: ids.playerA, player_b_id: ids.playerB }];
  }
  if (sql.includes("COALESCE(SUM(CASE WHEN is_bust=0 THEN score")) {
    if (params[1] === ids.playerA) {
      return [{
        effective_score: "60",
        darts_thrown: "3",
        highest_checkout: "0",
        score_100_plus: "0",
        score_140_plus: "0",
        score_180: "0",
      }];
    }
    return [{
      effective_score: "0",
      darts_thrown: "0",
      highest_checkout: "0",
      score_100_plus: "0",
      score_140_plus: "0",
      score_180: "0",
    }];
  }
  if (sql.includes("SELECT COUNT(*) AS c") && sql.includes("winner_player_id=?")) {
    return [{ c: "0" }];
  }

  throw new Error(`Unexpected SQL in test fixture: ${sql}`);
}

test("recordVisit mirrors PHP retry + transaction order without nested connections", async () => {
  const sessions = new RecordingSessionProvider(normalVisitResolver);
  const repository = new MySqlCanonicalScoringRepository(sessions, asTablePrefix("bd_test_"));

  const result = await repository.recordVisit({
    kiosk_id: ids.kiosk,
    source: "manual",
    payload: { score: 60, darts_used: 3, request_id: "manual-test-1" },
  });

  assert.equal(result.kind, "recorded");
  assert.equal(result.match_id, ids.match);
  assert.equal(result.leg_id, ids.leg);
  assert.equal(result.player_id, ids.playerA);
  assert.equal(result.evaluation.remaining_after, 441);
  assert.equal(result.match_completed, false);

  assert.equal(sessions.connectionCalls, 1, "retry pre-check uses one short non-transactional session");
  assert.equal(sessions.transactionCalls, 1, "the canonical write is one transaction");
  assert.equal(sessions.maxActive, 1, "low-capacity MySQL sessions are never nested");
  assert.equal(sessions.operations.length, 15, "no shadow/diagnostic MySQL queries are added");

  assert.deepEqual(
    sessions.operations.slice(0, 3).map(({ scope, kind }) => [scope, kind]),
    [["connection", "query"], ["transaction", "query"], ["transaction", "query"]],
  );
  assert.match(sessions.operations[2].sql, /FROM `bd_test_matches`/);
  assert.match(sessions.operations[2].sql, /FOR UPDATE/);
  assert.match(sessions.operations[3].sql, /FROM `bd_test_legs`/);
  assert.match(sessions.operations[3].sql, /FOR UPDATE/);

  const visitInsert = sessions.operations.find(
    (operation) => operation.kind === "execute" && operation.sql.includes("INSERT INTO `bd_test_visits`"),
  );
  assert.ok(visitInsert);
  assert.equal(visitInsert.sql.includes("INSERT IGNORE"), false, "canonical visit SQL stays equal to PHP");
  assert.deepEqual(visitInsert.params.slice(0, 3), [ids.match, ids.leg, ids.playerA]);
  assert.equal(visitInsert.params[10], "manual-test-1");
  assert.equal(typeof visitInsert.params[0], "string");
  assert.equal(typeof visitInsert.params[1], "string");
  assert.equal(typeof visitInsert.params[2], "string");

  for (const operation of sessions.operations) {
    assert.equal(operation.sql.includes("`bd_matches`"), false);
    assert.equal(operation.sql.includes("hardware"), false);
    assert.equal(operation.sql.includes("identity"), false);
  }
});

test("an already persisted request key returns before opening a transaction", async () => {
  const sessions = new RecordingSessionProvider(({ sql, kind }) => {
    assert.equal(kind, "query");
    assert.match(sql, /WHERE request_key=\? LIMIT 1/);
    return [{ id: "1" }];
  });
  const repository = new MySqlCanonicalScoringRepository(sessions, asTablePrefix("bd_test_"));

  const result = await repository.recordVisit({
    kiosk_id: ids.kiosk,
    source: "scolia",
    payload: { score: 60, request_id: "scolia-existing" },
  });

  assert.deepEqual(result, { kind: "duplicate" });
  assert.equal(sessions.connectionCalls, 1);
  assert.equal(sessions.transactionCalls, 0);
  assert.equal(sessions.operations.length, 1);
});

test("the request key is rechecked inside the transaction before match locks", async () => {
  const sessions = new RecordingSessionProvider(({ scope, sql, kind }) => {
    assert.equal(kind, "query");
    assert.match(sql, /WHERE request_key=\? LIMIT 1/);
    return scope === "connection" ? [] : [{ id: "2" }];
  });
  const repository = new MySqlCanonicalScoringRepository(sessions, asTablePrefix("bd_test_"));

  const result = await repository.recordVisit({
    kiosk_id: ids.kiosk,
    source: "scolia",
    payload: { score: 60, request_id: "scolia-race" },
  });

  assert.deepEqual(result, { kind: "duplicate" });
  assert.equal(sessions.connectionCalls, 1);
  assert.equal(sessions.transactionCalls, 1);
  assert.equal(sessions.maxActive, 1);
  assert.equal(sessions.operations.length, 2);
  assert.equal(sessions.operations.some(({ sql }) => sql.includes("FOR UPDATE")), false);
});

test("request_id validation fails before consuming any MySQL connection", async () => {
  const sessions = new RecordingSessionProvider(() => {
    throw new Error("database must not be touched");
  });
  const repository = new MySqlCanonicalScoringRepository(sessions, asTablePrefix("bd_test_"));

  await assert.rejects(
    repository.recordVisit({
      kiosk_id: ids.kiosk,
      source: "api",
      payload: { score: 60, request_id: "x".repeat(81) },
    }),
    (error) => error?.code === "request_id_too_long",
  );
  assert.equal(sessions.connectionCalls, 0);
  assert.equal(sessions.transactionCalls, 0);
});

test("BIGINT ids returned as JS numbers are rejected at the repository boundary", async () => {
  const sessions = new RecordingSessionProvider(({ sql, kind }) => {
    if (kind === "query" && sql.includes("WHERE kiosk_id=?")) {
      return [{
        id: 9007199254740996,
        status: "in_progress",
        legs_to_win: "2",
        player_a_id: ids.playerA,
        player_b_id: ids.playerB,
      }];
    }
    return [];
  });
  const repository = new MySqlCanonicalScoringRepository(sessions, asTablePrefix("bd_test_"));

  await assert.rejects(
    repository.recordVisit({
      kiosk_id: ids.kiosk,
      source: "api",
      payload: { score: 60 },
    }),
    /matches\.id must be returned from MySQL as a decimal string/,
  );
  assert.equal(sessions.connectionCalls, 0);
  assert.equal(sessions.transactionCalls, 1);
  assert.equal(sessions.transactionFailures, 1);
});
