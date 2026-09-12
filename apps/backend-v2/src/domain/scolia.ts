import type { NormalizedDart } from "../contracts/scoring.js";
import { DomainValidationError } from "./errors.js";

export interface MappedScoliaDart {
  readonly dart: NormalizedDart;
  readonly label: string;
  readonly score: number;
}

export function mapScoliaSector(sectorInput: unknown, bounceoutInput: unknown = false): MappedScoliaDart {
  const sector = typeof sectorInput === "string" ? sectorInput.trim() : "";
  const bounceout = boolValue(bounceoutInput);
  if (bounceout || sector === "" || sector.toLowerCase() === "none") {
    return { dart: { multiplier: "S", value: 0 }, label: "MISS", score: 0 };
  }
  if (sector === "25") {
    return { dart: { multiplier: "S", value: "BULL" }, label: "25", score: 25 };
  }
  if (sector.toLowerCase() === "bull") {
    return { dart: { multiplier: "D", value: "BULL" }, label: "BULL", score: 50 };
  }
  const match = /^([sSdDtT])(\d{1,2})$/.exec(sector);
  if (!match) throw new DomainValidationError("invalid_scolia_sector", `Scolia sendte en ukjent sektor: ${sector}`, 422);
  const number = Number(match[2]);
  if (!Number.isInteger(number) || number < 1 || number > 20) {
    throw new DomainValidationError("invalid_scolia_sector", "Scolia sendte en sektor utenfor 1–20.", 422);
  }
  const multiplier = match[1]!.toUpperCase() as "S" | "D" | "T";
  const score = multiplier === "D" ? number * 2 : multiplier === "T" ? number * 3 : number;
  return {
    dart: { multiplier, value: number },
    label: multiplier === "S" ? String(number) : `${multiplier}${number}`,
    score,
  };
}

export function boolValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}
