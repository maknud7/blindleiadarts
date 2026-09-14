import assert from "node:assert/strict";
import test from "node:test";

import { PublicLiveReadRouter } from "../dist/runtime/public-live-read-router.js";

test("public live router owns canonical club list GET", async () => {
  let calls = 0;
  const reads = {
    async listClubs() {
      calls += 1;
      return [
        { id: "9007199254740993", name: "Blindleia Dartklubb", slug: "blindleia", player_count: 20 },
      ];
    },
  };
  const router = new PublicLiveReadRouter(reads);
  const result = await router.handle("GET", "/v1/clubs", { url: "/v1/clubs" });
  assert.equal(calls, 1);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.payload, {
    ok: true,
    items: [{ id: "9007199254740993", name: "Blindleia Dartklubb", slug: "blindleia", player_count: 20 }],
  });
});

test("club list remains GET-only", async () => {
  const reads = { async listClubs() { throw new Error("must not be called"); } };
  const router = new PublicLiveReadRouter(reads);
  assert.equal(await router.handle("POST", "/v1/clubs", { url: "/v1/clubs" }), null);
});
