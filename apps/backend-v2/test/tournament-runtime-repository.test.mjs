import assert from "node:assert/strict";
import test from "node:test";

import { MySqlTournamentRuntimeRepository } from "../dist/mysql/tournament-runtime-repository.js";

class ScriptedExecutor {
  constructor(handler) {
    this.handler = handler;
    this.executions = [];
    this.queries = [];
  }
  async query(sql, params = []) {
    this.queries.push({ sql, params });
    return this.handler(sql, params);
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
  }
  async withConnection(work) {
    return work(this.executor);
  }
  async withTransaction(work) {
    return work(this.executor);
  }
}

function tournament(overrides = {}) {
  return {
    id: "10",
    club_id: "1",
    season_id: "2",
    name: "Monday #9",
    slug: "monday-9",
    status: "ready",
    start_at: "2026-09-14 18:30:00",
    end_at: null,
    registration_opens_at: null,
    registration_closes_at: null,
    max_players: "8",
    group_count: null,
    group_draw_mode: null,
    group_draw_seed: null,
    group_drawn_at: null,
    registration_state: "open",
    ...overrides,
  };
}

test("self-registration becomes waitlisted at max capacity and invalidates an old group draw", async () => {
  const executor = new ScriptedExecutor((sql, params, execute = false) => {
    if (sql.includes("FROM `bd_test_tournaments` t WHERE t.id=?")) return [tournament()];
    if (sql.includes("COUNT(*) AS cnt FROM `bd_test_matches`")) return [{ cnt: 0 }];
    if (sql.includes("SELECT club_id FROM `bd_test_players`")) return [{ club_id: "1" }];
    if (sql.includes("COUNT(*) AS cnt FROM `bd_test_tournament_players`")) return [{ cnt: 8 }];
    if (execute) return { affectedRows: 1 };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const repository = new MySqlTournamentRuntimeRepository(new FakeSessions(executor), "bd_test_");

  const result = await repository.registerPlayer("10", "77", "player");

  assert.equal(result.status, "waitlisted");
  const upsert = executor.executions.find((entry) => entry.sql.includes("INSERT INTO `bd_test_tournament_players`"));
  assert.equal(upsert.params[2], "waitlisted");
  assert.ok(executor.executions.some((entry) => entry.sql.includes("DELETE FROM `bd_test_tournament_groups`")));
  assert.ok(executor.executions.some((entry) => entry.sql.includes("group_drawn_at=NULL")));
});

test("self-registration fails closed when registration is closed", async () => {
  const executor = new ScriptedExecutor((sql) => {
    if (sql.includes("FROM `bd_test_tournaments` t WHERE t.id=?")) return [tournament({ registration_state: "closed" })];
    if (sql.includes("COUNT(*) AS cnt FROM `bd_test_matches`")) return [{ cnt: 0 }];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const repository = new MySqlTournamentRuntimeRepository(new FakeSessions(executor), "bd_test_");

  await assert.rejects(() => repository.registerPlayer("10", "77", "player"), (error) => {
    assert.equal(error.code, "registration_closed");
    return true;
  });
});

test("registration changes are locked after matches exist", async () => {
  const executor = new ScriptedExecutor((sql) => {
    if (sql.includes("FROM `bd_test_tournaments` t WHERE t.id=?")) return [tournament()];
    if (sql.includes("COUNT(*) AS cnt FROM `bd_test_matches`")) return [{ cnt: 1 }];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const repository = new MySqlTournamentRuntimeRepository(new FakeSessions(executor), "bd_test_");

  await assert.rejects(() => repository.registerPlayer("10", "77", "player"), (error) => {
    assert.equal(error.code, "registration_locked_by_matches");
    return true;
  });
});

test("withdrawal promotes the oldest waitlisted player when capacity opens", async () => {
  let tournamentReads = 0;
  const executor = new ScriptedExecutor((sql, params, execute = false) => {
    if (sql.includes("FROM `bd_test_tournaments` t WHERE t.id=?")) {
      tournamentReads += 1;
      return [tournament()];
    }
    if (sql.includes("COUNT(*) AS cnt FROM `bd_test_matches`")) return [{ cnt: 0 }];
    if (sql.includes("COUNT(*) AS cnt FROM `bd_test_tournament_players`")) return [{ cnt: 7 }];
    if (sql.includes("WHERE tournament_id=? AND status='waitlisted'")) return [{ id: "55", player_id: "99" }];
    if (execute && sql.includes("SET status='withdrawn'")) return { affectedRows: 1 };
    if (execute) return { affectedRows: 1 };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const repository = new MySqlTournamentRuntimeRepository(new FakeSessions(executor), "bd_test_");

  const result = await repository.withdrawPlayer("10", "77");

  assert.equal(tournamentReads, 2);
  assert.equal(result.status, "withdrawn");
  assert.equal(result.promoted_player_id, 99);
  assert.ok(executor.executions.some((entry) =>
    entry.sql.includes("SET status='registered'") && entry.params[0] === "55",
  ));
});
