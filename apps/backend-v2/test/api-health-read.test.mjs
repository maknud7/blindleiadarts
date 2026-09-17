import assert from "node:assert/strict";
import test from "node:test";

import { MySqlRuntimeHealthRepository } from "../dist/mysql/runtime-health-repository.js";
import { RuntimeHealthRouter } from "../dist/runtime/runtime-health-router.js";

function config() {
  return {
    environment: "test",
    mode: "readonly",
    host: "127.0.0.1",
    port: 18082,
    releaseSha: "90071992547409999",
    internalToken: null,
    prodCanaryWritesEnabled: false,
    canonicalSideEffectsReady: true,
    prefixes: { runtime: "bd_test_", identity: "bd_prod_", hardware: "bd_prod_" },
    mysql: {
      host: "localhost",
      port: 3306,
      database: "blindleia_test",
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

function request(url = "/v1/health") {
  return { url, headers: {}, async *[Symbol.asyncIterator]() {} };
}

function deepFixture() {
  const queries = [];
  const executes = [];
  const db = {
    async query(sql, params = []) {
      queries.push({ sql, params });

      if (sql === "SELECT 1 AS ok") return [{ ok: 1 }];

      if (sql.includes("information_schema.TABLES")) {
        const table = String(params[0] ?? "");
        const existing = new Set([
          "bd_test_clubs",
          "medlemmer",
          "kontingentbetalinger",
          "bd_prod_auth_sessions",
        ]);
        return [{ cnt: existing.has(table) ? 1 : 0 }];
      }

      if (sql.includes("information_schema.STATISTICS")) return [{ cnt: 1 }];
      if (sql.includes("FROM `medlemmer`")) return [{ id: "1", medlemsnummer: "100" }];
      if (sql.includes("FROM `kontingentbetalinger`")) return [];

      if (sql.includes("FROM `bd_test_tournament_players` tp")) return [];
      if (sql.includes("FROM `bd_test_tournaments` t")) return [];

      if (sql.includes("FROM `bd_test_players` p")) {
        return [{ id: "90071992547409931" }];
      }
      if (sql.includes("COUNT(*) AS cnt FROM `bd_test_matches`")) return [{ cnt: "4" }];
      if (sql.includes("SELECT id FROM `bd_test_matches`")) {
        return [{ id: "90071992547409941" }, { id: "90071992547409942" }];
      }

      if (sql.includes("FROM `bd_prod_user_accounts`")) {
        return [{ id: "90071992547409991", player_id: "90071992547409931" }];
      }
      if (sql.includes("FROM `bd_test_tournament_players` WHERE player_id=?")) {
        return [{ cnt: "2" }];
      }

      throw new Error(`Unexpected health query: ${sql}`);
    },
    async execute(sql, params = []) {
      executes.push({ sql, params });
      throw new Error("health diagnostics must never execute a write");
    },
  };
  const sessions = {
    async withConnection(work) { return work(db); },
    async withTransaction() { throw new Error("health diagnostics must never open a transaction"); },
  };
  const health = new MySqlRuntimeHealthRepository(sessions, "bd_test_", "bd_prod_");
  return { health, queries, executes };
}

test("API health is a readonly database probe with the legacy response shape", async () => {
  const queries = [];
  const sessions = {
    async withConnection(work) {
      return work({
        async query(sql, params = []) {
          queries.push({ sql, params });
          return [{ ok: 1 }];
        },
      });
    },
  };
  const health = new MySqlRuntimeHealthRepository(sessions, "bd_test_", "bd_prod_");
  const router = new RuntimeHealthRouter(config(), health);

  const result = await router.handle("GET", "/v1/health", request());

  assert.deepEqual(result, {
    statusCode: 200,
    payload: {
      ok: true,
      status: "ok",
      environment: "test",
      database: {
        connected: true,
        name: "blindleia_test",
        table_prefix: "bd_test_",
      },
    },
  });
  assert.deepEqual(queries, [{ sql: "SELECT 1 AS ok", params: [] }]);
});

test("API health preserves a 200 response with connected=false when the DB probe fails", async () => {
  const sessions = {
    async withConnection() {
      throw new Error("database unavailable");
    },
  };
  const health = new MySqlRuntimeHealthRepository(sessions, "bd_test_", "bd_prod_");
  const router = new RuntimeHealthRouter(config(), health);

  const result = await router.handle("GET", "/v1/health", request());

  assert.equal(result?.statusCode, 200);
  assert.equal(result?.payload.ok, true);
  assert.equal(result?.payload.status, "ok");
  assert.equal(result?.payload.database.connected, false);
});

test("deep health preserves diagnostics while respecting TEST runtime and shared identity boundaries", async () => {
  const { health, queries, executes } = deepFixture();
  const router = new RuntimeHealthRouter(config(), health);

  const result = await router.handle("GET", "/v1/health", request("/v1/health?deep=1"));

  assert.equal(result?.statusCode, 200);
  assert.equal(result?.payload.ok, true);
  const payload = result?.payload.health;
  assert.equal(payload.ok, true);
  assert.equal(payload.service, "blindleiadarts");
  assert.equal(payload.app_env, "test");
  assert.equal(payload.mode, "deep");
  assert.equal(payload.release.sha, "90071992547409999");
  assert.equal(payload.member_registry.source, "local_primary_database");

  assert.deepEqual(
    payload.diagnostics.map((item) => item.name),
    [
      "database",
      "core_schema",
      "member_registry",
      "membership_lookup",
      "critical_indexes",
      "stale_tournament_state",
      "stale_player_checkin",
      "player_profile",
      "player_matches",
      "member_dashboard",
    ],
  );

  const sql = queries.map((entry) => entry.sql).join("\n");
  assert.match(sql, /`bd_test_tournaments`/);
  assert.match(sql, /`bd_test_players`/);
  assert.match(sql, /`bd_prod_user_accounts`/);
  assert.doesNotMatch(sql, /screen_devices|scolia|kiosks/);
  assert.deepEqual(executes, []);

  const exactIdUses = queries
    .flatMap((entry) => entry.params)
    .filter((value) => value === "90071992547409931");
  assert.ok(exactIdUses.length >= 2);
});

test("deep health only reads PROD identity metadata and never runtime data from PROD", async () => {
  const { health, queries } = deepFixture();
  await health.deep("test", "sha");

  for (const { sql } of queries) {
    if (sql.includes("bd_prod_")) {
      assert.match(sql, /bd_prod_(?:auth_sessions|user_accounts)/);
    }
    assert.doesNotMatch(sql, /bd_prod_(?:tournaments|matches|players|tournament_players|clubs)/);
  }
});

test("runtime health route is GET-only", async () => {
  const health = {
    async ping() { throw new Error("POST must not ping"); },
    async deep() { throw new Error("POST must not run deep health"); },
  };
  const router = new RuntimeHealthRouter(config(), health);

  assert.equal(await router.handle("POST", "/v1/health", request()), null);
  assert.equal(await router.handle("GET", "/v1/clubs", request("/v1/clubs")), null);
});
