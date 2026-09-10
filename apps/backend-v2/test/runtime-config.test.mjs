import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMutationAllowed,
  loadRuntimeConfig,
  mutationsAllowed,
} from "../dist/runtime/config.js";

function baseEnv(overrides = {}) {
  return {
    BD_APP_ENV: "test",
    BD_BACKEND_V2_MODE: "readonly",
    DB_HOST: "db.example.test",
    DB_PORT: "3306",
    DB_NAME: "darts",
    DB_USERNAME: "backend-v2",
    DB_PASSWORD: "secret",
    DB_TABLE_PREFIX: "bd_test_",
    ...overrides,
  };
}

test("readonly is the safe default and keeps one MySQL slot with short idle reuse", () => {
  const config = loadRuntimeConfig(baseEnv({ BD_BACKEND_V2_MODE: undefined }));
  assert.equal(config.mode, "readonly");
  assert.equal(config.mysql.budget.maxConcurrentConnections, 1);
  assert.equal(config.mysql.idleConnectionTimeoutMs, 15_000);
  assert.equal(config.canonicalSideEffectsReady, false);
  assert.equal(mutationsAllowed(config), false);
  assert.throws(() => assertMutationAllowed(config), /read-only mode/);
});

test("MySQL idle reuse can be tuned without changing the connection budget", () => {
  const config = loadRuntimeConfig(baseEnv({ BD_BACKEND_V2_DB_IDLE_MS: "5000" }));
  assert.equal(config.mysql.idleConnectionTimeoutMs, 5000);
  assert.equal(config.mysql.budget.maxConcurrentConnections, 1);
});

test("TEST writes require test environment, test prefix and internal token", () => {
  const config = loadRuntimeConfig(baseEnv({
    BD_BACKEND_V2_MODE: "test-write",
    BD_BACKEND_V2_INTERNAL_TOKEN: "e2e-token",
  }));
  assert.equal(config.mode, "test-write");
  assert.equal(mutationsAllowed(config), true);
  assert.doesNotThrow(() => assertMutationAllowed(config));

  assert.throws(
    () => loadRuntimeConfig(baseEnv({
      BD_BACKEND_V2_MODE: "test-write",
      BD_APP_ENV: "prod",
      BD_BACKEND_V2_INTERNAL_TOKEN: "e2e-token",
    })),
    /requires BD_APP_ENV=test/,
  );
  assert.throws(
    () => loadRuntimeConfig(baseEnv({
      BD_BACKEND_V2_MODE: "test-write",
      DB_TABLE_PREFIX: "bd_prod_",
      BD_BACKEND_V2_INTERNAL_TOKEN: "e2e-token",
    })),
    /requires DB_TABLE_PREFIX=bd_test_/,
  );
  assert.throws(
    () => loadRuntimeConfig(baseEnv({ BD_BACKEND_V2_MODE: "test-write" })),
    /require BD_BACKEND_V2_INTERNAL_TOKEN/,
  );
});

test("PROD canary remains read-only even when the legacy write confirmation is supplied", () => {
  const safeCanary = loadRuntimeConfig(baseEnv({
    BD_APP_ENV: "prod",
    BD_BACKEND_V2_MODE: "prod-canary",
    DB_TABLE_PREFIX: "bd_prod_",
    IDENTITY_TABLE_PREFIX: "bd_prod_",
    HARDWARE_TABLE_PREFIX: "bd_prod_",
    BD_BACKEND_V2_INTERNAL_TOKEN: "canary-token",
  }));
  assert.equal(mutationsAllowed(safeCanary), false);
  assert.equal(safeCanary.canonicalSideEffectsReady, false);
  assert.throws(() => assertMutationAllowed(safeCanary), /full canonical side effects/);

  const confirmedCanary = loadRuntimeConfig(baseEnv({
    BD_APP_ENV: "prod",
    BD_BACKEND_V2_MODE: "prod-canary",
    DB_TABLE_PREFIX: "bd_prod_",
    BD_BACKEND_V2_INTERNAL_TOKEN: "canary-token",
    BD_BACKEND_V2_PROD_WRITE_CONFIRMATION: "ALLOW_PROD_SCORING_WRITES",
  }));
  assert.equal(confirmedCanary.prodCanaryWritesEnabled, false);
  assert.equal(mutationsAllowed(confirmedCanary), false);
  assert.throws(() => assertMutationAllowed(confirmedCanary), /full canonical side effects/);
});

test("coexistence hard caps backend-v2 at two database connections", () => {
  assert.throws(
    () => loadRuntimeConfig(baseEnv({ BD_BACKEND_V2_MAX_CONNECTIONS: "3" })),
    /may not exceed 2/,
  );
});
