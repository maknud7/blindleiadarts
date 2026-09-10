import assert from "node:assert/strict";
import test from "node:test";

import { isReadStatement } from "../dist/mysql/mysql2-session-provider.js";

test("read guard accepts whitespace-separated read keywords including multiline SELECT", () => {
  assert.equal(isReadStatement("SELECT id FROM bd_test_matches"), true);
  assert.equal(isReadStatement("  SELECT\n  COUNT(*) AS c\nFROM bd_test_visits"), true);
  assert.equal(isReadStatement("SHOW TABLES"), true);
  assert.equal(isReadStatement("EXPLAIN\nSELECT id FROM bd_test_matches"), true);
});

test("read guard still rejects writes and keyword prefixes", () => {
  assert.equal(isReadStatement("UPDATE bd_test_matches SET status='completed'"), false);
  assert.equal(isReadStatement("INSERT INTO bd_test_visits (id) VALUES (1)"), false);
  assert.equal(isReadStatement("DELETE FROM bd_test_visits"), false);
  assert.equal(isReadStatement("SELECTED value"), false);
  assert.equal(isReadStatement("WITH changed AS (DELETE FROM bd_test_visits RETURNING id) SELECT * FROM changed"), false);
});
