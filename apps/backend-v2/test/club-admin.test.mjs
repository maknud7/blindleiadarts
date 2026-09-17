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
  const lookups = [];
  const lists = [];
  const matchCalls = [];
  const clubs = {
    async list() {
      lists.push(true);
      return [{
        id: "90071992547409930",
        name: "Blindleia Dartklubb",
        slug: "blindleia-dartklubb",
        logo_url: null,
        kiosk_pairing_code: "BDK-1234",
        player_count: "17",
        kiosk_count: "4",
        active_tournament_count: "1",
      }];
    },
    async create(body) {
      calls.push(body);
      return { id: "90071992547409931", name: body.name, slug: "ny-klubb" };
    },
    async findByKioskPairingCode(code) {
      lookups.push(code);
      if (code !== "BDK-1234") return null;
      return {
        id: "90071992547409932",
        name: "Blindleia Dartklubb",
        slug: "blindleia-dartklubb",
        logo_url: null,
        kiosk_pairing_code: code,
        created_at: "2026-09-16 10:00:00",
        updated_at: "2026-09-16 10:00:00",
      };
    },
    async listMatchCallsByClubId(clubId) {
      matchCalls.push(clubId);
      return [{
        id: "90071992547409941",
        tournament_id: "90071992547409942",
        tournament_name: "Mandagsserien",
        kiosk_id: "90071992547409943",
        round_label: "Runde 4",
        bracket_label: null,
        status: "assigned",
        best_of_legs: 5,
        legs_to_win: 3,
        player_a_id: "90071992547409944",
        player_a_name: "Spiller A",
        player_b_id: "90071992547409945",
        player_b_name: "Spiller B",
        kiosk_code: "BOARD-1",
        kiosk_name: "Skive 1",
        board_number: 1,
      }];
    },
  };
  return {
    router: new ClubAdminRouter(config(mode), identityRepository, clubs),
    identityRepository,
    calls,
    lookups,
    lists,
    matchCalls,
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

test("public kiosk connect is a read-only runtime lookup with legacy response contract", async () => {
  const { router, identityRepository, lookups } = routerFixture({ mode: "readonly" });
  const result = await router.handle("POST", "/v1/public/kiosk/connect", request({ code: " bdk-1234 " }, null));

  assert.equal(result?.statusCode, 200);
  assert.equal(result?.payload.ok, true);
  assert.equal(result?.payload.club.id, "90071992547409932");
  assert.equal(result?.payload.club.kiosk_pairing_code, "BDK-1234");
  assert.deepEqual(lookups, ["BDK-1234"]);
  assert.deepEqual(identityRepository.touches, []);
});

test("public kiosk connect preserves legacy validation and not-found errors", async () => {
  const { router, lookups } = routerFixture({ mode: "readonly" });

  const missing = await router.handle("POST", "/v1/public/kiosk/connect", request({ code: "   " }, null));
  assert.deepEqual(missing, {
    statusCode: 422,
    payload: {
      ok: false,
      error: { code: "kiosk_club_code_required", message: "A kiosk club code is required." },
    },
  });
  assert.deepEqual(lookups, []);

  const unknown = await router.handle("POST", "/v1/public/kiosk/connect", request({ code: "nope" }, null));
  assert.deepEqual(unknown, {
    statusCode: 404,
    payload: {
      ok: false,
      error: { code: "kiosk_club_code_invalid", message: "Club code was not found." },
    },
  });
  assert.deepEqual(lookups, ["NOPE"]);
});

test("club list read works in readonly mode without touching shared identity", async () => {
  const { router, identityRepository, lists } = routerFixture({ mode: "readonly" });
  const result = await router.handle("GET", "/v1/clubs", request({}, null));

  assert.equal(result?.statusCode, 200);
  assert.equal(result?.payload.ok, true);
  assert.equal(result?.payload.items[0].id, "90071992547409930");
  assert.equal(result?.payload.items[0].player_count, "17");
  assert.deepEqual(lists, [true]);
  assert.deepEqual(identityRepository.touches, []);
});

test("club match calls read works in readonly mode without touching shared identity", async () => {
  const { router, identityRepository, matchCalls } = routerFixture({ mode: "readonly" });
  const result = await router.handle("GET", "/v1/clubs/90071992547409940/match-calls", request({}, null));

  assert.equal(result?.statusCode, 200);
  assert.equal(result?.payload.ok, true);
  assert.equal(result?.payload.club_id, "90071992547409940");
  assert.equal(result?.payload.items[0].id, "90071992547409941");
  assert.equal(result?.payload.items[0].tournament_id, "90071992547409942");
  assert.equal(result?.payload.items[0].player_a_id, "90071992547409944");
  assert.deepEqual(matchCalls, ["90071992547409940"]);
  assert.deepEqual(identityRepository.touches, []);
});

test("club admin router owns only intended club surfaces", async () => {
  const { router } = routerFixture();
  assert.equal((await router.handle("GET", "/v1/clubs", request()))?.statusCode, 200);
  assert.equal((await router.handle("GET", "/v1/clubs/42/match-calls", request()))?.statusCode, 200);
  assert.equal(await router.handle("POST", "/v1/clubs/42/match-calls", request()), null);
  assert.equal(await router.handle("PATCH", "/v1/clubs", request()), null);
  assert.equal(await router.handle("POST", "/v1/clubs/42", request()), null);
  assert.equal(await router.handle("GET", "/v1/public/kiosk/connect", request()), null);
});

test("club list repository preserves legacy aggregate shape and TEST-only runtime scope", async () => {
  const queries = [];
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      return [{
        id: "90071992547409930",
        name: "Blindleia Dartklubb",
        slug: "blindleia-dartklubb",
        logo_url: null,
        kiosk_pairing_code: "BDK-1234",
        player_count: 17,
        kiosk_count: "4",
        active_tournament_count: 1n,
      }];
    },
  };
  const sessions = {
    async withConnection(work) { return work(db); },
  };
  const repo = new MySqlClubAdminRepository(sessions, "bd_test_");
  const items = await repo.list();

  assert.equal(queries.length, 1);
  assert.equal(queries[0].params, undefined);
  assert.match(queries[0].sql, /`bd_test_clubs`/);
  assert.match(queries[0].sql, /`bd_test_players`/);
  assert.match(queries[0].sql, /`bd_test_kiosks`/);
  assert.match(queries[0].sql, /`bd_test_tournaments`/);
  assert.doesNotMatch(queries[0].sql, /bd_prod_/);
  assert.match(queries[0].sql, /p\.is_active=1/);
  assert.match(queries[0].sql, /k\.is_active=1/);
  assert.match(queries[0].sql, /t\.status IN \('draft','ready','in_progress'\)/);
  assert.match(queries[0].sql, /ORDER BY c\.name ASC/);
  assert.deepEqual(items, [{
    id: "90071992547409930",
    name: "Blindleia Dartklubb",
    slug: "blindleia-dartklubb",
    logo_url: null,
    kiosk_pairing_code: "BDK-1234",
    player_count: "17",
    kiosk_count: "4",
    active_tournament_count: "1",
  }]);
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

test("club repository kiosk pairing lookup uses only the runtime prefix and preserves exact ids", async () => {
  const queries = [];
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      return [{
        id: "90071992547409939",
        name: "Blindleia Dartklubb",
        slug: "blindleia-dartklubb",
        logo_url: null,
        kiosk_pairing_code: "BDK-1234",
        created_at: "2026-09-16 10:00:00",
        updated_at: "2026-09-16 10:00:00",
      }];
    },
  };
  const sessions = {
    async withConnection(work) { return work(db); },
  };
  const repo = new MySqlClubAdminRepository(sessions, "bd_test_");
  const club = await repo.findByKioskPairingCode(" bdk-1234 ");

  assert.equal(club?.id, "90071992547409939");
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /`bd_test_clubs`/);
  assert.doesNotMatch(queries[0].sql, /bd_prod_/);
  assert.deepEqual(queries[0].params, ["BDK-1234"]);
});

test("club match calls repository preserves legacy active queue and TEST-only runtime scope", async () => {
  const queries = [];
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      return [{
        id: "90071992547409941",
        tournament_id: "90071992547409942",
        tournament_name: "Mandagsserien",
        kiosk_id: "90071992547409943",
        round_label: "Runde 4",
        bracket_label: null,
        status: "in_progress",
        best_of_legs: "5",
        legs_to_win: "3",
        player_a_id: "90071992547409944",
        player_a_name: "Spiller A",
        player_b_id: "90071992547409945",
        player_b_name: "Spiller B",
        kiosk_code: "BOARD-1",
        kiosk_name: "Skive 1",
        board_number: "1",
      }];
    },
  };
  const sessions = {
    async withConnection(work) { return work(db); },
  };
  const repo = new MySqlClubAdminRepository(sessions, "bd_test_");
  const items = await repo.listMatchCallsByClubId("90071992547409940");

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, ["90071992547409940"]);
  assert.match(queries[0].sql, /`bd_test_matches`/);
  assert.match(queries[0].sql, /`bd_test_tournaments`/);
  assert.match(queries[0].sql, /`bd_test_players`/);
  assert.match(queries[0].sql, /`bd_test_kiosks`/);
  assert.doesNotMatch(queries[0].sql, /bd_prod_/);
  assert.match(queries[0].sql, /m\.status IN \('pending','assigned','in_progress'\)/);
  assert.match(queries[0].sql, /FIELD\(m\.status,'in_progress','assigned','pending'\)/);
  assert.equal(items[0].id, "90071992547409941");
  assert.equal(items[0].tournament_id, "90071992547409942");
  assert.equal(items[0].kiosk_id, "90071992547409943");
  assert.equal(items[0].player_a_id, "90071992547409944");
  assert.equal(items[0].player_b_id, "90071992547409945");
  assert.equal(items[0].best_of_legs, 5);
  assert.equal(items[0].board_number, 1);
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