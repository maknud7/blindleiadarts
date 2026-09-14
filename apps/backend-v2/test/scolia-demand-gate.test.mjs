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

function liveBoardSettings() {
  return {
    mode: "live",
    connection_state: "connected",
    fallback_active: 0,
    needs_reconciliation: 0,
  };
}

function freshUiSnapshot(matchId) {
  return {
    match_id: matchId,
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
}

function bridgeRequest() {
  return request({ "x-bd-backend-v2-token": "bridge-secret" });
}

test("bridge desired-state keeps only active scoring boards plus uncontested explicit TEST leases", async () => {
  const scoringLookups = [];
  const bridge = {
    async bridgeRouterState() {
      return {
        boards: [
          { kiosk_id: "1", club_id: "10", serial_number: "ACTIVE", activation_reason: "tournament" },
          { kiosk_id: "2", club_id: "10", serial_number: "IDLE", activation_reason: "tournament" },
          { kiosk_id: "17", physical_kiosk_id: "7", club_id: "11", serial_number: "TEST", activation_reason: "test_lease" },
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
  const commands = {
    async kioskUiSnapshot() { return freshUiSnapshot(null); },
  };

  const router = routerWith({ bridge, commands });
  const result = await router.handle("GET", "/v1/scolia/bridge/router", bridgeRequest());

  assert.equal(result?.statusCode, 200);
  assert.equal(result?.payload.data.activation_policy, "active_scoring_match_or_uncontested_test_lease");
  assert.equal(result?.payload.data.bridge_mode, "active");
  assert.equal(result?.payload.data.prewarm_minutes, 0);
  assert.equal(result?.payload.data.next_activation_in_seconds, null);
  assert.equal(result?.payload.data.preempted_test_leases, 0);
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

test("later PROD reservation preempts an existing TEST lease before physical routing", async () => {
  const bridge = {
    async bridgeRouterState() {
      return {
        boards: [{
          kiosk_id: "17",
          physical_kiosk_id: "7",
          club_id: "11",
          serial_number: "TEST",
          target_api_base: "https://test.blindleiadart.ingenting.org/api/v1",
          environment: "test",
          activation_reason: "test_lease",
        }],
      };
    },
    async scoringContext() { return null; },
  };
  const commands = {
    async kioskUiSnapshot(clubId, kioskId) {
      assert.equal(clubId, "11");
      assert.equal(kioskId, "7");
      return freshUiSnapshot("501");
    },
  };

  const router = routerWith({ bridge, commands });
  const result = await router.handle("GET", "/v1/scolia/bridge/router", bridgeRequest());

  assert.deepEqual(result?.payload.data.boards, []);
  assert.equal(result?.payload.data.bridge_mode, "idle");
  assert.equal(result?.payload.data.preempted_test_leases, 1);
});

test("later active PROD scoring takes ownership back from a TEST lease", async () => {
  const bridge = {
    async bridgeRouterState() {
      return {
        boards: [{
          kiosk_id: "17",
          physical_kiosk_id: "7",
          club_id: "11",
          serial_number: "TEST",
          target_api_base: "https://test.blindleiadart.ingenting.org/api/v1",
          environment: "test",
          activation_reason: "test_lease",
        }],
      };
    },
    async scoringContext(kioskId) {
      assert.equal(kioskId, "7");
      return { match_id: "502", player_id: "9", remaining: 301 };
    },
  };
  const commands = {
    async kioskUiSnapshot() { return freshUiSnapshot("502"); },
  };

  const router = routerWith({ bridge, commands });
  const result = await router.handle("GET", "/v1/scolia/bridge/router", bridgeRequest());
  const [board] = result?.payload.data.boards ?? [];

  assert.equal(result?.payload.data.preempted_test_leases, 1);
  assert.equal(result?.payload.data.active_match_boards, 1);
  assert.equal(board.kiosk_id, "7");
  assert.equal(board.environment, "prod");
  assert.equal(board.activation_reason, "active_scoring_match");
  assert.equal(board.match_id, "502");
  assert.equal(board.test_lease_preempted, true);
  assert.equal(board.target_api_base, "https://blindleiadart.ingenting.org/api/v1");
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
      async getBoardSettings() { return liveBoardSettings(); },
    },
    commands: {
      async kioskUiSnapshot() { return freshUiSnapshot(null); },
      async queueCommand() { queued += 1; },
    },
  });

  const result = await router.handle("GET", "/v1/kiosks/BOARD-2/scolia/status", request());
  assert.equal(result?.statusCode, 200);
  assert.equal(result?.payload.match_id, null);
  assert.equal(queued, 0);
});

test("active match status read may enqueue the rate-limited physical probe", async () => {
  const queued = [];
  const router = routerWith({
    bridge: {},
    kioskAuth: {
      async resolve() { return { club_id: "10", kiosk_id: "2" }; },
    },
    scoliaAdmin: {
      async getBoardSettings() { return liveBoardSettings(); },
    },
    commands: {
      async kioskUiSnapshot() { return freshUiSnapshot("9007199254740993"); },
      async queueCommand(clubId, kioskId, type, payload) {
        queued.push({ clubId, kioskId, type, payload });
        return { id: "1" };
      },
    },
  });

  const result = await router.handle("GET", "/v1/kiosks/BOARD-2/scolia/status", request());
  assert.equal(result?.statusCode, 200);
  assert.equal(result?.payload.match_id, "9007199254740993");
  assert.deepEqual(queued, [{ clubId: "10", kioskId: "2", type: "GET_SBC_STATUS", payload: {} }]);
});
