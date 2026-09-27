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


test("queueCommand reuses an outstanding GET_SBC_STATUS instead of piling up probes", async () => {
  const executes = [];
  const db = {
    async execute(sql, params = []) {
      executes.push({ sql, params });
      return { affectedRows: 1, insertId: "99" };
    },
    async query(sql) {
      assert.match(sql, /command_type='GET_SBC_STATUS'/);
      return [{
        id: "40",
        message_id: "existing-status-probe",
        status: "queued",
        attempt_count: 0,
        created_at: "2026-09-27 17:00:00.000",
      }];
    },
  };
  const repo = new MySqlScoliaCommandRepository(new FakeSessions(db), "bd_test_");

  const command = await repo.queueCommand("11", "17", "GET_SBC_STATUS", {}, null);

  assert.equal(command.id, "40");
  assert.equal(command.message_id, "existing-status-probe");
  assert.equal(command.status, "queued");
  assert.equal(command.deduped, true);
  assert.equal(executes.length, 1);
  assert.match(executes[0].sql, /Superseded stale status probe/);
  assert.deepEqual(executes[0].params, ["11", "17"]);
});


test("pollCommands expires stale probes and exhausted commands before ordered delivery", async () => {
  const db = fakeDb();
  db.query = async (sql, params = []) => {
    db.queries.push({ sql, params });
    return [];
  };
  const repo = new MySqlScoliaCommandRepository(new FakeSessions(db), "bd_test_");

  const items = await repo.pollCommands(["17"], 10);

  assert.deepEqual(items, []);
  assert.equal(db.executes.length, 3);
  assert.match(db.executes[0].sql, /command_type='GET_SBC_STATUS'/);
  assert.match(db.executes[0].sql, /status='expired'/);
  assert.match(db.executes[0].sql, /INTERVAL 30 SECOND/);
  assert.match(db.executes[1].sql, /attempt_count>=8/);
  assert.match(db.executes[1].sql, /status='expired'/);
  assert.match(db.executes[2].sql, /status='failed'/);
  assert.match(db.executes[2].sql, /attempt_count<8/);
});

test("queueCommand deduplicates a failed current status probe", async () => {
  const db = fakeDb();
  db.query = async (sql, params = []) => {
    db.queries.push({ sql, params });
    return [{
      id: "40",
      message_id: "failed-current-probe",
      status: "failed",
      attempt_count: 1,
      created_at: "2026-09-27 18:00:00.000",
    }];
  };
  const repo = new MySqlScoliaCommandRepository(new FakeSessions(db), "bd_test_");

  const command = await repo.queueCommand("11", "17", "GET_SBC_STATUS", {}, null);

  assert.equal(command.id, "40");
  assert.equal(command.status, "failed");
  assert.equal(command.deduped, true);
  assert.equal(db.executes.length, 1);
});
