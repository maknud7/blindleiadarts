import assert from "node:assert/strict";
import test from "node:test";

import { ScoliaRealtimePublisher } from "../dist/runtime/scolia-realtime-publisher.js";

test("Scolia realtime publisher targets kiosk channel with raw input event", async () => {
  const calls = [];
  const publisher = new ScoliaRealtimePublisher(
    { publishUrl: "https://relay.example/publish", publishSecret: "secret", timeoutMs: 500 },
    async (url, init) => {
      calls.push({ url, init });
      return new Response("", { status: 200 });
    },
  );

  await publisher.publishInput("BOARD-4", {
    bridge_sequence: "123",
    message: { id: "evt-1", type: "THROW_DETECTED", payload: { sector: "T20" } },
  });

  assert.equal(calls.length, 1);
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body.channels, ["kiosk:BOARD-4"]);
  assert.equal(body.event, "scolia_input");
  assert.equal(body.payload.bridge_sequence, "123");
  assert.equal(body.payload.message.type, "THROW_DETECTED");
});

test("Scolia realtime publisher preserves per-kiosk publish order", async () => {
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const publisher = new ScoliaRealtimePublisher(
    { publishUrl: "https://relay.example/publish", publishSecret: "secret", timeoutMs: 500 },
    async (_url, init) => {
      const body = JSON.parse(String(init.body));
      const sequence = body.payload.bridge_sequence;
      order.push(`start:${sequence}`);
      if (sequence === "1") await firstGate;
      order.push(`end:${sequence}`);
      return new Response("", { status: 200 });
    },
  );

  const one = publisher.publishInput("BOARD-4", { bridge_sequence: "1" });
  const two = publisher.publishInput("BOARD-4", { bridge_sequence: "2" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ["start:1"]);
  releaseFirst();
  await Promise.all([one, two]);
  assert.deepEqual(order, ["start:1", "end:1", "start:2", "end:2"]);
});
