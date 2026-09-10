export type InputMode = "sum" | "per_dart";
export type DartMultiplier = "S" | "D" | "T";
export type DartValue = number | "BULL";

export interface NormalizedDart {
  multiplier: DartMultiplier;
  value: DartValue;
}

export interface SumVisitInput {
  input_mode?: "sum";
  score?: unknown;
  darts_used?: unknown;
  request_id?: unknown;
}

export interface PerDartVisitInput {
  input_mode: "per_dart";
  darts?: unknown;
  darts_used?: unknown;
  request_id?: unknown;
}

export type VisitInput = SumVisitInput | PerDartVisitInput | Record<string, unknown>;

export interface EvaluatedVisit {
  input_mode: InputMode;
  score: number;
  darts_used: number;
  darts: NormalizedDart[];
  is_bust: boolean;
  is_checkout: boolean;
  remaining_after: number;
}

/**
 * MySQL uses BIGINT UNSIGNED for canonical ids. Keep them as decimal strings at
 * the TypeScript boundary so the domain never depends on JS Number precision.
 */
export type DbId = string & { readonly __brand: "DbId" };

export function asDbId(value: string): DbId {
  const normalized = value.trim();
  if (!/^[0-9]+$/.test(normalized) || BigInt(normalized) <= 0n) {
    throw new TypeError("Database id must be a positive decimal string.");
  }
  return normalized as DbId;
}
