import assert from "node:assert/strict";
import test from "node:test";

import { asDbId } from "../dist/contracts/scoring.js";
import { DomainValidationError } from "../dist/domain/errors.js";
import { MySqlCanonicalPlayoffReconciliation } from "../dist/mysql/canonical-playoff-reconciliation.js";
import { asTablePrefix } from "../dist/mysql/contracts.js";

const ids = {
  kiosk: asDbId("9007199254747001"),
  otherKiosk: "9007199254747003",
  match: "9007199254747011",
  parentMatch: "9007199254747013",
  node: "9007199254747021",
  parentNode: "9007199254747023",
  playoff: "9007199254747031",
  tournament: "9007199254747041",
  group: "9007199254747051",
};

class FakeSessions {
  constructor(queryHandler) {
    this.queryHandler = queryHandler;
    this.operations = [];
    this.transactions = 0;
  }

  executor() {
    return {
      query: async (sql, params = []) => {
        this.operations.push({ kind: "query", sql, params });
        return this.queryHandler(sql, params);
      },
      execute: async (sql, params = []) => {
        this.operations.push({ kind: "execute", sql, params });
        return { affectedRows: 1 };
      },
    };
  }

  async withConnection(work) {
    return work(this.executor());
  }

  async withTransaction(work) {
    this.transactions += 1;
    return work(this.executor());
  }
}

function targetMatchQuery(sql) {
  return sql.includes("FROM `bd_test_matches`") && sql.includes("WHERE kiosk_id=?");
}

function nodeByMatchQuery(sql) {
  return sql.includes("FROM `bd_test_tournament_playoff_nodes` n") &&
    sql.includes("INNER JOIN `bd_test_tournament_playoffs` po") &&
    sql.includes("WHERE n.match_id=?");
}

function parentNodeQuery(sql) {
  return sql.includes("FROM `bd_test_tournament_playoff_nodes` n") &&
    sql.includes("LEFT JOIN `bd_test_matches` m") &&
    sql.includes("n.round_number=?") &&
    sql.includes("n.position=?");
}

test("downstream called match blocks undo before any transaction or write", async () => {
  const sessions = new FakeSessions((sql) => {
    if (targetMatchQuery(sql)) return [{ id: ids.match }];
    if (nodeByMatchQuery(sql)) {
      return [{
        id: ids.node,
        playoff_id: ids.playoff,
        tournament_id: ids.tournament,
        round_number: 1,
        position: 2,
        match_id: ids.match,
        winner_player_id: "9007199254747999",
        status: "completed",
      }];
    }
    if (parentNodeQuery(sql)) {
      return [{
        id: ids.parentNode,
        playoff_id: ids.playoff,
        round_number: 2,
        position: 1,
        match_id: ids.parentMatch,
        match_status: "assigned",
        kiosk_id: ids.otherKiosk,
      }];
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const playoff = new MySqlCanonicalPlayoffReconciliation(sessions, asTablePrefix("bd_test_"));

  await assert.rejects(
    () => playoff.assertUndoAllowed(ids.kiosk),
    (error) => error instanceof DomainValidationError &&
      error.code === "playoff_downstream_started" &&
      error.statusCode === 409,
  );

  assert.equal(sessions.transactions, 0);
  assert.equal(sessions.operations.filter((operation) => operation.kind === "execute").length, 0);
});

test("pending unassigned downstream match still allows undo target", async () => {
  const sessions = new FakeSessions((sql) => {
    if (targetMatchQuery(sql)) return [{ id: ids.match }];
    if (nodeByMatchQuery(sql)) {
      return [{
        id: ids.node,
        playoff_id: ids.playoff,
        tournament_id: ids.tournament,
        round_number: 1,
        position: 2,
        match_id: ids.match,
        winner_player_id: "9007199254747999",
        status: "completed",
      }];
    }
    if (parentNodeQuery(sql)) {
      return [{
        id: ids.parentNode,
        playoff_id: ids.playoff,
        round_number: 2,
        position: 1,
        match_id: ids.parentMatch,
        match_status: "pending",
        kiosk_id: null,
      }];
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const playoff = new MySqlCanonicalPlayoffReconciliation(sessions, asTablePrefix("bd_test_"));

  assert.equal(await playoff.assertUndoAllowed(ids.kiosk), ids.match);
  assert.equal(sessions.transactions, 0);
  assert.equal(sessions.operations.filter((operation) => operation.kind === "execute").length, 0);
});

test("auto-create flag disabled is a zero-transaction zero-write no-op", async () => {
  const sessions = new FakeSessions((sql) => {
    if (sql.includes("planned_auto_create_playoff") && sql.includes("WHERE m.id=?")) {
      return [{
        tournament_id: ids.tournament,
        tournament_group_id: ids.group,
        status: "completed",
        planned_tournament_format: "groups_playoff",
        planned_auto_create_playoff: 0,
        planned_qualifiers_per_group: 2,
        planned_playoff_best_of_legs: 1,
      }];
    }
    if (sql.includes("SELECT CAST(po.tournament_id AS CHAR) AS tournament_id")) return [];
    throw new Error(`Unexpected query: ${sql}`);
  });
  const playoff = new MySqlCanonicalPlayoffReconciliation(sessions, asTablePrefix("bd_test_"));

  await playoff.afterMutation(asDbId(ids.match), false);

  assert.equal(sessions.transactions, 0);
  assert.equal(sessions.operations.filter((operation) => operation.kind === "execute").length, 0);
});
