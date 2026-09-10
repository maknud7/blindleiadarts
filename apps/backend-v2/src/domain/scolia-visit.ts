import type { DbId, NormalizedDart } from "../contracts/scoring.js";
import type { PreparedScoliaVisit } from "../contracts/scolia.js";
import { evaluateVisit } from "./dart501.js";
import { DomainValidationError } from "./errors.js";
import type { Sha256Hex } from "./scolia-ingress.js";

export function buildScoliaVisitRequestKey(eventIds: readonly DbId[], sha256Hex: Sha256Hex): string {
  if (eventIds.length === 0) {
    throw new DomainValidationError(
      "scolia_buffer_missing_events",
      "Scolia-visiten mangler event-id-er og kan ikke gjøres idempotent.",
      409,
    );
  }

  const digest = sha256Hex(eventIds.join(",")).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new TypeError("SHA-256 callback must return a 64-character hexadecimal digest.");
  }
  return `scolia-${digest}`;
}

export interface PrepareScoliaVisitInput {
  kiosk_id: DbId;
  match_id: DbId;
  player_id: DbId;
  remaining_before: number;
  darts: readonly NormalizedDart[];
  event_ids: readonly DbId[];
}

/**
 * Pure boundary between an assembled Scolia turn and canonical match scoring.
 * No database work happens here. The resulting command is intentionally the same
 * per-dart payload that PHP ScoliaScoringService sends to CanonicalScoringService.
 */
export function prepareCanonicalScoliaVisit(
  input: PrepareScoliaVisitInput,
  sha256Hex: Sha256Hex,
): PreparedScoliaVisit {
  if (input.darts.length === 0 || input.darts.length > 3) {
    throw new DomainValidationError(
      "scolia_invalid_buffer_size",
      "En Scolia-visit må inneholde mellom én og tre piler.",
      409,
    );
  }
  if (input.event_ids.length !== input.darts.length) {
    throw new DomainValidationError(
      "scolia_buffer_event_mismatch",
      "Scolia-bufferen har ikke én event-id per pil.",
      409,
    );
  }

  const darts = input.darts.map((dart) => ({ ...dart }));
  const requestId = buildScoliaVisitRequestKey(input.event_ids, sha256Hex);
  const evaluation = evaluateVisit(input.remaining_before, {
    input_mode: "per_dart",
    darts,
    darts_used: darts.length,
  });

  return {
    context: {
      kiosk_id: input.kiosk_id,
      match_id: input.match_id,
      player_id: input.player_id,
      remaining_before: input.remaining_before,
    },
    evaluation,
    canonical_command: {
      kiosk_id: input.kiosk_id,
      source: "scolia",
      payload: {
        input_mode: "per_dart",
        darts,
        darts_used: darts.length,
        request_id: requestId,
      },
    },
  };
}
