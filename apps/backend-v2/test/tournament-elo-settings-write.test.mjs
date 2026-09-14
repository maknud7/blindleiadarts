import assert from "node:assert/strict";
import test from "node:test";

import { MySqlTournamentRuntimeRepository } from "../dist/mysql/tournament-runtime-repository.js";
import { TournamentRuntimeRouter } from "../dist/runtime/tournament-runtime-router.js";

class FakeSessions {
  constructor(db) { this.db = db; }
  async withTransaction(work) { return work(this.db); }
  async withConnection(work) { return work(this.db); }
}

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

function identity(role = "club_admin", adminClubIds = "42") {
  const touches = [];
  return {
    touches,
    async findBySessionToken(token, touchSession) {
      touches.push(touchSession);
      if (token !== "test-session") return null;
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
  const updates = [];
  const tournaments = {
    async findTournament(id) {
      return { id, club_id: "42", name: "ELO test" };
    },
    async updateTournamentEloSetting(id, value) {
      updates.push({ id, value });
      return { id, club_id: "42", season_id: "9", name: "ELO test", elo_enabled: Boolean(value) };
    },
  };
  const router = new TournamentRuntimeRouter(
    config(mode),
    identityRepository,
    {},
    {},
    tournaments,
  );
  return { router, identityRepository, updates };
}

test("tournament ELO setting write is blocked in readonly mode before identity lookup", async () => {
  const { router, identityRepository, updates } = routerFixture({ mode: "readonly" });
  await assert.rejects(
    router.handle("PATCH", "/v1/tournaments/90071992547409931/elo-settings", request({ elo_enabled: true })),
    (error) => error?.code === "backend_v2_read_only" && error?.statusCode === 403,
  );
  assert.deepEqual(identityRepository.touches, []);
  assert.deepEqual(updates, []);
});

test("TEST ELO setting write reads shared PROD identity without touching the session", async () => {
  const { router, identityRepository, updates } = routerFixture();
  const result = await router.handle(
    "PUT",
    "/v1/tournaments/90071992547409931/elo-settings",
    request({ elo_enabled: true }),
  );
  assert.equal(result?.statusCode, 200);
  assert.deepEqual(identityRepository.touches, [false]);
  assert.deepEqual(updates, [{ id: "90071992547409931", value: true }]);
  assert.equal(result?.payload.tournament.id, "90071992547409931");
});

test("tournament ELO setting write requires authentication and club admin access", async () => {
  {
    const { router, updates } = routerFixture();
    await assert.rejects(
      router.handle("PATCH", "/v1/tournaments/5/elo-settings", request({ elo_enabled: true }, null)),
      (error) => error?.code === "authentication_required" && error?.statusCode === 401,
    );
    assert.deepEqual(updates, []);
  }
  {
    const { router, updates } = routerFixture({ role: "player" });
    await assert.rejects(
      router.handle("PATCH", "/v1/tournaments/5/elo-settings", request({ elo_enabled: true })),
      (error) => error?.code === "admin_required" && error?.statusCode === 403,
    );
    assert.deepEqual(updates, []);
  }
  {
    const { router, updates } = routerFixture({ adminClubIds: "41" });
    await assert.rejects(
      router.handle("PATCH", "/v1/tournaments/5/elo-settings", request({ elo_enabled: true })),
      (error) => error?.code === "club_access_denied" && error?.statusCode === 403,
    );
    assert.deepEqual(updates, []);
  }
});

test("tournament ELO setting write requires elo_enabled", async () => {
  const { router, updates } = routerFixture();
  await assert.rejects(
    router.handle("PATCH", "/v1/tournaments/5/elo-settings", request({})),
    (error) => error?.code === "elo_enabled_required" && error?.statusCode === 422,
  );
  assert.deepEqual(updates, []);
});

test("repository keeps same-value update idempotent and preserves exact decimal IDs", async () => {
  const queries = [];
  const executes = [];
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      return [{ id: "90071992547409931", club_id: "42", season_id: "9", name: "Big ID", elo_enabled: 1 }];
    },
    async execute(sql, params) { executes.push({ sql, params }); return { affectedRows: 1 }; },
  };
  const repo = new MySqlTournamentRuntimeRepository(new FakeSessions(db), "bd_test_");
  const result = await repo.updateTournamentEloSetting("90071992547409931", true);
  assert.equal(result.id, "90071992547409931");
  assert.equal(result.elo_enabled, true);
  assert.equal(queries.length, 1, "idempotent update must not inspect completed matches");
  assert.equal(executes.length, 0, "idempotent update must not write");
});

test("repository locks ELO setting after a completed match", async () => {
  let queryIndex = 0;
  const executes = [];
  const db = {
    async query() {
      queryIndex += 1;
      if (queryIndex === 1) return [{ id: "5", club_id: "42", season_id: "9", name: "Locked", elo_enabled: 0 }];
      return [{ c: 1 }];
    },
    async execute(sql, params) { executes.push({ sql, params }); return { affectedRows: 1 }; },
  };
  const repo = new MySqlTournamentRuntimeRepository(new FakeSessions(db), "bd_test_");
  await assert.rejects(
    repo.updateTournamentEloSetting("5", true),
    (error) => error?.code === "elo_setting_locked" && error?.statusCode === 409,
  );
  assert.equal(executes.length, 0);
});

test("repository updates unlocked ELO setting once", async () => {
  let queryIndex = 0;
  const executes = [];
  const db = {
    async query() {
      queryIndex += 1;
      if (queryIndex === 1) return [{ id: "5", club_id: "42", season_id: "9", name: "Open", elo_enabled: 0 }];
      return [{ c: 0 }];
    },
    async execute(sql, params) { executes.push({ sql, params }); return { affectedRows: 1 }; },
  };
  const repo = new MySqlTournamentRuntimeRepository(new FakeSessions(db), "bd_test_");
  const result = await repo.updateTournamentEloSetting("5", true);
  assert.equal(result.elo_enabled, true);
  assert.equal(executes.length, 1);
  assert.deepEqual(executes[0].params, [1, "5"]);
});
