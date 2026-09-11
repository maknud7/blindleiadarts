import assert from "node:assert/strict";
import test from "node:test";

import { loadRuntimeConfig } from "../dist/runtime/config.js";
import { assertProductionHardwareMutationAllowed } from "../dist/runtime/equipment-admin-router.js";

function env(overrides = {}) {
  return {
    DB_HOST: "db.example.test",
    DB_NAME: "blindleia",
    DB_USERNAME: "test",
    DB_PASSWORD: "test",
    BD_BACKEND_V2_INTERNAL_TOKEN: "internal-test-token",
    BD_BACKEND_V2_MAX_CONNECTIONS: "1",
    ...overrides,
  };
}

test("TEST can read PROD hardware but cannot mutate it", () => {
  const config = loadRuntimeConfig(env({
    BD_APP_ENV: "test",
    BD_BACKEND_V2_MODE: "test-write",
    DB_TABLE_PREFIX: "bd_test_",
    IDENTITY_TABLE_PREFIX: "bd_test_",
    HARDWARE_TABLE_PREFIX: "bd_prod_",
  }));

  assert.throws(
    () => assertProductionHardwareMutationAllowed(config),
    (error) => error?.code === "production_hardware_read_only" && error?.statusCode === 403,
  );
});

test("armed PROD can mutate only canonical bd_prod_ hardware", () => {
  const config = loadRuntimeConfig(env({
    BD_APP_ENV: "prod",
    BD_BACKEND_V2_MODE: "prod-canary",
    DB_TABLE_PREFIX: "bd_prod_",
    IDENTITY_TABLE_PREFIX: "bd_prod_",
    HARDWARE_TABLE_PREFIX: "bd_prod_",
    BD_BACKEND_V2_PROD_WRITE_CONFIRMATION: "ALLOW_PROD_SCORING_WRITES",
  }));

  assert.doesNotThrow(() => assertProductionHardwareMutationAllowed(config));
});

test("PROD refuses a non-canonical hardware prefix even when writes are armed", () => {
  const config = loadRuntimeConfig(env({
    BD_APP_ENV: "prod",
    BD_BACKEND_V2_MODE: "prod-canary",
    DB_TABLE_PREFIX: "bd_prod_",
    IDENTITY_TABLE_PREFIX: "bd_prod_",
    HARDWARE_TABLE_PREFIX: "bd_test_",
    BD_BACKEND_V2_PROD_WRITE_CONFIRMATION: "ALLOW_PROD_SCORING_WRITES",
  }));

  assert.throws(
    () => assertProductionHardwareMutationAllowed(config),
    (error) => error?.code === "production_hardware_write_blocked" && error?.statusCode === 403,
  );
});
