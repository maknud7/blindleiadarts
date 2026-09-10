import assert from "node:assert/strict";
import test from "node:test";

import { loadRuntimeConfig } from "../dist/runtime/config.js";

function env(overrides = {}) {
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

test("realtime publishing is disabled by default and keeps PHP-compatible 1500 ms timeout", () => {
  const config = loadRuntimeConfig(env());
  assert.equal(config.realtime.publishEnabled, false);
  assert.equal(config.realtime.publishUrl, null);
  assert.equal(config.realtime.publishSecret, null);
  assert.equal(config.realtime.timeoutMs, 1500);
});

test("realtime publishing requires both URL and secret", () => {
  assert.equal(loadRuntimeConfig(env({ REALTIME_PUBLISH_URL: "https://relay.test/publish" })).realtime.publishEnabled, false);
  assert.equal(loadRuntimeConfig(env({ REALTIME_PUBLISH_SECRET: "secret" })).realtime.publishEnabled, false);

  const config = loadRuntimeConfig(env({
    REALTIME_PUBLISH_URL: " https://relay.test/publish ",
    REALTIME_PUBLISH_SECRET: " relay-secret ",
    BD_BACKEND_V2_REALTIME_TIMEOUT_MS: "1750",
  }));
  assert.equal(config.realtime.publishEnabled, true);
  assert.equal(config.realtime.publishUrl, "https://relay.test/publish");
  assert.equal(config.realtime.publishSecret, "relay-secret");
  assert.equal(config.realtime.timeoutMs, 1750);
});

test("realtime timeout is bounded", () => {
  assert.throws(
    () => loadRuntimeConfig(env({ BD_BACKEND_V2_REALTIME_TIMEOUT_MS: "10001" })),
    /may not exceed 10000/,
  );
});
