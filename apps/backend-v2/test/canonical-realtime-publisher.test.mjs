import assert from "node:assert/strict";
import test from "node:test";

import { asDbId } from "../dist/contracts/scoring.js";
import { asTablePrefix } from "../dist/mysql/contracts.js";
import { CanonicalRealtimePublisher } from "../dist/runtime/canonical-realtime-publisher.js";

class FakeSessions {
  constructor(rows = [{ code: " board-4 ", club_id: "7" }]) {
    this.rows = rows;
    this.queries = [];
  }

  async withConnection(work) {
    return work({
      query: async (sql, params = []) => {
        this.queries.push({ sql, params });
        return this.rows;
      },
      execute: async () => {
        throw new Error("realtime lookup must be read-only");
      },
    });
  }

  async withTransaction() {
    throw new Error("realtime must never open a transaction");
  }
}

function input(overrides = {}) {
  return {
    kiosk_id: asDbId("9007199254740993"),
    match_id: asDbId("9007199254740995"),
    source: "scolia",
    reason: "visit_recorded",
    ...overrides,
  };
}

test("publishes the PHP-compatible snapshot shape to kiosk and club channels", async () => {
  const sessions = new FakeSessions();
  const requests = [];
  const publisher = new CanonicalRealtimePublisher(
    sessions,
    asTablePrefix("bd_test_"),
    { publishUrl: "https://realtime.example.test/publish", publishSecret: "shared-secret", timeoutMs: 1500 },
    async (url, init) => {
      requests.push({ url, init });
      return new Response("accepted", { status: 202 });
    },
  );

  await publisher.publishRefresh(input());

  assert.equal(sessions.queries.length, 1);
  assert.match(sessions.queries[0].sql, /FROM `bd_test_kiosks` WHERE id=\? LIMIT 1/);
  assert.deepEqual(sessions.queries[0].params, ["9007199254740993"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://realtime.example.test/publish");
  assert.equal(requests[0].init.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    secret: "shared-secret",
    channels: ["kiosk:board-4", "club:7"],
    event: "snapshot",
    payload: {
      refresh: true,
      reason: "visit_recorded",
      source: "scolia",
      kiosk_id: "9007199254740993",
      match_id: "9007199254740995",
    },
  });
});

test("disabled publisher does not spend a scarce MySQL slot", async () => {
  const sessions = new FakeSessions();
  let fetches = 0;
  const publisher = new CanonicalRealtimePublisher(
    sessions,
    asTablePrefix("bd_test_"),
    { publishUrl: null, publishSecret: null },
    async () => {
      fetches += 1;
      return new Response();
    },
  );

  await publisher.publishRefresh(input());
  assert.equal(sessions.queries.length, 0);
  assert.equal(fetches, 0);
});

test("missing kiosk or channels is a no-op", async () => {
  for (const rows of [[], [{ code: "  ", club_id: null }]]) {
    const sessions = new FakeSessions(rows);
    let fetches = 0;
    const publisher = new CanonicalRealtimePublisher(
      sessions,
      asTablePrefix("bd_test_"),
      { publishUrl: "https://realtime.example.test/publish", publishSecret: "secret" },
      async () => {
        fetches += 1;
        return new Response();
      },
    );
    await publisher.publishRefresh(input());
    assert.equal(fetches, 0);
  }
});

test("relay errors and kiosk lookup errors are best effort after canonical commit", async () => {
  const warnings = [];
  const logger = { warn: (message, details) => warnings.push({ message, details }) };

  const relayFailure = new CanonicalRealtimePublisher(
    new FakeSessions(),
    asTablePrefix("bd_test_"),
    { publishUrl: "https://realtime.example.test/publish", publishSecret: "secret" },
    async () => { throw new Error("relay unavailable"); },
    logger,
  );
  await assert.doesNotReject(() => relayFailure.publishRefresh(input()));

  const lookupSessions = {
    withConnection: async () => { throw new Error("lookup unavailable"); },
    withTransaction: async () => { throw new Error("not used"); },
  };
  const lookupFailure = new CanonicalRealtimePublisher(
    lookupSessions,
    asTablePrefix("bd_test_"),
    { publishUrl: "https://realtime.example.test/publish", publishSecret: "secret" },
    async () => new Response(),
    logger,
  );
  await assert.doesNotReject(() => lookupFailure.publishRefresh(input()));
  assert.equal(warnings.length, 2);
});

test("relay exchange is bounded by the configured timeout", async () => {
  const publisher = new CanonicalRealtimePublisher(
    new FakeSessions(),
    asTablePrefix("bd_test_"),
    { publishUrl: "https://realtime.example.test/publish", publishSecret: "secret", timeoutMs: 10 },
    async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  );

  const started = Date.now();
  await assert.doesNotReject(() => publisher.publishRefresh(input()));
  assert.ok(Date.now() - started < 500, "best-effort timeout should bound the relay call");
});
