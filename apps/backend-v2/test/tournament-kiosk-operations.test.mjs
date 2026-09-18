import assert from "node:assert/strict";
import test from "node:test";

import { TournamentOperationsLegacyRouter } from "../dist/runtime/tournament-operations-legacy-router.js";

function config() {
  return {
    environment: "test",
    mode: "test-write",
    host: "127.0.0.1",
    port: 18082,
    releaseSha: "test",
    internalToken: "test-token",
    prodCanaryWritesEnabled: false,
    canonicalSideEffectsReady: true,
    prefixes: { runtime: "bd_test_", identity: "bd_prod_", hardware: "bd_prod_" },
    mysql: {
      host: "localhost",
      port: 3306,
      database: "test",
      username: "test",
      password: "test",
      connectTimeoutMs: 1000,
      idleConnectionTimeoutMs: 1000,
      budget: { maxConcurrentConnections: 1, acquireTimeoutMs: 1000 },
    },
    realtime: {
      websocketUrl: null,
      publishUrl: null,
      publishSecret: null,
      timeoutMs: 1000,
      publishEnabled: false,
    },
  };
}

function request(method, path, token = "pair-token") {
  return {
    method,
    url: path,
    headers: { "x-kiosk-pairing-token": token },
    async *[Symbol.asyncIterator]() {},
  };
}

function fixture() {
  const calls = [];
  const kioskAuth = {
    async resolveScoring(code, token, touch) {
      calls.push(["resolve", code, token, touch]);
      return { kiosk_id: "90071992547409931", club_id: "7", code: "BOARD-1" };
    },
    async scoringSnapshot(kioskId) {
      calls.push(["snapshot", kioskId]);
      return {
        kiosk: { id: kioskId, code: "BOARD-1", club: { id: "7", name: "Blindleia" } },
        state: "assigned",
      };
    },
  };
  let postReads = 0;
  const operations = {
    async kioskPostMatch(kioskId) {
      calls.push(["post-match", kioskId]);
      postReads += 1;
      return postReads === 1
        ? {
            active_match: false,
            last_completed_match: { id: "90071992547409941" },
            reservation: null,
            remaining_seconds: 12,
            result_display_seconds: 30,
          }
        : {
            active_match: false,
            last_completed_match: { id: "90071992547409941" },
            reservation: { id: "90071992547409951", match_id: "90071992547409961" },
            remaining_seconds: 12,
            result_display_seconds: 30,
          };
    },
    async reserveNextForKiosk(kioskId) {
      calls.push(["reserve", kioskId]);
      return { reserved: true };
    },
    async releaseReservationForKiosk(kioskId) {
      calls.push(["release", kioskId]);
    },
    async assignNextToKiosk(kioskId) {
      calls.push(["assign", kioskId]);
      return {
        assigned: true,
        reason: null,
        match: { id: "90071992547409961", kiosk_id: kioskId },
        reservation: null,
      };
    },
  };
  const realtime = {
    async publishClubRefresh(clubId, event) {
      calls.push(["publish", clubId, event]);
    },
  };
  const router = new TournamentOperationsLegacyRouter(
    config(),
    {},
    operations,
    {},
    {},
    realtime,
    kioskAuth,
  );
  return { router, calls };
}

test("post-match uses pairing auth and reserves the next match during result hold", async () => {
  const { router, calls } = fixture();
  const result = await router.handle(
    "GET",
    "/v1/kiosks/BOARD-1/post-match",
    request("GET", "/v1/kiosks/BOARD-1/post-match"),
  );

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.reservation.id, "90071992547409951");
  assert.deepEqual(calls, [
    ["resolve", "BOARD-1", "pair-token", true],
    ["post-match", "90071992547409931"],
    ["reserve", "90071992547409931"],
    ["post-match", "90071992547409931"],
  ]);
});

test("next-match assigns once, returns canonical kiosk state and publishes refresh", async () => {
  const { router, calls } = fixture();
  const result = await router.handle(
    "POST",
    "/v1/kiosks/BOARD-1/next-match",
    request("POST", "/v1/kiosks/BOARD-1/next-match"),
  );

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.assignment.assigned, true);
  assert.equal(result.payload.assignment.match.id, "90071992547409961");
  assert.equal(result.payload.state.kiosk.id, "90071992547409931");
  assert.deepEqual(calls, [
    ["resolve", "BOARD-1", "pair-token", true],
    ["assign", "90071992547409931"],
    ["snapshot", "90071992547409931"],
    ["publish", "7", "board_ready_for_next_match"],
  ]);
});

test("release-next-match deletes only the current kiosk reservation", async () => {
  const { router, calls } = fixture();
  const result = await router.handle(
    "POST",
    "/v1/kiosks/BOARD-1/release-next-match",
    request("POST", "/v1/kiosks/BOARD-1/release-next-match"),
  );

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.released, true);
  assert.deepEqual(calls, [
    ["resolve", "BOARD-1", "pair-token", true],
    ["release", "90071992547409931"],
  ]);
});

test("kiosk operation router ignores unsupported methods", async () => {
  const { router, calls } = fixture();
  assert.equal(
    await router.handle(
      "POST",
      "/v1/kiosks/BOARD-1/post-match",
      request("POST", "/v1/kiosks/BOARD-1/post-match"),
    ),
    null,
  );
  assert.equal(
    await router.handle(
      "GET",
      "/v1/kiosks/BOARD-1/next-match",
      request("GET", "/v1/kiosks/BOARD-1/next-match"),
    ),
    null,
  );
  assert.deepEqual(calls, []);
});
