import assert from "node:assert/strict";
import test from "node:test";

import { ScoliaRuntimeRouter } from "../dist/runtime/scolia-runtime-router.js";

function request(headers = {}) {
  return { headers };
}

function routerWith({ bridge, commands = {}, kioskAuth = {}, scoliaAdmin = {}, kioskRuntime = {}, processor = {} }) {
  return new ScoliaRuntimeRouter(
    {
      environment: "production",
      internalToken: "bridge-secret",
    },
    bridge,
    commands,
    processor,
    kioskAuth,
    kioskRuntime,
    scoliaAdmin,
  );
}

test("bridge desired-state keeps only active scoring boards plus explicit TEST leases", async () => {
  const scoringLookups = [];
  const bridge = {
    async bridgeRouterState() {
      return {
        boards: [
          { kiosk_id: "1", club_id: "10", serial_number: "ACTIVE", activation_reason: "tournament" },
          { kiosk_id: "2", club_id: "10", serial_number: "IDLE", activation_reason: "tournament" },
          { kiosk_id: "17", club_id: "11", serial_number: "TEST", activation_reason: "test_lease" },
        ],
        bridge_mode: "active",
        prewarm_minutes: 30,
        late_start_grace_hours: 8,
        next_activation_in_seconds: 120,
      };
    },
    async scoringContext(kioskId) {
      scoringLookups.push(kioskId);
      return kioskId === "1"
        ? { match_id: "9007199254740993", player_id: "7", remaining: 501 }
        : null;
    },
  };

  const router = routerWith({ bridge });
  const result = await router.handle(
    "GET",
    "/v1/scolia/bridge/router",
    request({ "x-bd-backend-v2-token": "bridge-secret" }),
  );

  assert.equal(result?.statusCode, 200);
  assert.equal(result?.payload.data.activation_policy, "active_scoring_match_or_test_lease");
  assert.equal(result?.payload.data.bridge_mode, "active");
  assert.equal(result?.payload.data.prewarm_minutes, 0);
  assert.equal(result?.payload.data.next_activation_in_seconds, null);
  assert.deepEqual(scoringLookups, ["1", "2"]);
  assert.deepEqual(
    result?.payload.data.boards.map((board) => ({
      serial_number: board.serial_number,
      activation_reason: board.activation_reason,
      match_id: board.match_id ?? null,
    })),
    [
      { serial_number: "ACTIVE", activation_reason: "active_scoring_match", match_id: "9007199254740993" },
      { serial_number: "TEST", activation_reason: "test_lease", match_id: null },
    ],
  );
});

test("club-wide tournament demand cannot keep an idle physical Scolia socket alive", async () => {
  const bridge = {
    async bridgeRouterState() {
      return {
        boards: [{ kiosk_id: "2", club_id: "10", serial_number: "IDLE", activation_reason: "tournament" }],
        bridge_mode: "active",
      };
    },
    async scoringContext() { return null; },
  };
  const router = routerWith({ bridge });
  const result = await router.handle(
    "GET",
    "/v1/scolia/bridge/router",
    request({ "x-scolia-bridge-secret": "bridge-secret" }),
  );

  assert.deepEqual(result?.payload.data.boards, []);
  assert.equal(result?.payload.data.bridge_mode, "idle");
  assert.equal(result?.payload.data.active_match_boards, 0);
});

test("idle kiosk status read stays passive and does not enqueue a physical probe", async () => {
  let queued = 0;
  const router = routerWith({
    bridge: {},
    kioskAuth: {
      async resolve() { return { club_id: "10", kiosk_id: "2" }; },
    },
    scoliaAdmin: {
      async getBoardSettings() {
        return {
          mode: "live",
          connection_state: "connected",
          fallback_active: 0,
          needs_reconciliation: 0,
        };
      },
    },
    commands: {
      async kioskUiSnapshot() {
        return {
          match_id: null,
          buffer: {},
          queue: {},
          last_visit: null,
          latest_canonical_visit: null,
          last_status_probe_age_seconds: 30,
          bridge_heartbeat_age_seconds: 1,
          physical_status: {
            status: "Ready",
            event_type: "SBC_STATUS_CHANGED",
            received_at: "2026-09-14T08:00:00Z",
            age_seconds: 1,
          },
        };
      },
      async queueCommand() { queued += 1; },
    },
  });

  const result = await router.handle("GET", "/v1/kiosks/BOARD-2/scolia/status", request());
  assert.equal(result?.statusCode, 200);
  assert.equal(result?.payload.match_id, null);
  assert.equal(queued, 0);
});
