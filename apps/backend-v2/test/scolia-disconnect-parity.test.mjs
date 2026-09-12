import assert from "node:assert/strict";
import test from "node:test";

import { MySqlScoliaKioskRuntimeRepository } from "../dist/mysql/scolia-kiosk-runtime-repository.js";
import { ScoliaEventProcessor } from "../dist/service/scolia-event-processor.js";

class FakeSessions {
  constructor(db) { this.db = db; }
  async withConnection(callback) { return callback(this.db); }
  async withTransaction(callback) { return callback(this.db); }
}

function disconnectDb({ activeMatch }) {
  const queries = [];
  const executes = [];
  return {
    queries,
    executes,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM `bd_test_kiosks`") && sql.includes("source_kiosk_id")) {
        return [{ id: "17", club_id: "11", source_kiosk_id: "7" }];
      }
      if (sql.includes("FROM `bd_prod_kiosks`") && sql.includes("scolia_board_settings")) {
        return [{ mode: "live", auto_fallback_to_manual: 1, scoring_mode: "scolia" }];
      }
      if (sql.includes("FROM `bd_test_matches`")) return activeMatch ? [{ id: "99" }] : [];
      return [];
    },
    async execute(sql, params = []) {
      executes.push({ sql, params });
      return { affectedRows: 1, insertId: "0" };
    },
  };
}

test("disconnect without an in-progress match records disconnect but does not activate fallback", async () => {
  const db = disconnectDb({ activeMatch: false });
  const runtime = new MySqlScoliaKioskRuntimeRepository(new FakeSessions(db), "bd_test_", "bd_prod_");

  await runtime.markDisconnected("17", "bridge gone");

  const matchQuery = db.queries.find(({ sql }) => sql.includes("FROM `bd_test_matches`"));
  assert.ok(matchQuery);
  assert.match(matchQuery.sql, /status='in_progress'/);
  assert.doesNotMatch(matchQuery.sql, /assigned/);

  const write = db.executes.find(({ sql }) => sql.includes("scolia_board_runtime"));
  assert.ok(write);
  assert.deepEqual(write.params, ["17", 0, 0, "bridge gone"]);
  assert.match(write.sql, /GREATEST\(fallback_active,VALUES\(fallback_active\)\)/);
  assert.match(write.sql, /connected_at=NULL/);
});

test("disconnect during an in-progress live Scolia match activates fallback and reconciliation", async () => {
  const db = disconnectDb({ activeMatch: true });
  const runtime = new MySqlScoliaKioskRuntimeRepository(new FakeSessions(db), "bd_test_", "bd_prod_");

  await runtime.markDisconnected("17", "socket closed");

  const write = db.executes.find(({ sql }) => sql.includes("scolia_board_runtime"));
  assert.ok(write);
  assert.deepEqual(write.params, ["17", 1, 1, "socket closed"]);
});

test("event processor delegates disconnect semantics to the runtime port", async () => {
  const calls = [];
  const bridge = {
    async boardContext() {
      return { kiosk_id: "17", physical_kiosk_id: "7", club_id: "11", mode: "live", fallback_active: 0, needs_reconciliation: 0, turn_locked_until_takeout: 0 };
    },
    async markDisconnected() { throw new Error("bridge repository must not own disconnect fallback semantics"); },
  };
  const scoring = {
    async startMatch() { return { kind: "no_match" }; },
    async recordVisit() { return { kind: "duplicate" }; },
    async undoLastVisit() { return { kind: "no_visit" }; },
  };
  const disconnects = {
    async markDisconnected(kioskId, reason) { calls.push({ kioskId, reason }); },
  };
  const processor = new ScoliaEventProcessor(bridge, scoring, disconnects);

  const result = await processor.processEvent({
    id: "44",
    club_id: "11",
    kiosk_id: "17",
    match_id: null,
    provider_event_id: "evt-44",
    event_type: "BRIDGE_DISCONNECTED",
    priority: 90,
    attempt_count: 1,
    payload: { type: "BRIDGE_DISCONNECTED", payload: { reason: "network" } },
  });

  assert.equal(result.status, "processed");
  assert.deepEqual(calls, [{ kioskId: "17", reason: "network" }]);
});
