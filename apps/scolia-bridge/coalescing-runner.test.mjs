import assert from "node:assert/strict";
import { createCoalescingRunner } from "./coalescing-runner.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

{
  const gate = deferred();
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const runner = createCoalescingRunner(async () => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (calls === 1) await gate.promise;
    active -= 1;
  });

  const first = runner.trigger();
  await Promise.resolve();
  const second = runner.trigger();
  const third = runner.trigger();
  assert.equal(runner.isRunning(), true);
  gate.resolve();
  await Promise.all([first, second, third]);

  assert.equal(calls, 2, "triggers received while running must cause one immediate follow-up pass");
  assert.equal(maxActive, 1, "coalesced task must never overlap itself");
}

{
  let calls = 0;
  const runner = createCoalescingRunner(async () => {
    calls += 1;
  });
  await runner.trigger();
  await runner.trigger();
  assert.equal(calls, 2, "a new trigger after idle must run again");
}

{
  let calls = 0;
  const runner = createCoalescingRunner(async () => {
    calls += 1;
    if (calls === 1) throw new Error("expected failure");
  });
  await assert.rejects(runner.trigger(), /expected failure/);
  await runner.trigger();
  assert.equal(calls, 2, "runner must recover after a failed pass");
}

console.log("Scolia bridge coalescing runner: OK");
