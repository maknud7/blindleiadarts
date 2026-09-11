import assert from "node:assert/strict";
import test from "node:test";

import { MySqlTournamentOperationsRepository } from "../dist/mysql/tournament-operations-repository.js";

class FakeExecutor {
  constructor(plan) { this.plan = plan; this.calls = []; }
  async query(sql, params = []) {
    this.calls.push({ kind: "query", sql, params });
    if (sql.includes("FROM `bd_test_tournaments`")) return [this.plan.tournament];
    if (sql.includes("FROM `bd_test_tournament_kiosks`")) return (this.plan.selected ?? []).map((id) => ({ kiosk_id: id }));
    if (sql.includes("FROM `bd_test_kiosks`") && sql.includes("EXISTS")) return this.plan.boards ?? [];
    if (sql.includes("FROM `bd_test_kiosks`") && sql.includes("FOR UPDATE")) return (this.plan.validBoards ?? []).map((id) => ({ id }));
    if (sql.includes("FROM `bd_test_matches`") && sql.includes("FOR UPDATE")) return this.plan.blocked ?? [];
    return [];
  }
  async execute(sql, params = []) { this.calls.push({ kind: "execute", sql, params }); return { affectedRows: 1 }; }
}
class FakeSessions {
  constructor(plan) { this.db = new FakeExecutor(plan); this.transactions = 0; }
  async withConnection(work) { return work(this.db); }
  async withTransaction(work) { this.transactions += 1; return work(this.db); }
}

const tournament = { id: "11", club_id: "1", status: "ready", auto_assign_enabled: 1 };
const boards = [
  { id: "1", code: "board-1", name: "Skive 1", board_number: 1, scoring_mode: "manual", is_active: 1, is_busy: 0, is_reserved: 0 },
  { id: "2", code: "board-2", name: "Skive 2", board_number: 2, scoring_mode: "scolia", is_active: 1, is_busy: 1, is_reserved: 0 },
];

test("board selection defaults to active boards before explicit selection exists", async () => {
  const sessions = new FakeSessions({ tournament, selected: [], boards });
  const repo = new MySqlTournamentOperationsRepository(sessions, "bd_test_");
  const result = await repo.boardSelection("11");
  assert.equal(result.selection_initialized, false);
  assert.equal(result.selected_count, 2);
  assert.equal(result.boards[0].can_remove, true);
  assert.equal(result.boards[1].can_remove, false);
});

test("replacing board selection is atomic and rejects removal of active board", async () => {
  const sessions = new FakeSessions({ tournament, selected: ["1", "2"], validBoards: ["1"], blocked: [{ kiosk_id: "2" }] });
  const repo = new MySqlTournamentOperationsRepository(sessions, "bd_test_");
  await assert.rejects(() => repo.replaceBoardSelection("11", ["1"]), (error) => {
    assert.equal(error.code, "tournament_board_in_use");
    assert.equal(error.statusCode, 409);
    return true;
  });
  assert.equal(sessions.transactions, 1);
  assert.equal(sessions.db.calls.some((call) => call.kind === "execute" && call.sql.includes("DELETE FROM `bd_test_tournament_kiosks`")), false);
});

test("auto assign setting preserves boolean contract", async () => {
  const sessions = new FakeSessions({ tournament });
  const repo = new MySqlTournamentOperationsRepository(sessions, "bd_test_");
  const result = await repo.updateAutoAssignEnabled("11", false);
  assert.equal(result.auto_assign_enabled, false);
  assert.ok(sessions.db.calls.some((call) => call.kind === "execute" && call.params[0] === 0));
});
