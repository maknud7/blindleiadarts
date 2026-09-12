import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { loadRuntimeConfig } from "../dist/runtime/config.js";
import { ScoliaRuntimeRouter } from "../dist/runtime/scolia-runtime-router.js";

function config() {
  return loadRuntimeConfig({
    DB_HOST: "db.example.test",
    DB_NAME: "blindleia",
    DB_USERNAME: "test",
    DB_PASSWORD: "test",
    BD_BACKEND_V2_INTERNAL_TOKEN: "internal-test-token",
    BD_BACKEND_V2_MAX_CONNECTIONS: "1",
    BD_APP_ENV: "test",
    BD_BACKEND_V2_MODE: "test-write",
    DB_TABLE_PREFIX: "bd_test_",
    IDENTITY_TABLE_PREFIX: "bd_prod_",
    HARDWARE_TABLE_PREFIX: "bd_prod_",
  });
}

function snapshot(overrides = {}) {
  return {
    physical_status: {
      status: "Ready",
      age_seconds: 2,
      event_type: "SBC_STATUS_CHANGED",
      received_at: "2026-09-12 13:00:00.000",
    },
    bridge_heartbeat_age_seconds: 3,
    last_status_probe_age_seconds: 2,
    match_id: "91",
    last_visit: {
      id: "700000000000000001",
      match_id: "91",
      source: "scolia",
      darts: [],
    },
    latest_canonical_visit: {
      id: "700000000000000001",
      match_id: "91",
      source: "scolia",
    },
    buffer: null,
    queue: { queued: 0, processing: 0, processed: 1, ignored: 0, failed: 0, dead_letter: 0 },
    ...overrides,
  };
}

function routerWith({ uiSnapshot = snapshot(), board = {}, queueCommand } = {}) {
  const commands = {
    async kioskUiSnapshot() { return uiSnapshot; },
    async queueCommand(...args) {
      if (queueCommand) return queueCommand(...args);
      return { id: "1", type: String(args[2]) };
    },
  };
  const scoliaAdmin = {
    async getBoardSettings() {
      return {
        id: "17",
        mode: "live",
        connection_state: "connected",
        board_status: "Ready",
        fallback_active: 0,
        needs_reconciliation: 0,
        auto_fallback_to_manual: 1,
        ...board,
      };
    },
  };
  const kioskAuth = {
    async resolve() { return { club_id: "11", kiosk_id: "17", code: "BOARD" }; },
  };
  return new ScoliaRuntimeRouter(
    config(),
    {},
    commands,
    {},
    kioskAuth,
    {},
    scoliaAdmin,
  );
}

function request() {
  return { headers: { "x-kiosk-pairing-token": "paired" } };
}

test("Scolia kiosk status fails closed when the physical status is stale", async () => {
  const router = routerWith({
    uiSnapshot: snapshot({
      physical_status: {
        status: "Ready",
        age_seconds: 13,
        event_type: "SBC_STATUS_CHANGED",
        received_at: "2026-09-12 13:00:00.000",
      },
    }),
  });

  const state = await router.kioskUiState("11", "17");
  assert.equal(state.board.effective_scoring_mode, "scolia");
  assert.equal(state.board.physical_status_fresh, false);
  assert.equal(state.board.physical_available, false);
  assert.equal(state.board.board_status, "Offline");
});

test("Scolia kiosk status exposes a fresh physical board and preserves BIGINT ids as strings", async () => {
  const router = routerWith();
  const state = await router.kioskUiState("11", "17");
  assert.equal(state.board.physical_available, true);
  assert.equal(state.board.board_status, "Ready");
  assert.equal(state.last_visit.id, "700000000000000001");
});

test("GET status rate-limits physical status probes", async () => {
  let queued = 0;
  const router = routerWith({
    uiSnapshot: snapshot({ last_status_probe_age_seconds: 2 }),
    queueCommand: async () => { queued += 1; return { id: "1" }; },
  });
  const result = await router.handle("GET", "/v1/kiosks/BOARD/scolia/status", request());
  assert.equal(result.statusCode, 200);
  assert.equal(queued, 0);
});

test("Scolia undo refuses to remove a latest manual visit", async () => {
  const router = routerWith({
    uiSnapshot: snapshot({
      last_visit: null,
      latest_canonical_visit: { id: "44", match_id: "91", source: "manual" },
    }),
  });
  await assert.rejects(
    () => router.handle("POST", "/v1/kiosks/BOARD/scolia/undo", request()),
    (error) => error?.code === "latest_visit_not_scolia" && error?.statusCode === 409,
  );
});

test("kiosk Scolia frontend calls backend-v2 directly", () => {
  const source = fs.readFileSync("apps/kiosk/scolia-live-ux.js", "utf8");
  assert.doesNotMatch(source, /kiosk-scolia-ui\.php/);
  assert.match(source, /\/kiosks\/\$\{encodeURIComponent\(code\)\}\/scolia\/\$\{encodeURIComponent\(action\)\}/);
  assert.match(source, /request\("status"\)/);
  assert.match(source, /request\("undo", \{ method: "POST"/);
});
