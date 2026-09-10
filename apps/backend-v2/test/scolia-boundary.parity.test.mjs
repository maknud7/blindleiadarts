import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import { asDbId } from "../dist/contracts/scoring.js";
import { DomainValidationError } from "../dist/domain/errors.js";
import {
  buildScoliaIngressIdentity,
  classifyScoliaEvent,
  scoliaEventPriority,
} from "../dist/domain/scolia-ingress.js";
import { mapScoliaSector } from "../dist/domain/scolia-sector.js";
import {
  buildScoliaVisitRequestKey,
  prepareCanonicalScoliaVisit,
} from "../dist/domain/scolia-visit.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const phpFixture = path.join(here, "php-scolia-parity-fixture.php");
const phpScoringService = readFileSync(
  path.join(here, "../../api/src/Service/ScoliaScoringService.php"),
  "utf8",
);
const phpIngressRepository = readFileSync(
  path.join(here, "../../api/src/Repository/ScoliaRoutedEventRepository.php"),
  "utf8",
);

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function phpResults(cases) {
  return JSON.parse(execFileSync("php", [phpFixture], {
    input: JSON.stringify(cases),
    encoding: "utf8",
  }));
}

function runTypescriptSector(vector) {
  try {
    return {
      ok: true,
      value: mapScoliaSector(vector.sector ?? "", vector.bounceout ?? false),
    };
  } catch (error) {
    if (error instanceof DomainValidationError) {
      return {
        ok: false,
        error: {
          code: error.code,
          status: error.statusCode,
          message: error.message,
        },
      };
    }
    throw error;
  }
}

test("TypeScript Scolia sector mapper matches canonical PHP behavior", () => {
  const vectors = [
    { operation: "sector", sector: "None" },
    { operation: "sector", sector: "", bounceout: false },
    { operation: "sector", sector: "T20", bounceout: true },
    { operation: "sector", sector: "25" },
    { operation: "sector", sector: "Bull" },
    { operation: "sector", sector: "s20" },
    { operation: "sector", sector: "D20" },
    { operation: "sector", sector: "t19" },
    { operation: "sector", sector: "S21" },
    { operation: "sector", sector: "outer-bull" },
  ];
  const php = phpResults(vectors);
  assert.equal(php.length, vectors.length);
  vectors.forEach((vector, index) => {
    assert.deepEqual(runTypescriptSector(vector), php[index], `Sector parity mismatch: ${vector.sector}`);
  });
});

test("Scolia event priorities match the existing PHP queue", () => {
  const types = [
    "THROW_DETECTED",
    "TAKEOUT_STARTED",
    "TAKEOUT_FINISHED",
    "BRIDGE_DISCONNECTED",
    "BRIDGE_ERROR",
    "HELLO_CLIENT",
    "BRIDGE_CONNECTED",
    "SBC_STATUS_CHANGED",
    "SBC_BOARD_AVAILABILITY_CHANGED",
    "FUTURE_EVENT",
  ];
  const php = phpResults(types.map((type) => ({ operation: "priority", type })));
  types.forEach((type, index) => {
    assert.deepEqual({ ok: true, value: scoliaEventPriority(type) }, php[index], `Priority mismatch: ${type}`);
  });
});

test("Scolia canonical visit request key stays identical to PHP", () => {
  const vectors = [
    ["1"],
    ["12", "13"],
    ["9223372036854775808", "18446744073709551615", "42"],
  ];
  const php = phpResults(vectors.map((event_ids) => ({ operation: "request_key", event_ids })));
  vectors.forEach((ids, index) => {
    const typedIds = ids.map(asDbId);
    assert.deepEqual(
      { ok: true, value: buildScoliaVisitRequestKey(typedIds, sha256Hex) },
      php[index],
      `Request-key mismatch: ${ids.join(",")}`,
    );
  });
});

test("Scolia ingress identity is deterministic before MySQL", () => {
  const withProviderId = buildScoliaIngressIdentity(
    "  abc-123  ",
    { id: " evt-7 ", type: " throw_detected ", payload: { sector: "T20" } },
    sha256Hex,
  );
  assert.equal(withProviderId.serial_number, "ABC-123");
  assert.equal(withProviderId.provider_event_id, "evt-7");
  assert.equal(withProviderId.event_type, "THROW_DETECTED");
  assert.equal(withProviderId.priority, 100);
  assert.equal(withProviderId.dedupe_basis, "id:ABC-123:evt-7");
  assert.equal(withProviderId.dedupe_key, sha256Hex(withProviderId.dedupe_basis));

  const message = { type: "TAKEOUT_FINISHED", payload: { falseTakeout: false } };
  const withoutProviderId = buildScoliaIngressIdentity("abc-123", message, sha256Hex);
  assert.equal(
    withoutProviderId.dedupe_basis,
    `payload:ABC-123:TAKEOUT_FINISHED:${JSON.stringify(message)}`,
  );
  assert.equal(withoutProviderId.dedupe_key, sha256Hex(withoutProviderId.dedupe_basis));
});

test("Scolia event classification keeps physical adapter work outside canonical scoring", () => {
  assert.deepEqual(classifyScoliaEvent("bridge_connected"), {
    kind: "connection",
    event_type: "BRIDGE_CONNECTED",
  });
  assert.deepEqual(classifyScoliaEvent("SBC_STATUS_CHANGED"), {
    kind: "runtime_status",
    event_type: "SBC_STATUS_CHANGED",
  });
  assert.deepEqual(classifyScoliaEvent("TAKEOUT_FINISHED"), {
    kind: "takeout",
    event_type: "TAKEOUT_FINISHED",
  });
  assert.deepEqual(classifyScoliaEvent("THROW_DETECTED"), {
    kind: "throw",
    event_type: "THROW_DETECTED",
  });
  assert.deepEqual(classifyScoliaEvent("something_new"), {
    kind: "ignore",
    event_type: "SOMETHING_NEW",
  });
});

test("assembled Scolia visit becomes one source-agnostic canonical scoring command", () => {
  const prepared = prepareCanonicalScoliaVisit({
    kiosk_id: asDbId("7"),
    match_id: asDbId("9007199254740993"),
    player_id: asDbId("18"),
    remaining_before: 100,
    darts: [
      { multiplier: "T", value: 20 },
      { multiplier: "D", value: 20 },
    ],
    event_ids: [asDbId("501"), asDbId("502")],
  }, sha256Hex);

  assert.equal(prepared.context.match_id, "9007199254740993");
  assert.equal(prepared.evaluation.score, 100);
  assert.equal(prepared.evaluation.is_checkout, true);
  assert.equal(prepared.canonical_command.source, "scolia");
  assert.deepEqual(prepared.canonical_command.payload, {
    input_mode: "per_dart",
    darts: [
      { multiplier: "T", value: 20 },
      { multiplier: "D", value: 20 },
    ],
    darts_used: 2,
    request_id: `scolia-${sha256Hex("501,502")}`,
  });
});

test("assembled Scolia visit refuses a non-idempotent buffer", () => {
  assert.throws(
    () => prepareCanonicalScoliaVisit({
      kiosk_id: asDbId("7"),
      match_id: asDbId("8"),
      player_id: asDbId("9"),
      remaining_before: 501,
      darts: [{ multiplier: "S", value: 20 }],
      event_ids: [],
    }, sha256Hex),
    (error) => error instanceof DomainValidationError && error.code === "scolia_buffer_event_mismatch",
  );
});

test("backend v2 Scolia boundary is anchored to current PHP idempotency and dedupe semantics", () => {
  assert.match(phpScoringService, /'scolia-'\s*\.\s*hash\('sha256',\s*implode\(',',\s*\$eventIds\)\)/);
  assert.match(phpScoringService, /\$this->scoring->recordVisit\(\$kioskId,/);
  assert.match(phpScoringService, /'source'\s*=>\s*'scolia'/);

  assert.match(phpIngressRepository, /'id:'\s*\.\s*\$serial\s*\.\s*':'\s*\.\s*\$providerId/);
  assert.match(phpIngressRepository, /'payload:'\s*\.\s*\$serial\s*\.\s*':'\s*\.\s*\$type/);
  assert.match(phpIngressRepository, /INSERT IGNORE INTO/);
  assert.match(phpIngressRepository, /scolia_test_leases/);
});
