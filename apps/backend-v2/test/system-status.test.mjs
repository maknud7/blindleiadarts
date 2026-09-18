import assert from "node:assert/strict";
import test from "node:test";

import { SystemStatusRouter } from "../dist/runtime/system-status-router.js";

function config() {
  return {
    environment: "test",
    mode: "test-write",
    host: "127.0.0.1",
    port: 18082,
    releaseSha: "test",
    internalToken: "internal",
    prodCanaryWritesEnabled: false,
    canonicalSideEffectsReady: true,
    prefixes: { runtime: "bd_test_", identity: "bd_prod_", hardware: "bd_prod_" },
    mysql: {
      host: "localhost", port: 3306, database: "test", username: "test", password: "test",
      connectTimeoutMs: 1000, idleConnectionTimeoutMs: 1000,
      budget: { maxConcurrentConnections: 1, acquireTimeoutMs: 1000 },
    },
    realtime: {
      websocketUrl: "wss://example.invalid/realtime",
      publishUrl: null,
      publishSecret: null,
      timeoutMs: 1000,
      publishEnabled: false,
    },
  };
}

function request(url = "/v1/system/status", authorization = "Bearer admin-session") {
  return {
    url,
    headers: authorization === null ? {} : { authorization },
  };
}

function fixture({ role = "super_admin", playerClubId = null } = {}) {
  const touches = [];
  const identity = {
    async findBySessionToken(token, touchSession) {
      touches.push(touchSession);
      if (token !== "admin-session") return null;
      return {
        id: "7",
        email: "admin@example.invalid",
        display_name: "Admin",
        role,
        is_active: 1,
        account_status: "active",
        contact_phone: null,
        player_id: null,
        player_display_name: null,
        player_club_id: playerClubId,
        member_id: null,
        admin_club_ids: playerClubId,
        global_roles: "",
      };
    },
  };
  const calls = [];
  const clubs = {
    async ping() { calls.push("ping"); return true; },
    async list() {
      calls.push("clubs");
      return [
        { id: "90071992547409930", name: "Blindleia Dartklubb" },
        { id: "90071992547409931", name: "Klubb 2" },
      ];
    },
    async findById(id) {
      calls.push(`club:${id}`);
      return { id, name: "Blindleia Dartklubb", slug: "blindleia-dartklubb" };
    },
  };
  const tournaments = {
    async getClubDashboard(id) {
      calls.push(`dashboard:${id}`);
      return { club: { id }, players: [], kiosks: [], tournaments: [], recent_matches: [] };
    },
    async findScreenTournamentByClubId(id) {
      calls.push(`screen-tournament:${id}`);
      return { id: "90071992547409940", club_id: id, name: "Mandagsserien", status: "in_progress" };
    },
  };
  const equipment = {
    async listAllPendingPairingRequests() {
      calls.push("pairings:all");
      return [{ id: "1", club_id: "90071992547409931" }];
    },
    async listPendingPairingRequests(id) {
      calls.push(`pairings:${id}`);
      return [
        { id: "1", club_id: id },
        { id: "2", club_id: null },
      ];
    },
  };
  const scoliaDashboard = {
    async listScreenDevices(id) {
      calls.push(`screens:${id}`);
      return [{ id: "90071992547409950", club_id: id, label: "TV" }];
    },
  };
  return {
    router: new SystemStatusRouter(config(), identity, clubs, tournaments, equipment, scoliaDashboard),
    touches,
    calls,
  };
}

test("system status is read-only and does not touch shared PROD identity session", async () => {
  const { router, touches, calls } = fixture();
  const result = await router.handle("GET", "/v1/system/status", request());

  assert.equal(result?.statusCode, 200);
  assert.equal(result?.payload.ok, true);
  assert.equal(result?.payload.environment, "test");
  assert.equal(result?.payload.summary.clubs, 2);
  assert.equal(result?.payload.summary.pending_pairing_requests, 1);
  assert.equal(result?.payload.club, null);
  assert.deepEqual(touches, [false]);
  assert.deepEqual(calls, ["ping", "clubs", "pairings:all"]);
});

test("system status preserves exact BIGINT club ids and legacy club scope", async () => {
  const clubId = "90071992547409931";
  const { router, touches, calls } = fixture({ role: "club_admin", playerClubId: clubId });
  const result = await router.handle(
    "GET",
    "/v1/system/status",
    request(`/v1/system/status?club_id=${clubId}`),
  );

  assert.equal(result?.statusCode, 200);
  assert.equal(result?.payload.club.club.id, clubId);
  assert.equal(result?.payload.club.dashboard.club.id, clubId);
  assert.equal(result?.payload.club.active_screen_tournament.club_id, clubId);
  assert.equal(result?.payload.club.pending_pairing_requests, 1);
  assert.equal(result?.payload.club.screen_devices[0].club_id, clubId);
  assert.deepEqual(touches, [false]);
  assert.deepEqual(calls, [
    "ping",
    "clubs",
    "pairings:all",
    `club:${clubId}`,
    `dashboard:${clubId}`,
    `screen-tournament:${clubId}`,
    `pairings:${clubId}`,
    `screens:${clubId}`,
  ]);
});

test("system status rejects an out-of-scope club before runtime reads", async () => {
  const { router, touches, calls } = fixture({ role: "club_admin", playerClubId: "42" });
  await assert.rejects(
    router.handle("GET", "/v1/system/status", request("/v1/system/status?club_id=43")),
    (error) => error?.code === "club_admin_scope_denied" && error?.statusCode === 403,
  );
  assert.deepEqual(touches, [false]);
  assert.deepEqual(calls, []);
});

test("system status preserves admin authentication errors", async () => {
  const { router, calls } = fixture();
  await assert.rejects(
    router.handle("GET", "/v1/system/status", request("/v1/system/status", null)),
    (error) => error?.code === "missing_bearer_token" && error?.statusCode === 401,
  );
  assert.deepEqual(calls, []);
});

test("system status router ignores unrelated routes and methods", async () => {
  const { router, touches, calls } = fixture();
  assert.equal(await router.handle("POST", "/v1/system/status", request()), null);
  assert.equal(await router.handle("GET", "/v1/clubs", request()), null);
  assert.deepEqual(touches, []);
  assert.deepEqual(calls, []);
});
