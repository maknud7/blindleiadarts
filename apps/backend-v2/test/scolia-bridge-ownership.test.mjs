import assert from "node:assert/strict";
import test from "node:test";

import { MySqlScoliaAdminRepository } from "../dist/mysql/scolia-admin-repository.js";

class FakeSessions {
  constructor(db) { this.db = db; }
  async withConnection(callback) { return callback(this.db); }
  async withTransaction(callback) { return callback(this.db); }
}

function fakeProdDb() {
  let mode = "live";
  let runtimeState = "connected";
  const executed = [];
  return {
    executed,
    async query(sql) {
      if (sql.includes("FROM `bd_prod_kiosks` WHERE id=? AND club_id=?")) return [{ id: "7" }];
      if (sql.includes("FROM `bd_prod_kiosks` k") && sql.includes("scolia_board_settings")) {
        return [{
id: "7", club_id: "1", code: "BOARD-7", name: "Skive 7", board_number: 7,
scoring_mode: "scolia", is_active: 1, serial_number: "SCOLIA-7", mode,
auto_fallback_to_manual: 1, force_connect_override: null, forward_messages_override: null,
        }];
      }
      if (sql.includes("FROM `bd_prod_scolia_board_runtime`")) {
        return [{ connection_state: runtimeState, fallback_active: 0, needs_reconciliation: 0 }];
      }
      if (sql.includes("FROM `bd_prod_matches`")) return [];
      return [];
    },
    async execute(sql, params = []) {
      executed.push({ sql, params });
      if (sql.includes("UPDATE `bd_prod_scolia_board_settings` SET mode=")) {
        mode = String(params[0]);
        return { affectedRows: 1, insertId: 0 };
      }
      if (sql.includes("scolia_board_runtime") && sql.includes("'disabled'")) runtimeState = "disabled";
      return { affectedRows: 1, insertId: 0 };
    },
  };
}

test("release changes bridge ownership without changing physical scoring mode", async () => {
  const db = fakeProdDb();
  const repository = new MySqlScoliaAdminRepository(new FakeSessions(db), "bd_prod_", "bd_prod_");
  const board = await repository.updateBoardSettings("1", "7", { bridge_attached: false }, "99");

  assert.equal(board?.scoring_mode, "scolia");
  assert.equal(board?.mode, "off");
  assert.equal(board?.bridge_released, true);
  assert.equal(board?.direct_scolia_ready, true);
  assert.equal(board?.can_change_bridge, true);
  assert.equal(board?.bridge_changed, true);
  assert.ok(db.executed.some(({ sql }) => sql.includes("scolia_test_leases")));
  assert.ok(db.executed.some(({ sql }) => sql.includes("scolia_commands") && sql.includes("status='expired'")));
  assert.ok(!db.executed.some(({ sql }) => sql.includes("UPDATE `bd_prod_kiosks` SET scoring_mode")));
});

test("TEST-style split scope exposes release as read-only", async () => {
  const db = fakeProdDb();
  const repository = new MySqlScoliaAdminRepository(new FakeSessions(db), "bd_test_", "bd_prod_");
  db.query = async (sql) => {
    if (sql.includes("FROM `bd_test_clubs`")) return [{ slug: "blindleia-dartklubb" }];
    if (sql.includes("FROM `bd_prod_clubs`")) return [{ id: "1" }];
    if (sql.includes("FROM `bd_test_kiosks`")) return [{ id: "17", source_kiosk_id: "7" }];
    if (sql.includes("FROM `bd_prod_kiosks` k")) return [{
      id: "7", club_id: "1", code: "BOARD-7", name: "Skive 7", board_number: 7,
      scoring_mode: "scolia", is_active: 1, serial_number: "SCOLIA-7", mode: "live",
      auto_fallback_to_manual: 1,
    }];
    if (sql.includes("FROM `bd_test_scolia_board_runtime`")) return [];
    return [];
  };
  const board = await repository.getBoardSettings("1", "17");
  assert.equal(board?.physical_kiosk_id, "7");
  assert.equal(board?.runtime_kiosk_id, "17");
  assert.equal(board?.bridge_attached, true);
  assert.equal(board?.can_change_bridge, false);
});
