import assert from "node:assert/strict";
import test from "node:test";

import { MySqlTournamentOperationsRepository } from "../dist/mysql/tournament-operations-repository.js";

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

function tournament(overrides = {}) {
  return {
    id: "9007199254740993",
    club_id: "8007199254740993",
    season_id: "7007199254740993",
    name: "Monday TEST",
    slug: "monday-test",
    status: "ready",
    start_at: "2026-09-14 18:30:00",
    end_at: null,
    auto_assign_enabled: "1",
    club_name: "Blindleia",
    club_slug: "blindleia",
    ...overrides,
  };
}

test("operations keeps BIGINT identifiers as decimal strings", async () => {
  const executor = new ScriptedExecutor((sql) => {
    if (sql.includes("FROM `bd_test_tournaments` t INNER JOIN `bd_test_clubs`")) return [tournament()];
    if (sql.includes("FROM `bd_test_tournament_board_reservations` r")) return [];
    if (sql.includes("FROM `bd_test_tournament_kiosks` tk")) return [];
    if (sql.includes("FROM `bd_test_matches` m") && sql.includes("player_a_registration_status")) return [];
    if (sql.includes("SELECT status,COUNT(*) AS c FROM `bd_test_matches`")) return [];
    if (sql.includes("WHERE m.tournament_id=? AND m.status='completed'")) return [];
    if (sql.includes("SELECT DISTINCT player_id FROM")) return [];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const repository = new MySqlTournamentOperationsRepository(new FakeSessions(executor), "bd_test_");

  const snapshot = await repository.snapshot("9007199254740993");

  assert.equal(snapshot.tournament.id, "9007199254740993");
  assert.equal(snapshot.tournament.club_id, "8007199254740993");
  assert.equal(snapshot.tournament.season_id, "7007199254740993");
});

test("moving an in-progress match fails closed until the caller confirms it", async () => {
  const executor = new ScriptedExecutor((sql) => {
    if (sql.includes("WHERE m.id=? AND m.tournament_id=? LIMIT 1 FOR UPDATE")) {
      return [{
        id: "501",
        tournament_id: "10",
        status: "in_progress",
        kiosk_id: "1",
        player_a_id: "21",
        player_b_id: "22",
        player_a_name: "A",
        player_b_name: "B",
      }];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const sessions = new FakeSessions(executor);
  const repository = new MySqlTournamentOperationsRepository(sessions, "bd_test_");

  await assert.rejects(() => repository.moveMatch("10", "501", "2", false), (error) => {
    assert.equal(error.code, "match_move_confirmation_required");
    return true;
  });
  assert.equal(sessions.transactions, 1);
  assert.equal(executor.executions.length, 0);
});

test("moving a pending match is one transaction and clears Scolia transient state without retrying the write", async () => {
  const executor = new ScriptedExecutor((sql, params, execute) => {
    if (sql.includes("WHERE m.id=? AND m.tournament_id=? LIMIT 1 FOR UPDATE")) {
      return [{
        id: "501",
        tournament_id: "10",
        status: "pending",
        kiosk_id: null,
        player_a_id: "21",
        player_b_id: "22",
        player_a_name: "A",
        player_b_name: "B",
      }];
    }
    if (sql.includes("FROM `bd_test_kiosks` k") && sql.includes("LIMIT 1 FOR UPDATE")) {
      return [{ id: "2", board_number: "2", name: "Board 2" }];
    }
    if (sql.includes("WHERE kiosk_id=? AND id<>?")) return [];
    if (sql.includes("SELECT match_id FROM `bd_test_tournament_board_reservations`")) return [];
    if (execute) return { affectedRows: 1 };
    throw new Error(`Unexpected SQL: ${sql} ${JSON.stringify(params)}`);
  });
  const sessions = new FakeSessions(executor);
  const repository = new MySqlTournamentOperationsRepository(sessions, "bd_test_");

  const moved = await repository.moveMatch("10", "501", "2", false);

  assert.equal(moved.match_id, "501");
  assert.equal(moved.kiosk_id, "2");
  assert.equal(moved.status, "assigned");
  assert.equal(sessions.transactions, 1);
  assert.equal(executor.executions.filter((entry) => entry.sql.includes("UPDATE `bd_test_matches` SET kiosk_id=?")).length, 1);
  assert.equal(executor.executions.filter((entry) => entry.sql.includes("scolia_visit_buffers")).length, 1);
  assert.equal(executor.executions.filter((entry) => entry.sql.includes("turn_locked_until_takeout")).length, 1);
});
