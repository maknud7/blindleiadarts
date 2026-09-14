import assert from "node:assert/strict";
import test from "node:test";

import { MySqlPaymentSettingsRepository } from "../dist/mysql/payment-settings-repository.js";
import { PaymentSettingsRouter } from "../dist/runtime/payment-settings-router.js";

function request(body = {}, authorization = "Bearer payment-session") {
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
      if (token !== "payment-session") return null;
      return {
        id: "90071992547409931",
        email: "payment-admin@example.invalid",
        display_name: "Payment Admin",
        role,
        is_active: 1,
        account_status: "active",
        contact_phone: null,
        player_id: null,
        player_display_name: null,
        player_club_id: null,
        member_id: null,
        admin_club_ids: adminClubIds,
        global_roles: role === "super_admin" ? "super_admin" : "",
      };
    },
  };
}

function routerFixture({ mode = "test-write", role = "club_admin", adminClubIds = "42" } = {}) {
  const identityRepository = identity(role, adminClubIds);
  const calls = [];
  const payments = {
    async adminSettings(clubId) {
      calls.push(["read", clubId]);
      return { club_id: clubId, club_name: "Blindleia Dartklubb", registration_block_after_missed_months: 3 };
    },
    async saveAdminSettings(clubId, body) {
      calls.push(["write", clubId, body]);
      return { club_id: clubId, club_name: "Blindleia Dartklubb", ...body };
    },
  };
  return {
    router: new PaymentSettingsRouter(config(mode), identityRepository, payments),
    identityRepository,
    calls,
  };
}

test("payment settings writes are blocked in readonly mode before identity or repository access", async () => {
  const { router, identityRepository, calls } = routerFixture({ mode: "readonly" });
  await assert.rejects(
    router.handle("PATCH", "/v1/clubs/42/payment-settings", request({ vipps_number: "12345" })),
    (error) => error?.code === "backend_v2_read_only" && error?.statusCode === 403,
  );
  assert.deepEqual(identityRepository.touches, []);
  assert.deepEqual(calls, []);
});

test("TEST payment settings auth reads shared PROD identity without touching the session", async () => {
  const { router, identityRepository, calls } = routerFixture();
  const response = await router.handle(
    "PATCH",
    "/v1/clubs/42/payment-settings",
    request({ vipps_number: "987654" }),
  );
  assert.equal(response?.statusCode, 200);
  assert.equal(response?.payload.settings.vipps_number, "987654");
  assert.equal(response?.payload.message, "Betalingsinnstillingene er lagret.");
  assert.deepEqual(identityRepository.touches, [false]);
  assert.deepEqual(calls, [["write", "42", { vipps_number: "987654" }]]);
});

test("payment settings GET remains available in readonly mode and requires club admin access", async () => {
  {
    const { router, identityRepository, calls } = routerFixture({ mode: "readonly" });
    const response = await router.handle("GET", "/v1/clubs/42/payment-settings", request());
    assert.equal(response?.payload.settings.club_name, "Blindleia Dartklubb");
    assert.deepEqual(identityRepository.touches, [false]);
    assert.deepEqual(calls, [["read", "42"]]);
  }
  {
    const { router, calls } = routerFixture({ role: "player" });
    await assert.rejects(
      router.handle("GET", "/v1/clubs/42/payment-settings", request()),
      (error) => error?.code === "admin_required" && error?.statusCode === 403,
    );
    assert.deepEqual(calls, []);
  }
  {
    const { router, calls } = routerFixture({ adminClubIds: "41" });
    await assert.rejects(
      router.handle("GET", "/v1/clubs/42/payment-settings", request()),
      (error) => error?.code === "club_access_denied" && error?.statusCode === 403,
    );
    assert.deepEqual(calls, []);
  }
  {
    const { router, calls } = routerFixture({ role: "super_admin", adminClubIds: "" });
    const response = await router.handle("GET", "/v1/clubs/42/payment-settings", request());
    assert.equal(response?.statusCode, 200);
    assert.deepEqual(calls, [["read", "42"]]);
  }
});

test("payment settings router owns only the exact admin route", async () => {
  const { router } = routerFixture();
  assert.equal(await router.handle("POST", "/v1/clubs/42/payment-settings", request()), null);
  assert.equal(await router.handle("GET", "/v1/clubs/42/payment-settings/other", request()), null);
  assert.equal(await router.handle("GET", "/v1/clubs/0/payment-settings", request()), null);
});

class RejectingSessions {
  async withTransaction() { throw new Error("validation must happen before DB access"); }
  async withConnection() { throw new Error("validation must happen before DB access"); }
}

test("payment setting validation matches legacy PHP before opening a transaction", async () => {
  const repo = new MySqlPaymentSettingsRepository(new RejectingSessions(), "bd_test_");
  const cases = [
    [{ stripe_start_url: "ftp://example.test/pay" }, "payment_url_invalid"],
    [{ stripe_portal_url: "not a url" }, "payment_url_invalid"],
    [{ registration_block_after_missed_months: "1.5" }, "payment_policy_invalid"],
    [{ registration_block_after_missed_months: "13" }, "payment_policy_invalid"],
    [{ vipps_number: "x".repeat(51) }, "vipps_number_invalid"],
    [{ payment_contact: "x".repeat(1001) }, "payment_setting_too_long"],
  ];
  for (const [body, code] of cases) {
    await assert.rejects(repo.saveAdminSettings("42", body), (error) => error?.code === code && error?.statusCode === 422);
  }
});

test("repository preserves legacy fallback, defaults and unsafe BIGINT club ids", async () => {
  const sessions = {
    async withConnection(work) {
      return work({
        async query(sql) {
          if (sql.includes("FROM `bd_test_clubs`")) {
            return [{ id: "90071992547409931", name: "Blindleia Dartklubb", slug: "blindleia-dartklubb" }];
          }
          if (sql.includes("FROM `bd_test_settings`")) return [];
          throw new Error(`Unexpected query: ${sql}`);
        },
      });
    },
  };
  const repo = new MySqlPaymentSettingsRepository(sessions, "bd_test_");
  const settings = await repo.adminSettings("90071992547409931");
  assert.equal(settings.club_id, "90071992547409931");
  assert.equal(settings.stripe_start_url, null);
  assert.equal(settings.stripe_start_url_effective, "https://dart.ingenting.org/stripe_kontingent.php");
  assert.equal(settings.registration_block_after_missed_months, 3);
});

test("repository updates only supplied fields and deletes empty optional settings", async () => {
  const executes = [];
  let connectionReads = 0;
  const db = {
    async query(sql) {
      if (sql.includes("FOR UPDATE")) return [{ id: "42" }];
      if (sql.includes("FROM `bd_test_clubs`")) return [{ id: "42", name: "Testklubb", slug: "testklubb" }];
      if (sql.includes("FROM `bd_test_settings`")) {
        connectionReads += 1;
        return [
          { setting_key: "membership.vipps_name", setting_value: "Ny Vipps" },
          { setting_key: "membership.registration_block_after_missed_months", setting_value: "0" },
        ];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async execute(sql, params) {
      executes.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      return { affectedRows: 1 };
    },
  };
  const sessions = {
    async withTransaction(work) { return work(db); },
    async withConnection(work) { return work(db); },
  };
  const repo = new MySqlPaymentSettingsRepository(sessions, "bd_test_");
  const settings = await repo.saveAdminSettings("42", {
    vipps_name: " Ny Vipps ",
    vipps_number: "",
    registration_block_after_missed_months: "0",
    ignored: "must-not-write",
  });

  assert.equal(executes.length, 3);
  assert.match(executes[0].sql, /^INSERT INTO `bd_test_settings`/);
  assert.deepEqual(executes[0].params, ["42", "membership.vipps_name", "Ny Vipps"]);
  assert.match(executes[1].sql, /^DELETE FROM `bd_test_settings`/);
  assert.deepEqual(executes[1].params, ["42", "membership.vipps_number"]);
  assert.match(executes[2].sql, /^INSERT INTO `bd_test_settings`/);
  assert.deepEqual(executes[2].params, ["42", "membership.registration_block_after_missed_months", "0"]);
  assert.equal(connectionReads, 1);
  assert.equal(settings.vipps_name, "Ny Vipps");
  assert.equal(settings.registration_block_after_missed_months, 0);
});
