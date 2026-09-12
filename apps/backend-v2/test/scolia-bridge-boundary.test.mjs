import assert from "node:assert/strict";
import test from "node:test";

import { mapScoliaSector } from "../dist/domain/scolia.js";
import { MySqlScoliaBridgeRepository } from "../dist/mysql/scolia-bridge-repository.js";

class FakeSessions {
  constructor(db) { this.db = db; }
  async withConnection(callback) { return callback(this.db); }
  async withTransaction(callback) { return callback(this.db); }
}

test("Scolia sector mapping matches canonical dart semantics", () => {
  assert.deepEqual(mapScoliaSector("T20").dart, { multiplier: "T", value: 20 });
  assert.deepEqual(mapScoliaSector("Bull").dart, { multiplier: "D", value: "BULL" });
  assert.deepEqual(mapScoliaSector("25").dart, { multiplier: "S", value: "BULL" });
  assert.deepEqual(mapScoliaSector("None").dart, { multiplier: "S", value: 0 });
  assert.throws(() => mapScoliaSector("T21"), (error) => error?.code === "invalid_scolia_sector");
});

test("split TEST scope never advertises physical boards to a second bridge", async () => {
  const db = { async query() { throw new Error("no SQL expected"); }, async execute() { throw new Error("no SQL expected"); } };
  const repository = new MySqlScoliaBridgeRepository(new FakeSessions(db), "bd_test_", "bd_prod_");
  assert.deepEqual(await repository.listBridgeBoards(), []);
});

test("TEST event routing requires canonical lease and writes only runtime queue", async () => {
  const queries = [];
  const executes = [];
  const db = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM `bd_prod_scolia_board_settings`")) {
        return [{ physical_kiosk_id: "7", club_id: "1", club_slug: "blindleia-dartklubb", serial_number: "SCOLIA-7", mode: "live", enabled: 1, access_token: "secret" }];
      }
      if (sql.includes("FROM `bd_prod_scolia_test_leases`")) {
        return [{ test_kiosk_id: "17", club_id: "11", slug: "blindleia-dartklubb" }];
      }
      if (sql.includes("FROM `bd_test_matches`")) return [];
      if (sql.includes("FROM `bd_test_scolia_events`") && sql.includes("dedupe_key")) return [{ id: "44" }];
      return [];
    },
    async execute(sql, params = []) {
      executes.push({ sql, params });
      if (sql.includes("INSERT IGNORE INTO `bd_test_scolia_events`")) return { affectedRows: 1, insertId: "44" };
      return { affectedRows: 1, insertId: 0 };
    },
  };
  const repository = new MySqlScoliaBridgeRepository(new FakeSessions(db), "bd_test_", "bd_prod_");
  const result = await repository.enqueueEvent("scolia-7", { id: "evt-1", type: "THROW_DETECTED", payload: { sector: "T20" } }, "17");
  assert.equal(result.id, "44");
  assert.equal(result.kiosk_id, "17");
  assert.ok(queries.some(({ sql }) => sql.includes("`bd_prod_scolia_test_leases`")));
  assert.ok(executes.some(({ sql }) => sql.includes("INSERT IGNORE INTO `bd_test_scolia_events`")));
  assert.ok(executes.some(({ sql }) => sql.includes("`bd_test_scolia_board_runtime`")));
  assert.ok(!executes.some(({ sql }) => /INSERT|UPDATE|DELETE/.test(sql) && sql.includes("`bd_prod_scolia_")));
});

test("TEST event routing fails closed without active canonical lease", async () => {
  const db = {
    async query(sql) {
      if (sql.includes("FROM `bd_prod_scolia_board_settings`")) {
        return [{ physical_kiosk_id: "7", club_id: "1", club_slug: "blindleia-dartklubb", serial_number: "SCOLIA-7", mode: "live", enabled: 1, access_token: "secret" }];
      }
      if (sql.includes("FROM `bd_prod_scolia_test_leases`")) return [];
      return [];
    },
    async execute() { throw new Error("no write expected"); },
  };
  const repository = new MySqlScoliaBridgeRepository(new FakeSessions(db), "bd_test_", "bd_prod_");
  await assert.rejects(
    () => repository.enqueueEvent("SCOLIA-7", { id: "evt-2", type: "THROW_DETECTED", payload: {} }),
    (error) => error?.code === "scolia_test_lease_required" && error?.statusCode === 409,
  );
});
