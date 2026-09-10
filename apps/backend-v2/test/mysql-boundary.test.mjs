import assert from "node:assert/strict";
import test from "node:test";

import { asDbId } from "../dist/contracts/scoring.js";
import {
  asTablePrefix,
  validateConnectionBudget,
} from "../dist/mysql/contracts.js";

test("BIGINT database ids stay decimal strings", () => {
  const beyondSafeInteger = "18446744073709551615";
  assert.equal(asDbId(beyondSafeInteger), beyondSafeInteger);
  assert.equal(typeof asDbId("42"), "string");
  assert.throws(() => asDbId("0"), /positive decimal string/);
  assert.throws(() => asDbId("-1"), /positive decimal string/);
  assert.throws(() => asDbId("1.5"), /positive decimal string/);
  assert.throws(() => asDbId("1 OR 1=1"), /positive decimal string/);
});

test("table prefixes use the same conservative character set as PHP", () => {
  assert.equal(asTablePrefix("bd_test_"), "bd_test_");
  assert.equal(asTablePrefix("prod1_"), "prod1_");
  assert.throws(() => asTablePrefix("bd-test_"), /Invalid database table prefix/);
  assert.throws(() => asTablePrefix("bd`; DROP TABLE visits; --"), /Invalid database table prefix/);
});

test("hosted MySQL connection budget must always be explicit and positive", () => {
  assert.deepEqual(
    validateConnectionBudget({ maxConcurrentConnections: 2, acquireTimeoutMs: 1500, slotStart: 6 }),
    { maxConcurrentConnections: 2, acquireTimeoutMs: 1500, slotStart: 6 },
  );
  assert.throws(
    () => validateConnectionBudget({ maxConcurrentConnections: 0, acquireTimeoutMs: 1500 }),
    /positive integer/,
  );
  assert.throws(
    () => validateConnectionBudget({ maxConcurrentConnections: 2, acquireTimeoutMs: 0 }),
    /positive integer/,
  );
});
