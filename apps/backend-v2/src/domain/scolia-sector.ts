import type { DartMultiplier, DartValue } from "../contracts/scoring.js";
import { DomainValidationError } from "./errors.js";

export interface CanonicalScoliaSector {
  multiplier: DartMultiplier;
  value: DartValue;
  label: string;
  score: number;
}

/** Exact TypeScript port of PHP ScoliaSectorMapper::toCanonical(). */
export function mapScoliaSector(sectorInput: string, bounceout = false): CanonicalScoliaSector {
  const sector = sectorInput.trim();
  if (bounceout || sector === "" || sector.toLowerCase() === "none") {
    return { multiplier: "S", value: 0, label: "MISS", score: 0 };
  }

  if (sector === "25") {
    return { multiplier: "S", value: "BULL", label: "25", score: 25 };
  }

  if (sector.toLowerCase() === "bull") {
    return { multiplier: "D", value: "BULL", label: "BULL", score: 50 };
  }

  const match = /^([sSdDtT])(\d{1,2})$/.exec(sector);
  if (match === null) {
    throw new DomainValidationError(
      "invalid_scolia_sector",
      `Scolia sendte en ukjent sektor: ${sector}`,
      422,
    );
  }

  const rawNumber = match[2];
  if (rawNumber === undefined) {
    throw new DomainValidationError("invalid_scolia_sector", "Scolia sendte en sektor utenfor 1–20.", 422);
  }
  const number = Number.parseInt(rawNumber, 10);
  if (number < 1 || number > 20) {
    throw new DomainValidationError("invalid_scolia_sector", "Scolia sendte en sektor utenfor 1–20.", 422);
  }

  const rawMultiplier = match[1]?.toUpperCase();
  if (rawMultiplier === "S") {
    return { multiplier: "S", value: number, label: String(number), score: number };
  }
  if (rawMultiplier === "D") {
    return { multiplier: "D", value: number, label: `D${number}`, score: number * 2 };
  }
  return { multiplier: "T", value: number, label: `T${number}`, score: number * 3 };
}
