import assert from "node:assert/strict";
import test from "node:test";

import { MySqlClubAdminRepository } from "../dist/mysql/club-admin-repository.js";
import { ClubAdminRouter } from "../dist/runtime/club-admin-router.js";

function config() {
  return {
    environment: "test",
    mode: "readonly",
    host: "127.0.0.1",
    port: 18082,
    releaseSha: "test",
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

function request() {
  return { headers: {}, async *[Symbol.asyncIterator]() {} };
}

test("API health is a readonly database probe with the legacy response shape", async () => {
  const queries = [];
  const db = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      return [{ ok: 1 }];
    },
  };
  const sessions = {
    async withConnection(work) { return work(db); },
  };
  const clubs = new MySqlClubAdminRepository(sessions, "bd_test_");
  const identityRepository = {
    async findBySessionToken() {
      throw new Error("health must not touch shared identity");
    },
  };
  const router = new ClubAdminRouter(config(), identityRepository, clubs);

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
  assert.doesNotMatch(queries[0].sql, /bd_prod_/);
});

test("API health preserves a 200 response with connected=false when the DB probe fails", async () => {
  const sessions = {
    async withConnection() {
      throw new Error("database unavailable");
    },
  };
  const clubs = new MySqlClubAdminRepository(sessions, "bd_test_");
  const identityRepository = {
    async findBySessionToken() {
      throw new Error("health must not touch shared identity");
    },
  };
  const router = new ClubAdminRouter(config(), identityRepository, clubs);

  const result = await router.handle("GET", "/v1/health", request());

  assert.equal(result?.statusCode, 200);
  assert.equal(result?.payload.ok, true);
  assert.equal(result?.payload.status, "ok");
  assert.equal(result?.payload.database.connected, false);
});

test("API health route is GET-only", async () => {
  const clubs = {
    async ping() {
      throw new Error("POST must not reach health probe");
    },
  };
  const identityRepository = {
    async findBySessionToken() {
      throw new Error("POST must not touch identity");
    },
  };
  const router = new ClubAdminRouter(config(), identityRepository, clubs);

  assert.equal(await router.handle("POST", "/v1/health", request()), null);
}