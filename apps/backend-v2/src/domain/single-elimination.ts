import type { DbId } from "../contracts/scoring.js";

export const MAX_BRACKET_SIZE = 32;

export interface PlayoffQualifier {
  readonly player_id: DbId;
  readonly display_name: string;
  readonly seed_number: number | null;
  readonly source_group_id: DbId;
  readonly source_group_name: string;
  readonly source_group_position: number;
  readonly points: number;
  readonly leg_diff: number;
  readonly legs_won: number;
  playoff_seed?: number;
}

export function bracketSize(qualifierCount: number): number {
  if (!Number.isInteger(qualifierCount) || qualifierCount < 2) {
    throw new RangeError("At least two qualified players are required for a playoff.");
  }
  let size = 2;
  while (size < qualifierCount) size *= 2;
  if (size > MAX_BRACKET_SIZE) {
    throw new RangeError("The first playoff version supports at most 32 qualified players.");
  }
  return size;
}

export function seedOrder(size: number): number[] {
  assertPowerOfTwo(size);
  if (size === 2) return [1, 2];
  const previous = seedOrder(size / 2);
  const result: number[] = [];
  for (const seed of previous) {
    result.push(seed, size + 1 - seed);
  }
  return result;
}

export function roundCount(size: number): number {
  assertPowerOfTwo(size);
  return Math.round(Math.log2(size));
}

export function roundLabel(size: number, roundNumber: number): string {
  const rounds = roundCount(size);
  if (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > rounds) {
    throw new RangeError("Invalid playoff round number.");
  }
  const remaining = Math.trunc(size / (2 ** (roundNumber - 1)));
  if (remaining === 2) return "Finale";
  if (remaining === 4) return "Semifinale";
  if (remaining === 8) return "Kvartfinale";
  if (remaining === 16) return "Åttedelsfinale";
  if (remaining === 32) return "Sekstendelsfinale";
  return `Sluttspillrunde ${roundNumber}`;
}

export function seedQualifiers(input: readonly PlayoffQualifier[]): PlayoffQualifier[] {
  const qualifiers = input.map((row) => ({ ...row }));
  qualifiers.sort(compareQualifierTier);
  qualifiers.forEach((qualifier, index) => {
    qualifier.playoff_seed = index + 1;
  });

  reduceSameGroupFirstRoundConflicts(qualifiers);
  qualifiers.sort((a, b) => requiredSeed(a) - requiredSeed(b));
  return qualifiers;
}

function compareQualifierTier(a: PlayoffQualifier, b: PlayoffQualifier): number {
  let result = a.source_group_position - b.source_group_position;
  if (result !== 0) return result;
  for (const field of ["points", "leg_diff", "legs_won"] as const) {
    result = b[field] - a[field];
    if (result !== 0) return result;
  }
  if (a.seed_number !== null || b.seed_number !== null) {
    result = (a.seed_number ?? Number.MAX_SAFE_INTEGER) - (b.seed_number ?? Number.MAX_SAFE_INTEGER);
    if (result !== 0) return result;
  }
  return compareNames(a.display_name, b.display_name);
}

function reduceSameGroupFirstRoundConflicts(qualifiers: PlayoffQualifier[]): void {
  if (qualifiers.length < 3) return;
  let bestConflicts = firstRoundConflictCount(qualifiers);
  if (bestConflicts === 0) return;

  for (let iteration = 0; iteration < 20 && bestConflicts > 0; iteration += 1) {
    let bestSwap: { i: number; j: number; conflicts: number } | null = null;
    let bestDistance = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < qualifiers.length; i += 1) {
      for (let j = i + 1; j < qualifiers.length; j += 1) {
        const left = qualifiers[i];
        const right = qualifiers[j];
        if (!left || !right || left.source_group_position !== right.source_group_position) continue;
        const candidate = qualifiers.map((row) => ({ ...row }));
        const seedI = requiredSeed(candidate[i]!);
        const seedJ = requiredSeed(candidate[j]!);
        candidate[i]!.playoff_seed = seedJ;
        candidate[j]!.playoff_seed = seedI;
        const conflicts = firstRoundConflictCount(candidate);
        const distance = Math.abs(seedI - seedJ);
        if (conflicts < bestConflicts || (conflicts === bestConflicts && bestSwap !== null && distance < bestDistance)) {
          bestSwap = { i, j, conflicts };
          bestDistance = distance;
        }
      }
    }
    if (bestSwap === null || bestSwap.conflicts >= bestConflicts) break;
    const seedI = requiredSeed(qualifiers[bestSwap.i]!);
    qualifiers[bestSwap.i]!.playoff_seed = requiredSeed(qualifiers[bestSwap.j]!);
    qualifiers[bestSwap.j]!.playoff_seed = seedI;
    bestConflicts = bestSwap.conflicts;
  }
}

function firstRoundConflictCount(qualifiers: readonly PlayoffQualifier[]): number {
  const size = bracketSize(qualifiers.length);
  const order = seedOrder(size);
  const bySeed = new Map<number, PlayoffQualifier>();
  for (const qualifier of qualifiers) bySeed.set(requiredSeed(qualifier), qualifier);
  let conflicts = 0;
  for (let slot = 0; slot < order.length; slot += 2) {
    const a = bySeed.get(order[slot]!);
    const b = bySeed.get(order[slot + 1]!);
    if (!a || !b) continue;
    if (a.source_group_id === b.source_group_id) conflicts += 1;
  }
  return conflicts;
}

function requiredSeed(qualifier: PlayoffQualifier): number {
  if (!Number.isInteger(qualifier.playoff_seed) || (qualifier.playoff_seed ?? 0) < 1) {
    throw new TypeError("playoff_seed must be assigned before bracket materialization");
  }
  return qualifier.playoff_seed!;
}

function compareNames(a: string, b: string): number {
  const left = a.toLocaleLowerCase("nb-NO");
  const right = b.toLocaleLowerCase("nb-NO");
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertPowerOfTwo(size: number): void {
  if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
    throw new RangeError("Bracket size must be a power of two.");
  }
}
