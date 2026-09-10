import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import { evaluateVisit } from "../dist/domain/dart501.js";
import { DomainValidationError } from "../dist/domain/errors.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const phpFixture = path.join(here, "php-parity-fixture.php");

const vectors = [
  { name: "normal sum", remaining_before: 501, payload: { input_mode: "sum", score: 60, darts_used: 3 } },
  { name: "maximum sum", remaining_before: 501, payload: { input_mode: "sum", score: 180, darts_used: 3 } },
  { name: "sum checkout", remaining_before: 40, payload: { input_mode: "sum", score: 40, darts_used: 2 } },
  { name: "sum leaves one and busts", remaining_before: 61, payload: { input_mode: "sum", score: 60 } },
  { name: "sum goes below zero and busts", remaining_before: 32, payload: { input_mode: "sum", score: 60 } },
  { name: "impossible checkout number busts", remaining_before: 159, payload: { input_mode: "sum", score: 159 } },
  { name: "invalid visit total", remaining_before: 501, payload: { input_mode: "sum", score: 179 } },
  { name: "invalid darts used in sum", remaining_before: 501, payload: { input_mode: "sum", score: 60, darts_used: 4 } },
  { name: "normal per dart", remaining_before: 501, payload: { input_mode: "per_dart", darts: [{ multiplier: "T", value: 20 }, { multiplier: "S", value: 5 }, { multiplier: "D", value: 10 }] } },
  { name: "per dart miss", remaining_before: 301, payload: { input_mode: "per_dart", darts: [{ multiplier: "S", value: 0 }, { multiplier: "S", value: 20 }, { multiplier: "S", value: 20 }] } },
  { name: "single bull", remaining_before: 101, payload: { input_mode: "per_dart", darts: [{ multiplier: "S", value: "BULL" }] } },
  { name: "double bull checkout", remaining_before: 50, payload: { input_mode: "per_dart", darts: [{ multiplier: "D", value: "BULL" }] } },
  { name: "double checkout", remaining_before: 40, payload: { input_mode: "per_dart", darts: [{ multiplier: "D", value: 20 }] } },
  { name: "single into zero busts", remaining_before: 20, payload: { input_mode: "per_dart", darts: [{ multiplier: "S", value: 20 }] } },
  { name: "per dart leaves one and busts", remaining_before: 21, payload: { input_mode: "per_dart", darts: [{ multiplier: "S", value: 20 }] } },
  { name: "darts after checkout rejected", remaining_before: 40, payload: { input_mode: "per_dart", darts: [{ multiplier: "D", value: 20 }, { multiplier: "S", value: 0 }] } },
  { name: "triple bull rejected", remaining_before: 100, payload: { input_mode: "per_dart", darts: [{ multiplier: "T", value: "BULL" }] } },
  { name: "double miss rejected", remaining_before: 100, payload: { input_mode: "per_dart", darts: [{ multiplier: "D", value: 0 }] } },
  { name: "invalid multiplier rejected", remaining_before: 100, payload: { input_mode: "per_dart", darts: [{ multiplier: "Q", value: 20 }] } },
  { name: "invalid dart value rejected", remaining_before: 100, payload: { input_mode: "per_dart", darts: [{ multiplier: "S", value: 21 }] } },
  { name: "missing per dart payload rejected", remaining_before: 100, payload: { input_mode: "per_dart" } },
  { name: "invalid input mode", remaining_before: 501, payload: { input_mode: "automatic", score: 60 } },
  { name: "invalid remaining below two", remaining_before: 1, payload: { input_mode: "sum", score: 0 } },
  { name: "invalid remaining above start", remaining_before: 502, payload: { input_mode: "sum", score: 0 } },
];

function runTypescript(vector) {
  try {
    return {
      ok: true,
      value: evaluateVisit(vector.remaining_before, vector.payload),
    };
  } catch (error) {
    if (error instanceof DomainValidationError) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          status_code: error.statusCode,
        },
      };
    }
    throw error;
  }
}

test("TypeScript 501 domain matches canonical PHP behavior", () => {
  const phpOutput = execFileSync("php", [phpFixture], {
    input: JSON.stringify(vectors),
    encoding: "utf8",
  });
  const phpResults = JSON.parse(phpOutput);
  assert.equal(phpResults.length, vectors.length);

  vectors.forEach((vector, index) => {
    assert.deepEqual(
      runTypescript(vector),
      phpResults[index],
      `Parity mismatch for: ${vector.name}`,
    );
  });
});
