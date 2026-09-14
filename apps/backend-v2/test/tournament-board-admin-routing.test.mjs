import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { TournamentRuntimeRouter } from "../dist/runtime/tournament-runtime-router.js";

function request(body = {}, authorization = "Bearer test-session") {
  const raw = Buffer.from(JSON.stringify(body));
  return {
    headers: authorization === null ? {} : { authorization },
    async *[Symbol.asyncIterator]() { yield raw; },
  };
}

function config(mode = "test-write") {
  return {
    environment: "test",
    mode,
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
    realtime: { websocketUrl: null, publishUrl: null, publishSecret: null, timeoutMs: 1000, publishEnabled: false },
  };
}

function fixture({ mode = "test-write", role = "club_admin", adminClubIds = "42" } = {}) {
  const touches = [];
  const calls = [];
  const boards = {
    async findTournament(id) {
      calls.push({ op: "findTournament", id });
      return { id, club_id: "42", name: "Board test" };
    },
    async boardAssignmentOverview(id) {
      calls.push({ op: "overview", id });
      return { tournament: { id, club_id: "42" }, boards: [], queue: { items: [] } };
    },
    async replaceBoardAssignments(id, kioskIds) {
      calls.push({ op: "replace", id, kioskIds });
      return { tournament: { id, club_id: "42" }, boards: kioskIds.map((value) => ({ id: String(value) })), queue: { items: [] } };
    },
    async autoAssignPendingMatches(id) {
      calls.push({ op: "auto", id });
      return { tournament: { id, club_id: "42" }, assigned_count: 1, skipped_count: 0, assigned: [], skipped: [], overview: {} };
    },
    async createMatch(id, body) {
      calls.push({ op: "createMatch", id, body });
      return { id: "90071992547409939", tournament_id: id, player_a_id: body.player_a_id, player_b_id: body.player_b_id };
    },
    async assignMatchToKiosk(id, kioskId) {
      calls.push({ op: "assign", id, kioskId });
      return { id, tournament_id: "90071992547409931", kiosk_id: kioskId, player_a_id: "1", player_b_id: "2" };
    },
  };
  const identity = {
    async findBySessionToken(token, touchSession) {
      touches.push(touchSession);
      if (token !== "test-session") return null;
      return {
        id: "90071992547409935", email: "admin@example.invalid", display_name: "Admin",
        role, is_active: 1, account_status: "active", contact_phone: null,
        player_id: null, player_display_name: null, player_club_id: null, member_id: null,
        admin_club_ids: adminClubIds, global_roles: role === "super_admin" ? "super_admin" : "",
      };
    },
    tournamentBoardAdminRepository() { return boards; },
  };
  const router = new TournamentRuntimeRouter(config(mode), identity, {}, {}, {});
  return { router, touches, calls };
}

test("board assignment GET requires an admin with access to the tournament club", async () => {
  const { router, touches, calls } = fixture();
  const result = await router.handle("GET", "/v1/tournaments/90071992547409931/board-assignments", request());
  assert.equal(result?.statusCode, 200);
  assert.equal(result?.payload.tournament.id, "90071992547409931");
  assert.deepEqual(touches, [false]);
  assert.deepEqual(calls, [
    { op: "findTournament", id: "90071992547409931" },
    { op: "overview", id: "90071992547409931" },
  ]);
});

test("board assignment mutation guard runs before identity or repository access", async () => {
  const { router, touches, calls } = fixture({ mode: "readonly" });
  await assert.rejects(
    router.handle("PUT", "/v1/tournaments/5/board-assignments", request({ kiosk_ids: [1] })),
    (error) => error?.code === "backend_v2_read_only" && error?.statusCode === 403,
  );
  assert.deepEqual(touches, []);
  assert.deepEqual(calls, []);
});

test("board assignment writes preserve TEST identity no-touch and club scope", async () => {
  const { router, touches, calls } = fixture();
  const result = await router.handle("PUT", "/v1/tournaments/90071992547409931/board-assignments", request({ kiosk_ids: ["7", "8"] }));
  assert.equal(result?.statusCode, 200);
  assert.deepEqual(touches, [false]);
  assert.deepEqual(calls, [
    { op: "findTournament", id: "90071992547409931" },
    { op: "replace", id: "90071992547409931", kioskIds: ["7", "8"] },
  ]);

  const denied = fixture({ adminClubIds: "41" });
  await assert.rejects(
    denied.router.handle("POST", "/v1/tournaments/5/auto-assign", request()),
    (error) => error?.code === "club_access_denied" && error?.statusCode === 403,
  );
});

test("manual match creation preserves legacy any-admin authorization and BIGINT ids", async () => {
  const { router, touches, calls } = fixture({ adminClubIds: "999" });
  const result = await router.handle("POST", "/v1/tournaments/90071992547409931/matches", request({
    player_a_id: "90071992547409933",
    player_b_id: "90071992547409934",
    best_of_legs: 5,
  }));
  assert.equal(result?.statusCode, 201);
  assert.equal(result?.payload.match.id, "90071992547409939");
  assert.deepEqual(touches, [false]);
  assert.equal(calls[0].op, "createMatch");
  assert.equal(calls[0].body.player_a_id, "90071992547409933");
  assert.equal(calls[1].op, "findTournament");
});

test("manual match creation preserves invalid_match_players before repository access", async () => {
  const { router, calls } = fixture();
  await assert.rejects(
    router.handle("POST", "/v1/tournaments/5/matches", request({ player_a_id: 7, player_b_id: 7 })),
    (error) => error?.code === "invalid_match_players" && error?.statusCode === 422,
  );
  assert.deepEqual(calls, []);
});

test("assign-kiosk preserves legacy any-admin authorization and kiosk_required validation", async () => {
  const { router, calls } = fixture({ adminClubIds: "999" });
  const result = await router.handle("POST", "/v1/matches/90071992547409939/assign-kiosk", request({ kiosk_id: "90071992547409940" }));
  assert.equal(result?.statusCode, 200);
  assert.equal(result?.payload.match.kiosk_id, "90071992547409940");
  assert.deepEqual(calls, [
    { op: "assign", id: "90071992547409939", kioskId: "90071992547409940" },
    { op: "findTournament", id: "90071992547409931" },
  ]);

  const missing = fixture();
  await assert.rejects(
    missing.router.handle("POST", "/v1/matches/5/assign-kiosk", request({})),
    (error) => error?.code === "kiosk_required" && error?.statusCode === 422,
  );
  assert.deepEqual(missing.calls, []);
});

test("non-admins cannot use board admin mutation routes", async () => {
  const { router } = fixture({ role: "player", adminClubIds: "" });
  await assert.rejects(
    router.handle("POST", "/v1/tournaments/5/matches", request({ player_a_id: 1, player_b_id: 2 })),
    (error) => error?.code === "admin_required" && error?.statusCode === 403,
  );
});

test("PHP tournament frontdoor already captures the complete board admin route matrix", () => {
  const source = fs.readFileSync("apps/api/src/BackendV2TournamentProxyApplication.php", "utf8");
  assert.match(source, /\['GET', 'PUT'\].*board-assignments/);
  assert.match(source, /POST'.*auto-assign/);
  assert.match(source, /POST'.*assign-kiosk/);
  assert.match(source, /\['GET', 'POST'\].*matches/);
});
