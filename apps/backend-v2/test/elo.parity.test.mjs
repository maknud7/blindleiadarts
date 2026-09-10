import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { EloCalculator } from "../dist/domain/elo.js";

const cases = [
  { rating_a: 1000, rating_b: 1000, matches_a: 0, matches_b: 0, score_a: 1 },
  { rating_a: 1000, rating_b: 1000, matches_a: 0, matches_b: 0, score_a: 0.5 },
  { rating_a: 1050.125, rating_b: 975.75, matches_a: 10, matches_b: 11, score_a: 0 },
  { rating_a: 1182.345, rating_b: 942.5, matches_a: 11, matches_b: 25, score_a: 1 },
  { rating_a: 800, rating_b: 1400, matches_a: 5, matches_b: 5, score_a: 2 },
  { rating_a: 1400, rating_b: 800, matches_a: 12, matches_b: 12, score_a: -1 },
];

function phpResults() {
  const result = spawnSync("php", ["apps/backend-v2/test/php-elo-parity-fixture.php"], {
    input: JSON.stringify(cases),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("ELO calculator matches canonical PHP float behavior", () => {
  const calculator = new EloCalculator();
  const expected = phpResults();
  const actual = cases.map((entry) => calculator.calculate(
    entry.rating_a,
    entry.rating_b,
    entry.matches_a,
    entry.matches_b,
    entry.score_a,
  ));

  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index += 1) {
    const left = actual[index];
    const right = expected[index];
    for (const key of Object.keys(left)) {
      assert.ok(Math.abs(left[key] - right[key]) < 1e-12, `${index}:${key} differs: ${left[key]} vs ${right[key]}`);
    }
  }
});
