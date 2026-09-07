import assert from "node:assert/strict";
import {
  hasScoliaPhysicalStatus,
  normalizeScoliaStatusPayload,
  resolvePendingScoliaCommand,
} from "./scolia-protocol.js";

{
  const payload = normalizeScoliaStatusPayload({ sbcStatus: "SBC_STATUS_RUNNING" });
  assert.equal(payload.status, "SBC_STATUS_RUNNING");
  assert.equal(hasScoliaPhysicalStatus(payload), true);
}

{
  const payload = normalizeScoliaStatusPayload({ data: { boardStatus: "Running", boardPhase: "Throw" } });
  assert.equal(payload.status, "Running");
  assert.equal(payload.boardPhase, "Throw");
}

{
  const pending = new Map([["cmd-1", { commandId: 10, commandType: "GET_SBC_STATUS" }]]);
  const match = resolvePendingScoliaCommand({
    type: "ACK",
    payload: { requestMessageId: "cmd-1", sbcStatus: "SBC_STATUS_RUNNING" },
  }, pending);
  assert.equal(match?.key, "cmd-1");
  assert.equal(match?.inferred, false);
}

{
  const pending = new Map([["cmd-2", { commandId: 11, commandType: "GET_SBC_STATUS" }]]);
  const match = resolvePendingScoliaCommand({
    type: "ACK",
    payload: { sbcStatus: "SBC_STATUS_RUNNING" },
  }, pending);
  assert.equal(match?.key, "cmd-2");
  assert.equal(match?.inferred, true);
}

{
  const pending = new Map([["cmd-3", { commandId: 12, commandType: "DELETE_THROW" }]]);
  const match = resolvePendingScoliaCommand({ type: "ACK", payload: { status: "OK" } }, pending);
  assert.equal(match, null);
}

{
  const pending = new Map([
    ["cmd-4", { commandId: 13, commandType: "GET_SBC_STATUS" }],
    ["cmd-5", { commandId: 14, commandType: "GET_SBC_STATUS" }],
  ]);
  const match = resolvePendingScoliaCommand({ type: "ACK", payload: { sbcStatus: "SBC_STATUS_RUNNING" } }, pending);
  assert.equal(match, null);
}

console.log("Scolia protocol tests passed");
