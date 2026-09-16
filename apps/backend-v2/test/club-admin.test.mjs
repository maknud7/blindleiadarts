import assert from "node:assert/strict";
import test from "node:test";

import { MySqlClubAdminRepository } from "../dist/mysql/club-admin-repository.js";
import { ClubAdminRouter } from "../dist/runtime/club-admin-router.js";

function request(body = {}, authorization = "Bearer club-admin-session") {
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

function identity(role = "super_admin") {
  const touches = [];
  return {
    touches,
    async findBySessionToken(token, touchSession) {
      touches.push(touchSession);
      if (token !== "club-admin-session") return null;
      return {
        id: "7", email: "admin@example.invalid", display_name: "Admin", role,
        is_active: 1, account_status: "active", contact_phone: null,
        player_id: null, player_display_name: null, player_club_id: null,
        member_id: null, admin_club_ids: "42", global_roles: "",
      };
    },
  };
}

function routerFixture({ mode = "test-write", role = "super_admin" } = {}) {
  const identityRepository = identity(role);
  const calls = [];
  const clubs = {
    async create(body) {
      calls.push(body);
      return { id: "90071992547409931", name: body.name, slug: "ny-klubb" };
    },
  };
  return {
    router: new ClubAdminRouter(config(mode), identityRepository, clubs),
    identityRepository,
    calls,
  };
}

test("club create is blocked in readonly mode before identity or repository access", async () => {
  const { router, identityRepository, calls } = routerFixture({ mode: "readonly" });
  await assert.rejects(
    router.handle("POST", "/v1/clubs", request({ name: "Ny klubb" })),
    (error) => error?.code === "backend_v2_read_only" && error?.statusCode === 403,
  );
  assert.deepEqual(identityRepository.touches, []);
  assert.deepEqual(calls, []);
});

test("shared PROD identity is read without session touch and BIGINT ids stay exact", async () => {
  const { router, identityRepository, calls } = routerFixture();
  const result = await router.handle("POST", "/v1/clubs", request({ name: "Ny klubb" }));
  assert.equal(result?.statusCode, 201);
  assert.equal(result?.payload.club.id, "90071992547409931");
  assert.deepEqual(identityRepository.touches, [false]);
  assert.deepEqual(calls, [{ name: "Ny klubb" }]);
});

test("club create preserves legacy authentication and super-admin boundary", async () => {
  {
    const { router, calls } = routerFixture();
    await assert.rejects(
      router.handle("POST", "/v1/clubs", request({ name: "Ny klubb" }, null)),
      (error) => error?.code === "missing_bearer_token" && error?.statusCode === 401,
    );
    assert.deepEqual(calls, []);
  }
  {
    const { router, calls } = routerFixture({ role: "player" });
    await assert.rejects(
      router.handle("POST", "/v1/clubs", request({ name: "Ny klubb" })),
      (error) => error?.code === "admin_required" && error?.statusCode === 403,
    );
    assert.deepEqual(calls, []);
  }
  {
    const { router, calls } = routerFixture({ role: "club_admin" });
    await assert.rejects(
      router.handle("POST", "/v1/clubs", request({ name: "Ny klubb" })),
      (error) => error?.code === "super_admin_required" && error?.statusCode === 403,
    );
    assert.deepEqual(calls, []);
  }
});

test("club admin router owns only POST /v1/clubs", async () => {
  const { router } = routerFixture();
  assert.equal(await router.handle("GET", "/v1/clubs", request()), null);
  assert.equal(await router.handle("PATCH", "/v1/clubs", request()), null);
  assert.equal(await router.handle("POST", "/v1/clubs/42", request()), null);
});

test("club repository matches legacy slug, nullable logo and pairing-code shape", async () => {
  const executed = [];
  const db = {
    async query(sql, params) {
      if (sql.includes("kiosk_pairing_code=?")) return [];
      if (sql.includes("WHERE id=?")) {
        return [{
          id: "90071992547409931", name: "Østre Å Æra", slug: "ostre-a-aera",
          logo_url: null, kiosk_pairing_code: executed[0].params[3],
          created_at: "2026-09-15 12:00:00", updated_at: "2026-09-15 12:00:00",
        }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async execute(sql, params) {
      executed.push({ sql, params });
      return { affectedRows: 1, insertId: "90071992547409931" };
    },
  };
  const sessions = {
    async withTransaction(work) { return work(db); },
    async withConnection(work) { return work(db); },
  };
  const repo = new MySqlClubAdminRepository(sessions, "bd_test_");
  const club = await repo.create({ name: "  Østre Å Æra  ", logo_url: "   " });

  assert.equal(executed.length, 1);
  assert.deepEqual(executed[0].params.slice(0, 3), ["Østre Å Æra", "ostre-a-aera", null]);
  assert.match(executed[0].params[3], /^OST-K[0-9A-F]{4}$/);
  assert.equal(club.id, "90071992547409931");
});

test("club repository rejects missing name before database access", async () => {
  const sessions = {
    async withTransaction() { throw new Error("validation must happen before DB access"); },
    async withConnection() { throw new Error("validation must happen before DB access"); },
  };
  const repo = new MySqlClubAdminRepository(sessions, "bd_test_");
  await assert.rejects(
    repo.create({ name: "  " }),
    (error) => error?.code === "club_name_required" && error?.statusCode === 422 && error?.message === "Club name is required.",
  );
});
