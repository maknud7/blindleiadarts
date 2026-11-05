import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { evaluateVisit, minimumCheckoutDarts } from "../dist/domain/dart501.js";

test("physical checkout dart counts are bounded by an actual double finish", () => {
  assert.equal(minimumCheckoutDarts(40), 1);
  assert.equal(minimumCheckoutDarts(50), 1);
  assert.equal(minimumCheckoutDarts(100), 2);
  assert.equal(minimumCheckoutDarts(110), 2);
  assert.equal(minimumCheckoutDarts(120), 3);
  assert.equal(minimumCheckoutDarts(150), 3);
  assert.equal(minimumCheckoutDarts(170), 3);
  assert.equal(minimumCheckoutDarts(159), 4);
});

test("sum checkout rejects impossible 1- and 2-dart claims without changing canonical state", () => {
  for (const dartsUsed of [1, 2]) {
    assert.throws(() => evaluateVisit(150, {
      input_mode: "sum",
      score: 150,
      darts_used: dartsUsed,
    }), (error) => error?.code === "checkout_darts_impossible");
  }
  assert.throws(() => evaluateVisit(100, { input_mode: "sum", score: 100, darts_used: 1 }),
    (error) => error?.code === "checkout_darts_impossible");
  assert.equal(evaluateVisit(150, { input_mode: "sum", score: 150, darts_used: 3 }).is_checkout, true);
  assert.equal(evaluateVisit(100, { input_mode: "sum", score: 100, darts_used: 2 }).is_checkout, true);
  assert.equal(evaluateVisit(40, { input_mode: "sum", score: 40, darts_used: 1 }).is_checkout, true);
});

test("kiosk safely rejects old winner resurrection and only explicitly skips hold", () => {
  const kiosk = fs.readFileSync("apps/platform-v2/src/kiosk/KioskWorkspace.tsx", "utf8");
  const router = fs.readFileSync("apps/backend-v2/src/runtime/tournament-operations-legacy-router.ts", "utf8");
  const repo = fs.readFileSync("apps/backend-v2/src/mysql/tournament-operations-repository.ts", "utf8");

  assert.match(kiosk, /dismissedCompletedMatchRef/);
  assert.match(kiosk, /Number\(previous.id\) !== dismissedCompletedMatchRef.current/);
  assert.match(kiosk, /body: \{ advance_now: advanceNow \}/);
  assert.match(kiosk, /setCompletion\(null\)/);
  assert.match(kiosk, /reservation_wait/);
  assert.match(router, /nextBody.advance_now === true/);
  assert.match(repo, /if \(advanceNow\)/);
  assert.match(repo, /status='completed'/);
  assert.match(kiosk, /used < minimumCheckoutDarts\(checkoutScore\)/);
});
