import type {
  DartMultiplier,
  EvaluatedVisit,
  NormalizedDart,
  VisitInput,
} from "../contracts/scoring.js";
import { DomainValidationError } from "./errors.js";

const IMPOSSIBLE_CHECKOUTS = new Set([159, 162, 163, 165, 166, 168, 169]);
let possibleVisitScores: Set<number> | undefined;

function phpInt(value: unknown, fallback = 0): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function phpString(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (value === true) return "1";
  if (value === false) return "";
  return String(value);
}

function isPhpNumeric(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string" || value.trim() === "") return false;
  return Number.isFinite(Number(value));
}

export function isCheckoutNumber(remaining: number): boolean {
  if (remaining <= 1 || remaining > 170) {
    return false;
  }
  return !IMPOSSIBLE_CHECKOUTS.has(remaining);
}

export function isPossibleVisitScore(score: number): boolean {
  if (!possibleVisitScores) {
    const values = new Set<number>([0, 25, 50]);
    for (let value = 1; value <= 20; value += 1) {
      values.add(value);
      values.add(value * 2);
      values.add(value * 3);
    }

    possibleVisitScores = new Set<number>();
    for (const first of values) {
      for (const second of values) {
        for (const third of values) {
          possibleVisitScores.add(first + second + third);
        }
      }
    }
  }

  return possibleVisitScores.has(score);
}

export function evaluateVisit(remainingBefore: number, payload: VisitInput): EvaluatedVisit {
  if (remainingBefore < 2 || remainingBefore > 501) {
    throw new DomainValidationError(
      "invalid_remaining_score",
      "Ugyldig gjenstående score før kastet.",
    );
  }

  const rawMode = (payload as Record<string, unknown>).input_mode ?? "sum";
  const inputMode = phpString(rawMode).trim().toLowerCase();
  if (inputMode !== "sum" && inputMode !== "per_dart") {
    throw new DomainValidationError(
      "invalid_input_mode",
      "Scoringmodus må være sum eller per_dart.",
    );
  }

  return inputMode === "per_dart"
    ? evaluatePerDart(remainingBefore, payload)
    : evaluateSum(remainingBefore, payload);
}

function evaluateSum(remainingBefore: number, payload: VisitInput): EvaluatedVisit {
  const record = payload as Record<string, unknown>;
  const score = record.score === undefined ? -1 : phpInt(record.score, -1);
  const dartsUsed = record.darts_used === undefined ? 3 : phpInt(record.darts_used, 3);

  if (score < 0 || score > 180 || !isPossibleVisitScore(score)) {
    throw new DomainValidationError(
      "invalid_visit_score",
      "Denne summen kan ikke oppnås med tre piler.",
    );
  }
  if (dartsUsed < 1 || dartsUsed > 3) {
    throw new DomainValidationError(
      "invalid_darts_used",
      "Antall brukte piler må være mellom 1 og 3.",
    );
  }

  let remainingAfter = remainingBefore - score;
  let isBust = remainingAfter < 0 || remainingAfter === 1;
  let isCheckout = false;

  if (remainingAfter === 0) {
    if (isCheckoutNumber(remainingBefore)) {
      isCheckout = true;
    } else {
      isBust = true;
    }
  }

  if (isBust) {
    remainingAfter = remainingBefore;
  }

  return {
    input_mode: "sum",
    score,
    darts_used: dartsUsed,
    darts: [],
    is_bust: isBust,
    is_checkout: isCheckout,
    remaining_after: remainingAfter,
  };
}

function evaluatePerDart(remainingBefore: number, payload: VisitInput): EvaluatedVisit {
  const record = payload as Record<string, unknown>;
  const rawDarts = Array.isArray(record.darts) ? [...record.darts] : [];
  const dartsUsed = record.darts_used === undefined
    ? rawDarts.length
    : phpInt(record.darts_used, rawDarts.length);

  if (dartsUsed < 1 || dartsUsed > 3 || rawDarts.length !== dartsUsed) {
    throw new DomainValidationError(
      "invalid_darts_used",
      "Per-pil scoring må inneholde nøyaktig de pilene som er brukt.",
    );
  }

  const darts: NormalizedDart[] = [];
  let score = 0;
  let remaining = remainingBefore;
  let isBust = false;
  let isCheckout = false;

  for (let index = 0; index < rawDarts.length; index += 1) {
    const rawDart = rawDarts[index];
    if (rawDart === null || typeof rawDart !== "object" || Array.isArray(rawDart)) {
      throw new DomainValidationError("invalid_dart", "Ugyldig pilformat.");
    }

    const dart = normalizeDart(rawDart as Record<string, unknown>);
    darts.push(dart);
    const dartPoints = dartScore(dart);
    score += dartPoints;
    const next = remaining - dartPoints;

    if (next < 0 || next === 1) {
      isBust = true;
      break;
    }

    if (next === 0) {
      if (!isDouble(dart)) {
        isBust = true;
        break;
      }
      if (index !== rawDarts.length - 1) {
        throw new DomainValidationError(
          "darts_after_checkout",
          "Det kan ikke registreres flere piler etter checkout.",
        );
      }
      isCheckout = true;
      remaining = 0;
      break;
    }

    remaining = next;
  }

  if (score > 180) {
    throw new DomainValidationError(
      "invalid_visit_score",
      "Et kast kan ikke gi mer enn 180 poeng.",
    );
  }

  return {
    input_mode: "per_dart",
    score,
    darts_used: dartsUsed,
    darts,
    is_bust: isBust,
    is_checkout: isCheckout,
    remaining_after: isBust ? remainingBefore : remaining,
  };
}

function normalizeDart(rawDart: Record<string, unknown>): NormalizedDart {
  const rawMultiplier = rawDart.multiplier ?? rawDart.m ?? "S";
  const multiplier = phpString(rawMultiplier).trim().toUpperCase();
  if (multiplier !== "S" && multiplier !== "D" && multiplier !== "T") {
    throw new DomainValidationError(
      "invalid_dart_multiplier",
      "Ugyldig multiplikator på pil.",
    );
  }

  const value = rawDart.value ?? rawDart.v ?? null;
  if (typeof value === "string" && value.trim().toUpperCase() === "BULL") {
    if (multiplier === "T") {
      throw new DomainValidationError(
        "invalid_bull_multiplier",
        "Bull kan bare registreres som 25 eller dobbel bull.",
      );
    }
    return { multiplier, value: "BULL" };
  }

  if (!isPhpNumeric(value)) {
    throw new DomainValidationError("invalid_dart_value", "Ugyldig verdi på pil.");
  }

  const numeric = Math.trunc(Number(value));
  if (numeric === 0) {
    if (multiplier !== "S") {
      throw new DomainValidationError(
        "invalid_miss_multiplier",
        "Bom kan ikke ha dobbel eller trippel multiplikator.",
      );
    }
    return { multiplier: "S", value: 0 };
  }
  if (numeric < 1 || numeric > 20) {
    throw new DomainValidationError(
      "invalid_dart_value",
      "Pilverdien må være 1–20, 25/bull eller bom.",
    );
  }

  return { multiplier: multiplier as DartMultiplier, value: numeric };
}

function dartScore(dart: NormalizedDart): number {
  if (dart.value === "BULL") {
    return dart.multiplier === "D" ? 50 : 25;
  }

  if (dart.multiplier === "D") return dart.value * 2;
  if (dart.multiplier === "T") return dart.value * 3;
  return dart.value;
}

function isDouble(dart: NormalizedDart): boolean {
  return dart.multiplier === "D";
}
