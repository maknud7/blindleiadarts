import assert from "node:assert/strict";
import test from "node:test";

import { MySqlActivityRuntimeRepository } from "../dist/mysql/activity-runtime-repository.js";
import { ActivityRuntimeRouter } from "../dist/runtime/activity-runtime-router.js";

function config({ mode = "test-write", identity = "bd_prod_" } = {}) {
  return {
    environment: "test",
    mode,
    prodCanaryWritesEnabled: false,
    canonicalSideEffectsReady: true,
    prefixes: { runtime: "bd_test_", identity, hardware: "bd_prod_" },
  };
}

function request({ headers = {}, url = "/", body } = {}) {
  return {
    headers,
    url,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
}

function user(overrides = {}) {
  return {
    id: "9007199254740993",
    email: "user@example.invalid",
    display_name: "Activity User",
    account_status: "active",
    role: "player",
    is_active: 1,
    contact_phone: null,
    player_id: null,
    player_display_name: null,
    player_club_id: null,
    member_id: null,
    admin_club_ids: "",
    global_roles: "",
    session_id: "9007199254740995",
    expires_at: "2027-01-01 00:00:00",
    ...overrides,
  };
}

test("readonly activity POST is blocked before identity lookup or runtime write", async () => {
  let identityCalls = 0;
  let writes = 0;
  const router = new ActivityRuntimeRouter(
    config({ mode: "readonly" }),
    { async findBySessionToken() { identityCalls += 1; return user(); } },
    { async recordBatch() { writes += 1; return 1; } },
  );

  await assert.rejects(
    router.handle("POST", "/v1/activity", request({ body: { event_name: "page_view" } })),
    (error) => error?.code === "backend_v2_read_only" && error?.statusCode === 403,
  );
  assert.equal(identityCalls, 0);
  assert.equal(writes, 0);
});

test("invalid bearer token preserves legacy anonymous telemetry semantics", async () => {
  const touches = [];
  let recorded = null;
  const router = new ActivityRuntimeRouter(
    config(),
    { async findBySessionToken(token, touch) { touches.push([token, touch]); return null; } },
    { async recordBatch(events, userId, sessionId) { recorded = { events, userId, sessionId }; return events.length; } },
  );

  const result = await router.handle("POST", "/v1/activity", request({
    headers: { authorization: "Bearer expired-token" },
    body: { event_name: "page_view", path: "/live" },
  }));

  assert.equal(result.statusCode, 201);
  assert.equal(result.payload.recorded, 1);
  assert.deepEqual(touches, [["expired-token", false]], "TEST must never touch shared PROD identity sessions");
  assert.equal(recorded.userId, null);
  assert.equal(recorded.sessionId, null);
});

test("valid TEST telemetry keeps shared PROD identity ids as exact decimal strings without touching the session", async () => {
  let touch = null;
  let ids = null;
  const router = new ActivityRuntimeRouter(
    config(),
    { async findBySessionToken(_token, touchSession) { touch = touchSession; return user(); } },
    { async recordBatch(_events, userId, sessionId) { ids = [userId, sessionId]; return 1; } },
  );

  await router.handle("POST", "/v1/activity", request({
    headers: { authorization: "Bearer good-token" },
    body: { event_name: "click" },
  }));

  assert.equal(touch, false);
  assert.deepEqual(ids, ["9007199254740993", "9007199254740995"]);
});

test("activity session read preserves unsafe BIGINT ids", async () => {
  const router = new ActivityRuntimeRouter(
    config(),
    { async findBySessionToken(_token, touch) { assert.equal(touch, false); return user(); } },
    {},
  );
  const result = await router.handle("GET", "/v1/activity/session", request({ headers: { authorization: "Bearer good" } }));
  assert.equal(result.payload.session.id, "9007199254740995");
  assert.equal(result.payload.user.id, "9007199254740993");
  assert.equal(result.payload.session.expires_at, "2027-01-01 00:00:00");
});

test("activity summaries require superadmin and keep days query separate from route matching", async () => {
  const denied = new ActivityRuntimeRouter(
    config(),
    { async findBySessionToken() { return user({ role: "club_admin" }); } },
    {},
  );
  await assert.rejects(
    denied.handle("GET", "/v1/clubs/7/activity", request({ headers: { authorization: "Bearer admin" }, url: "/v1/clubs/7/activity?days=5" })),
    (error) => error?.code === "super_admin_required" && error?.statusCode === 403,
  );

  let call = null;
  const allowed = new ActivityRuntimeRouter(
    config(),
    { async findBySessionToken(_token, touch) { assert.equal(touch, false); return user({ role: "super_admin" }); } },
    {
      async summaryByClub(clubId, days) { call = [clubId, days]; return { days, totals: {} }; },
      async summaryAll(days) { call = ["all", days]; return { days, totals: {} }; },
    },
  );
  const club = await allowed.handle("GET", "/v1/clubs/7/activity", request({ headers: { authorization: "Bearer root" }, url: "/v1/clubs/7/activity?days=45" }));
  assert.equal(club.statusCode, 200);
  assert.deepEqual(call, ["7", 45]);

  await allowed.handle("GET", "/v1/platform/activity", request({ headers: { authorization: "Bearer root" }, url: "/v1/platform/activity?days=12" }));
  assert.deepEqual(call, ["all", 12]);
});

test("activity repository caps batches at 50, resolves club slug and sanitizes metadata", async () => {
  const inserts = [];
  const executor = {
    async query(sql, params = []) {
      if (sql.includes("FROM `bd_test_clubs` WHERE slug=?")) {
        assert.deepEqual(params, ["blindleia"]);
        return [{ id: "9007199254740997" }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async execute(sql, params = []) {
      inserts.push({ sql, params });
      return { affectedRows: 1, insertId: "0" };
    },
  };
  const repo = new MySqlActivityRuntimeRepository(
    { async withConnection(work) { return work(executor); } },
    "bd_test_",
    "bd_prod_",
  );
  const events = Array.from({ length: 55 }, (_, index) => ({
    club_slug: "Blindleia",
    event_name: "page_view",
    path: `/p/${index}`,
    metadata: { action: "open", password: "must-not-leak", stack: "x".repeat(1600) },
  }));

  const count = await repo.recordBatch(events, "9007199254740993", "9007199254740995");
  assert.equal(count, 50);
  assert.equal(inserts.length, 50);
  const firstParams = inserts[0].params;
  assert.equal(firstParams[1], "9007199254740993");
  assert.equal(firstParams[2], "9007199254740995");
  assert.equal(firstParams[3], "9007199254740997");
  const metadata = JSON.parse(firstParams[11]);
  assert.equal(metadata.action, "open");
  assert.equal("password" in metadata, false);
  assert.equal(metadata.stack.length, 1400);
});

test("unrelated routes remain outside activity ownership", async () => {
  const router = new ActivityRuntimeRouter(config(), {}, {});
  assert.equal(await router.handle("GET", "/v1/clubs/7/elo", request()), null);
  assert.equal(await router.handle("POST", "/v1/tournaments/7/start", request()), null);
});
