import assert from "node:assert/strict";
import test from "node:test";

import { MySqlScoliaKioskRuntimeRepository } from "../dist/mysql/scolia-kiosk-runtime-repository.js";

class FakeSessions {
  constructor(db) { this.db = db; }
  async withConnection(callback) { return callback(this.db); }
  async withTransaction(callback) { return callback(this.db); }
}

function fakeDb({ conflictingLease = false } = {}) {
  const executes = [];
  const queries = [];
  return {
    executes,
    queries,
    async execute(sql, params = []) {
      executes.push({ sql, params });
      return { affectedRows: 1 };
    },
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM `bd_test_kiosks` k") && sql.includes("source_kiosk_id")) {
        return [{ id: "17", club_id: "11", source_kiosk_id: "7", slug: "blindleia" }];
      }
      if (sql.includes("FROM `bd_prod_kiosks` k") && sql.includes("club_scolia_enabled")) {
        return [{
          id: "7",
          club_id: "3",
          board_number: 4,
          scoring_mode: "scolia",
          club_slug: "blindleia",
          serial_number: "ABC-123",
          mode: "live",
          auto_fallback_to_manual: 1,
          club_scolia_enabled: 1,
          access_token: "configured-secret",
        }];
      }
      if (sql.includes("FROM `bd_prod_scolia_test_leases`") && sql.includes("FOR UPDATE")) {
        return conflictingLease ? [{ physical_kiosk_id: "7", test_kiosk_id: "99" }] : [];
      }
      return [];
    },
  };
}

test("TEST lease acquire writes only ephemeral TEST runtime plus canonical lease row", async () => {
  const db = fakeDb();
  const repo = new MySqlScoliaKioskRuntimeRepository(new FakeSessions(db), "bd_test_", "bd_prod_");

  const result = await repo.acquireTestLease("11", "17", "7");
  assert.equal(result.leased, true);
  assert.equal(result.physical_kiosk_id, "7");
  assert.equal(result.test_kiosk_id, "17");
  assert.equal(result.serial_number, "ABC-123");

  const sql = db.executes.map((entry) => entry.sql).join("\n");
  assert.match(sql, /INSERT INTO `bd_prod_scolia_test_leases`/);
  assert.match(sql, /INSERT INTO `bd_test_scolia_board_settings`/);
  assert.match(sql, /VALUES \(\?,NULL,'live'/);
  assert.match(sql, /UPDATE `bd_test_kiosks` SET scoring_mode='scolia'/);
  assert.doesNotMatch(sql, /UPDATE `bd_prod_kiosks`/);
  assert.doesNotMatch(sql, /INSERT INTO `bd_prod_scolia_board_settings`/);
  assert.doesNotMatch(sql, /UPDATE `bd_prod_scolia_board_settings`/);
});

test("TEST lease acquire refuses a lease owned by another test terminal", async () => {
  const db = fakeDb({ conflictingLease: true });
  const repo = new MySqlScoliaKioskRuntimeRepository(new FakeSessions(db), "bd_test_", "bd_prod_");

  await assert.rejects(
    () => repo.acquireTestLease("11", "17", "7"),
    (error) => error?.code === "scolia_board_already_leased" && error?.statusCode === 409,
  );
  assert.equal(db.executes.some((entry) => entry.sql.includes("INSERT INTO `bd_prod_scolia_test_leases`")), false);
});

test("TEST lease release removes lease and TEST runtime without changing PROD master data", async () => {
  const db = fakeDb();
  const repo = new MySqlScoliaKioskRuntimeRepository(new FakeSessions(db), "bd_test_", "bd_prod_");

  const result = await repo.releaseTestLease("11", "17", "7");
  assert.equal(result.released, true);

  const sql = db.executes.map((entry) => entry.sql).join("\n");
  assert.match(sql, /DELETE FROM `bd_prod_scolia_test_leases`/);
  assert.match(sql, /DELETE FROM `bd_test_scolia_board_settings`/);
  assert.match(sql, /UPDATE `bd_test_kiosks` SET scoring_mode='manual'/);
  assert.doesNotMatch(sql, /UPDATE `bd_prod_kiosks`/);
  assert.doesNotMatch(sql, /bd_prod_scolia_board_settings/);
});

test("TEST lease is unavailable when runtime and hardware scopes are identical", async () => {
  const db = fakeDb();
  const repo = new MySqlScoliaKioskRuntimeRepository(new FakeSessions(db), "bd_test_", "bd_test_");
  await assert.rejects(
    () => repo.acquireTestLease("11", "17", "7"),
    (error) => error?.code === "scolia_test_lease_test_only" && error?.statusCode === 404,
  );
});
