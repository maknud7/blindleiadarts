import assert from "node:assert/strict";
import test from "node:test";

import { ScoliaEventProcessor } from "../dist/service/scolia-event-processor.js";

function bridgeWithBuffer(initial) {
  let buffer = structuredClone(initial);
  const commands = [];
  return {
    commands,
    async getVisitBuffer() { return buffer ? structuredClone(buffer) : null; },
    async saveVisitBuffer(next) { buffer = structuredClone(next); },
    async clearVisitBuffer() { buffer = null; },
    async queueCommand(clubId, kioskId, type, payload) {
      const command = { id: String(commands.length + 1), club_id: clubId, kiosk_id: kioskId, command_type: type, payload };
      commands.push(command);
      return command;
    },
  };
}

const scoring = {
  async startMatch() { return { kind: "no_match" }; },
  async recordVisit() { return { kind: "duplicate" }; },
  async undoLastVisit() { return { kind: "no_visit" }; },
};

const initial = {
  kiosk_id: "17",
  match_id: "99",
  player_id: "5",
  darts: [
    { multiplier: "T", value: 20 },
    { multiplier: "S", value: 5 },
  ],
  event_ids: ["41", "42"],
  provider_event_ids: ["provider-41", "provider-42"],
};

test("delete buffered throw keeps event/provider arrays aligned and queues bridge command", async () => {
  const bridge = bridgeWithBuffer(initial);
  const processor = new ScoliaEventProcessor(bridge, scoring);
  const result = await processor.deleteBufferedThrow("11", "17", 0, null);
  assert.deepEqual(result.buffer.darts, [{ multiplier: "S", value: 5 }]);
  assert.deepEqual(result.buffer.event_ids, ["42"]);
  assert.deepEqual(result.buffer.provider_event_ids, ["provider-42"]);
  assert.equal(bridge.commands[0].command_type, "DELETE_THROW");
  assert.deepEqual(bridge.commands[0].payload, { throwIndex: 0 });
});

test("correct buffered throw normalizes sector and queues correction command", async () => {
  const bridge = bridgeWithBuffer(initial);
  const processor = new ScoliaEventProcessor(bridge, scoring);
  const result = await processor.correctBufferedThrow("11", "17", 1, "D20", null);
  assert.deepEqual(result.buffer.darts[1], { multiplier: "D", value: 20 });
  assert.equal(bridge.commands[0].command_type, "CORRECT_THROW");
  assert.deepEqual(bridge.commands[0].payload, { throwIndex: 1, sector: "D20" });
});
