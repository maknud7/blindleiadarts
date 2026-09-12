import assert from "node:assert/strict";
import test from "node:test";

import { MySqlScoliaCommandRepository } from "../dist/mysql/scolia-command-repository.js";

class FakeSessions {
  constructor(db) { this.db = db; }
  async withConnection(callback) { return callback(this.db); }
  async withTransaction(callback) { return callback(this.db); }
}

function fakeDb() {
  const executes = [];
  const queries = [];
  return {
    executes,
    queries,
    async execute(sql, params = []) {
      executes.push({ sql, params });
      return { affectedRows: 1, insertId: "41" };
    },
    async query(sql, params = []) {
      queries.push({ sql, params });
      return [];
    },
  };
}

test("queueCommand persists required UUID message_id and nullable creator", async () => {
  const db = fakeDb();
  const repo = new MySqlScoliaCommandRepository(new FakeSessions(db), "bd_test_");

  const command = await repo.queueCommand("11", "17", "correct_throw", { throwIndex: 1, sector: "T20" }, null);

  assert.equal(command.id, "41");
  assert.equal(command.kiosk_id, "17");
  assert.equal(command.command_type, "CORRECT_THROW");
  assert.equal(command.type, "CORRECT_THROW");
  assert.match(command.message_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  const insert = db.executes[0];
  assert.match(insert.sql, /command_type,message_id,payload_json,status,priority,created_by_user_id/);
  assert.deepEqual(insert.params.slice(0, 3), ["11", "17", "CORRECT_THROW"]);
  assert.equal(insert.params[3], command.message_id);
  assert.equal(insert.params[5], null);
});

test("completeCommand uses schema-compatible acked/refused/failed statuses", async () => {
  for (const [input, expected] of [["ack", "acked"], ["acked", "acked"], ["refused", "refused"], ["error", "failed"]]) {
    const db = fakeDb();
    const repo = new MySqlScoliaCommandRepository(new FakeSessions(db), "bd_test_");
    await repo.completeCommand("41", input, input === "error" ? "socket" : null);
    const update = db.executes[0];
    assert.match(update.sql, /completed_at=IF\(\? IN \('acked','refused'\),NOW\(3\),NULL\)/);
    assert.match(update.sql, /next_attempt_at=DATE_ADD\(NOW\(3\),INTERVAL 3 SECOND\)/);
    assert.equal(update.params[0], expected);
    assert.equal(update.params[1], expected);
    assert.equal(update.params[3], "41");
  }
});
