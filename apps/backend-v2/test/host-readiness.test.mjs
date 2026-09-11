import assert from "node:assert/strict";
import test from "node:test";

import { verifyReadOnlyHost } from "../scripts/verify-host-readiness.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function payloads(overrides = {}) {
  const health = {
    ok: true,
    service: "blindleia-backend-v2",
    environment: "prod",
    mode: "readonly",
    writes_armed: false,
    canonical_side_effects_ready: true,
    release_sha: SHA,
    runtime_prefix: "bd_prod_",
    max_connections: 1,
    connection_mode: "idle-reuse",
    ...overrides.health,
  };
  const ready = {
    ok: true,
    service: "blindleia-backend-v2",
    environment: "prod",
    mode: "readonly",
    writes_armed: false,
    canonical_side_effects_ready: true,
    release_sha: SHA,
    runtime_prefix: "bd_prod_",
    mysql_version: "8.0-test",
    checked_tables: [
      "bd_prod_matches",
      "bd_prod_legs",
      "bd_prod_visits",
      "bd_prod_match_statistics",
    ],
    ...overrides.ready,
  };
  return { health, ready };
}

function fakeFetch(bodies) {
  return async (url) => {
    const pathname = new URL(url).pathname;
    const body = pathname === "/health" ? bodies.health : pathname === "/ready" ? bodies.ready : null;
    if (body === null) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
}

test("accepts only the exact read-only production host contract", async () => {
  const result = await verifyReadOnlyHost({
    baseUrl: "https://backend.example.test/some/path?ignored=yes",
    expectedReleaseSha: SHA,
    fetchImpl: fakeFetch(payloads()),
  });

  assert.equal(result.ok, true);
  assert.equal(result.release_sha, SHA);
  assert.equal(result.mysql_version, "8.0-test");
  assert.equal(result.checked_tables.length, 4);
});

test("rejects a host that has writes armed even when every other field is safe", async () => {
  await assert.rejects(
    verifyReadOnlyHost({
      baseUrl: "https://backend.example.test",
      expectedReleaseSha: SHA,
      fetchImpl: fakeFetch(payloads({ health: { writes_armed: true } })),
    }),
    /health\.writes_armed expected false, got true/,
  );
});

test("rejects a different deployed release SHA", async () => {
  await assert.rejects(
    verifyReadOnlyHost({
      baseUrl: "https://backend.example.test",
      expectedReleaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      fetchImpl: fakeFetch(payloads()),
    }),
    /health\.release_sha/,
  );
});

test("rejects readiness that did not validate every canonical scoring table", async () => {
  await assert.rejects(
    verifyReadOnlyHost({
      baseUrl: "https://backend.example.test",
      expectedReleaseSha: SHA,
      fetchImpl: fakeFetch(payloads({
        ready: {
          checked_tables: ["bd_prod_matches", "bd_prod_legs", "bd_prod_visits"],
        },
      })),
    }),
    /bd_prod_match_statistics/,
  );
});

test("rejects more than one backend-v2 database connection slot", async () => {
  await assert.rejects(
    verifyReadOnlyHost({
      baseUrl: "https://backend.example.test",
      expectedReleaseSha: SHA,
      fetchImpl: fakeFetch(payloads({ health: { max_connections: 2 } })),
    }),
    /health\.max_connections expected 1, got 2/,
  );
});
