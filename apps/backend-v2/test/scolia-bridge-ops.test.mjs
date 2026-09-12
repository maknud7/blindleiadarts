import assert from "node:assert/strict";
import test from "node:test";

import { MySqlScoliaBridgeRepository } from "../dist/mysql/scolia-bridge-repository.js";

class FakeSessions {
  constructor(db) { this.db = db; }
  async withConnection(callback) { return callback(this.db); }
  async withTransaction(callback) { return callback(this.db); }
}

test("bridge router activates canonical tournament boards without writing", async () => {
  const queries = [];
  const db = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes("FROM `bd_prod_tournaments`")) return [{ club_id: "1", tournament_active: 1, next_start_at: null, next_activation_seconds: null }];
      if (sql.includes("FROM `bd_prod_scolia_board_settings`")) return [{ physical_kiosk_id: "7", club_id: "1", code: "board-7", name: "Board 7", board_number: 7, serial_number: "SERIAL-7", mode: "live", auto_fallback_to_manual: 1, force_connect_override: null, forward_messages_override: null, access_token: "secret", force_connect: 1, forward_messages_to_scolia: 0, disconnect_fallback_enabled: 1, test_kiosk_id: null, expires_at: null, active_test_kiosk_id: null }];
      return [];
    },
    async execute() { throw new Error("bridge router is read-only"); },
  };
  const repo = new MySqlScoliaBridgeRepository(new FakeSessions(db), "bd_prod_", "bd_prod_");
  const state = await repo.bridgeRouterState();
  assert.equal(state.bridge_mode, "active");
  assert.equal(state.configured_boards, 1);
  assert.equal(state.active_tournament_clubs, 1);
  assert.equal(state.boards.length, 1);
  assert.equal(state.boards[0].environment, "prod");
  assert.equal(state.boards[0].kiosk_id, "7");
  assert.equal(state.boards[0].access_token, "secret");
  assert.ok(queries.some((sql) => sql.includes("LEFT JOIN `bd_test_kiosks`")));
});

test("bridge router sends a leased physical board only to TEST runtime alias", async () => {
  const db = {
    async query(sql) {
      if (sql.includes("FROM `bd_prod_tournaments`")) return [{ club_id: "1", tournament_active: 0, next_start_at: null, next_activation_seconds: null }];
      if (sql.includes("FROM `bd_prod_scolia_board_settings`")) return [{ physical_kiosk_id: "7", club_id: "1", code: "prod-7", name: "Prod 7", board_number: 7, serial_number: "SERIAL-7", mode: "live", auto_fallback_to_manual: 1, force_connect_override: null, forward_messages_override: null, access_token: "secret", force_connect: 0, forward_messages_to_scolia: 0, disconnect_fallback_enabled: 1, test_kiosk_id: "17", expires_at: "2099-01-01 00:00:00", active_test_kiosk_id: "17", test_code: "test-17", test_name: "Test 17", test_board_number: 17 }];
      return [];
    },
    async execute() { throw new Error("bridge router is read-only"); },
  };
  const repo = new MySqlScoliaBridgeRepository(new FakeSessions(db), "bd_test_", "bd_prod_");
  const state = await repo.bridgeRouterState();
  assert.equal(state.active_test_leases, 1);
  assert.equal(state.boards.length, 1);
  assert.equal(state.boards[0].environment, "test");
  assert.equal(state.boards[0].kiosk_id, "17");
  assert.equal(state.boards[0].physical_kiosk_id, "7");
  assert.equal(state.boards[0].force_connect, 1);
  assert.equal(state.boards[0].activation_reason, "test_lease");
});

test("bridge health reads the active runtime prefix and reports fresh connectivity", async () => {
  const queries = [];
  const db = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes("FROM `bd_prod_tournaments`")) return [{ club_id: "1", tournament_active: 0, next_start_at: null }];
      if (sql.includes("FROM `bd_prod_scolia_board_settings`")) return [{ physical_kiosk_id: "7", club_id: "1", board_number: 7, name: "Prod 7", test_kiosk_id: "17", expires_at: "2099-01-01 00:00:00" }];
      if (sql.includes("FROM `bd_test_scolia_board_runtime`")) return [{ connection_state: "connected", board_status: "Ready", board_phase: "Throw", error_type: null, fallback_active: 0, needs_reconciliation: 0, last_bridge_heartbeat_at: "2099-01-01 00:00:00", last_event_at: "2099-01-01 00:00:00", heartbeat_age_seconds: 5 }];
      return [];
    },
    async execute() { throw new Error("bridge health is read-only"); },
  };
  const repo = new MySqlScoliaBridgeRepository(new FakeSessions(db), "bd_test_", "bd_prod_");
  const state = await repo.bridgeHealthState(true);
  assert.equal(state.bridge_status, "online");
  assert.equal(state.bridge_required, true);
  assert.equal(state.connected_boards, 1);
  assert.equal(state.active_test_leases, 1);
  assert.equal(state.boards[0].route, "test");
  assert.equal(state.boards[0].heartbeat_fresh, true);
  assert.ok(queries.some((sql) => sql.includes("FROM `bd_test_scolia_board_runtime`")));
});
