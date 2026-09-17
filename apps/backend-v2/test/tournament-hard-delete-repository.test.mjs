import assert from "node:assert/strict";
import test from "node:test";

import { MySqlTournamentHardDeleteRepository } from "../dist/mysql/tournament-hard-delete-repository.js";

class ScriptedExecutor {
  constructor(handler) {
    this.handler = handler;
    this.executions = [];
    this.queries = [];
  }
  async query(sql, params = []) {
    this.queries.push({ sql, params });
    return this.handler(sql, params, false);
  }
  async execute(sql, params = []) {
    this.executions.push({ sql, params });
    const result = this.handler(sql, params, true);
    return result && !Array.isArray(result) ? result : { affectedRows: 1 };
  }
}

class FakeSessions {
  constructor(executor) {
    this.executor = executor;
    this.transactions = 0;
  }
  async withConnection(work) {
    return work(this.executor);
  }
  async withTransaction(work) {
    this.transactions += 1;
    return work(this.executor);
  }
}

test("hard delete keeps exact BIGINT ids, reverts ELO in the same transaction, and stays inside bd_test_", async () => {
  const tournamentId = "90071992547409931";
  const matchId = "90071992547409932";

  const executor = new ScriptedExecutor((sql, params, execute) => {
    if (sql.includes("SELECT id FROM `bd_test_tournaments`") && sql.includes("FOR UPDATE")) {
      assert.deepEqual(params, [tournamentId]);
      return [{ id: tournamentId }];
    }
    if (sql.includes("SELECT id FROM `bd_test_matches` WHERE tournament_id=?")) {
      assert.deepEqual(params, [tournamentId]);
      return [{ id: matchId }];
    }
    if (sql.includes("SELECT * FROM `bd_test_elo_match_events` WHERE match_id=?")) {
      assert.deepEqual(params, [matchId]);
      return [];
    }
    if (sql.includes("FROM INFORMATION_SCHEMA.COLUMNS c") && sql.includes("t.TABLE_TYPE='BASE TABLE'") && !sql.includes("c.COLUMN_NAME='tournament_id'")) {
      return [
        { TABLE_NAME: "bd_test_tournaments", COLUMN_NAME: "id" },
        { TABLE_NAME: "bd_test_matches", COLUMN_NAME: "id" },
        { TABLE_NAME: "bd_test_matches", COLUMN_NAME: "tournament_id" },
        { TABLE_NAME: "bd_test_tournament_groups", COLUMN_NAME: "id" },
        { TABLE_NAME: "bd_test_tournament_groups", COLUMN_NAME: "tournament_id" },
        { TABLE_NAME: "bd_test_audit_log", COLUMN_NAME: "entity_type" },
        { TABLE_NAME: "bd_test_audit_log", COLUMN_NAME: "entity_id" },
        // Shared identity metadata may exist in the same schema, but must not
        // become part of a TEST runtime hard-delete plan.
        { TABLE_NAME: "bd_prod_auth_sessions", COLUMN_NAME: "id" },
        { TABLE_NAME: "bd_prod_auth_sessions", COLUMN_NAME: "user_account_id" },
      ];
    }
    if (sql.includes("SELECT id FROM `bd_test_tournament_groups` WHERE tournament_id=?")) return [];
    if (sql.includes("FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE")) {
      return [
        {
          child_table: "bd_test_matches",
          child_column: "tournament_id",
          parent_table: "bd_test_tournaments",
          parent_column: "id",
        },
        {
          child_table: "bd_prod_auth_sessions",
          child_column: "user_account_id",
          parent_table: "bd_prod_user_accounts",
          parent_column: "id",
        },
      ];
    }
    if (sql.includes("c.COLUMN_NAME='tournament_id'")) {
      return [
        { TABLE_NAME: "bd_test_matches" },
        { TABLE_NAME: "bd_test_tournament_groups" },
        { TABLE_NAME: "bd_prod_some_runtime_table" },
      ];
    }
    if (sql.includes("SELECT 1 AS found FROM `bd_test_tournaments`")) return [];
    if (execute) return { affectedRows: 1 };
    throw new Error(`Unexpected SQL: ${sql} ${JSON.stringify(params)}`);
  });

  const sessions = new FakeSessions(executor);
  const repository = new MySqlTournamentHardDeleteRepository(sessions, "bd_test_");
  const result = await repository.hardDeleteTournament(tournamentId);

  assert.equal(result.tournament_id, tournamentId);
  assert.equal(result.matches, 1);
  assert.equal(typeof result.tournament_id, "string");
  assert.equal(sessions.transactions, 1, "the canonical mutation must have exactly one outer transaction");
  assert.equal(
    executor.queries.filter((entry) => entry.sql.includes("bd_test_elo_match_events")).length,
    1,
    "ELO revert must execute through the transaction-bound executor",
  );
  assert.equal(
    executor.executions.filter((entry) => entry.sql.includes("DELETE FROM `bd_test_tournaments`")).length,
    1,
    "the canonical root delete must not be retried",
  );
  assert.ok(
    executor.executions.every((entry) => !entry.sql.includes("bd_prod_")),
    "TEST hard delete must never mutate shared PROD identity/hardware tables",
  );
  assert.ok(
    executor.executions.some((entry) => entry.params.includes(matchId)),
    "the exact BIGINT match id must remain a decimal string in mutation parameters",
  );
});
