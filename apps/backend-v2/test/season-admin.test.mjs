import assert from "node:assert/strict";
import test from "node:test";

import { MySqlSeasonAdminRepository } from "../dist/mysql/season-admin-repository.js";
import { SeasonAdminRouter } from "../dist/runtime/season-admin-router.js";

function request(body = {}, authorization = "Bearer season-session") {
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
      host: "localhost",
      port: 3306,
      database: "test",
      username: "test",
      password: "test",
      connectTimeoutMs: 1000,
      idleConnectionTimeoutMs: 1000,
      budget: { maxConcurrentConnections: 1, acquireTimeoutMs: 1000 },
    },
    realtime: { websocketUrl: null, publishUrl: null, publishSecret: null, timeoutMs: 1000, publishEnabled: false },
  };
}

function identity(role = "club_admin", adminClubIds = "42") {
  const touches = [];
  return {
    touches,
    async findBySessionToken(token, touchSession) {
      touches.push(touchSession);
      if (token !== "season-session") return null;
      return {
        id: "7",
        email: "season-admin@example.invalid",
        display_name: "Season Admin",
        role,
        is_active: 1,
        account_status: "active",
        contact_phone: null,
        player_id: null,
        player_display_name: null,
        player_club_id: null,
        member_id: null,
        admin_club_ids: adminClubIds,
        global_roles: "",
      };
    },
  };
}

function routerFixture({ mode = "test-write", role = "club_admin", adminClubIds = "42" } = {}) {
  const identityRepository = identity(role, adminClubIds);
  const calls = [];
  const seasons = {
    async find(id) { return { id, club_id: "42", status: "draft" }; },
    async create(clubId, body) { calls.push(["create", clubId, body]); return { id: "90071992547409931", club_id: clubId, status: "draft" }; },
    async update(id, body) { calls.push(["update", id, body]); return { id, club_id: "42", status: "draft" }; },
    async activate(id) { calls.push(["activate", id]); return { id, club_id: "42", status: "active", is_active: true }; },
    async complete(id) { calls.push(["complete", id]); return { id, club_id: "42", status: "completed", is_active: false }; },
  };
  return {
    router: new SeasonAdminRouter(config(mode), identityRepository, seasons),
    identityRepository,
    calls,
  };
}

test("season writes are blocked in readonly mode before identity or repository access", async () => {
  const { router, identityRepository, calls } = routerFixture({ mode: "readonly" });
  await assert.rejects(
    router.handle("POST", "/v1/clubs/42/seasons", request({ name: "Høst" })),
    (error) => error?.code === "backend_v2_read_only" && error?.statusCode === 403,
  );
  assert.deepEqual(identityRepository.touches, []);
  assert.deepEqual(calls, []);
});

test("shared PROD identity is read without session touch and BIGINT ids stay exact", async () => {
  const { router, identityRepository, calls } = routerFixture();
  const created = await router.handle("POST", "/v1/clubs/42/seasons", request({ name: "Høst" }));
  assert.equal(created?.statusCode, 201);
  assert.equal(created?.payload.season.id, "90071992547409931");
  assert.deepEqual(identityRepository.touches, [false]);

  const updated = await router.handle(
    "PATCH",
    "/v1/seasons/90071992547409931",
    request({ points_win: 3 }),
  );
  assert.equal(updated?.payload.season.id, "90071992547409931");
  assert.equal(calls[1][1], "90071992547409931");
  assert.deepEqual(identityRepository.touches, [false, false]);
});

test("season admin requires authentication and access to the season club", async () => {
  {
    const { router, calls } = routerFixture();
    await assert.rejects(
      router.handle("POST", "/v1/clubs/42/seasons", request({ name: "Høst" }, null)),
      (error) => error?.code === "authentication_required" && error?.statusCode === 401,
    );
    assert.deepEqual(calls, []);
  }
  {
    const { router, calls } = routerFixture({ role: "player" });
    await assert.rejects(
      router.handle("POST", "/v1/seasons/8/activate", request()),
      (error) => error?.code === "admin_required" && error?.statusCode === 403,
    );
    assert.deepEqual(calls, []);
  }
  {
    const { router, calls } = routerFixture({ adminClubIds: "41" });
    await assert.rejects(
      router.handle("PATCH", "/v1/seasons/8", request({ name: "Nei" })),
      (error) => error?.code === "club_access_denied" && error?.statusCode === 403,
    );
    assert.deepEqual(calls, []);
  }
});

test("season router owns only mutation routes", async () => {
  const { router } = routerFixture();
  assert.equal(await router.handle("GET", "/v1/clubs/42/seasons", request()), null);
  assert.equal(await router.handle("GET", "/v1/seasons/8", request()), null);
  assert.equal(await router.handle("GET", "/v1/seasons/8/standings", request()), null);
  assert.equal(await router.handle("DELETE", "/v1/seasons/8", request()), null);
});

class RejectingSessions {
  async withTransaction() { throw new Error("validation must happen before DB access"); }
  async withConnection() { throw new Error("validation must happen before DB access"); }
}

test("season create validation matches legacy rules before DB access", async () => {
  const repo = new MySqlSeasonAdminRepository(new RejectingSessions(), "bd_test_");
  const cases = [
    [{ name: "" }, "Sesongen må ha et navn."],
    [{ name: "A", starts_on: "2026-02-30" }, "Dato må være på formatet ÅÅÅÅ-MM-DD."],
    [{ name: "A", starts_on: "2026-09-02", ends_on: "2026-09-01" }, "Sluttdato kan ikke være før startdato."],
    [{ name: "A", ranking_method: "random" }, "Ugyldig metode for sesongtabellen."],
    [{ name: "A", points_win: "abc" }, "Sesongpoeng må være et tall."],
    [{ name: "A", points_win: 1001 }, "Sesongpoeng må være mellom 0 og 1000."],
  ];
  for (const [body, message] of cases) {
    await assert.rejects(
      repo.create("42", body),
      (error) => error?.code === "season_validation_failed" && error?.statusCode === 422 && error?.message === message,
    );
  }
});

test("completed seasons reject update and reactivation without writes", async () => {
  const executes = [];
  const db = {
    async query() {
      return [{
        id: "8", club_id: "42", name: "Ferdig", starts_on: null, ends_on: null,
        is_active: 0, status: "completed", ranking_method: "match_points",
        points_win: 2, points_draw: 1, points_loss: 0,
      }];
    },
    async execute(sql, params) { executes.push({ sql, params }); return { affectedRows: 1 }; },
  };
  const sessions = {
    async withTransaction(work) { return work(db); },
    async withConnection(work) { return work(db); },
  };
  const repo = new MySqlSeasonAdminRepository(sessions, "bd_test_");
  await assert.rejects(repo.update("8", { name: "Ny" }), (error) => error?.code === "season_completed" && error?.statusCode === 409);
  await assert.rejects(repo.activate("8"), (error) => error?.code === "season_completed" && error?.statusCode === 409);
  assert.deepEqual(executes, []);
});
