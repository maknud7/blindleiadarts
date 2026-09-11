import { DomainValidationError } from "../domain/errors.js";

export interface PlayoffQualifier {
  player_id: string;
  display_name: string;
  seed_number: number | null;
  source_group_id: string;
  source_group_name: string;
  source_group_position: number;
  points: number;
  leg_diff: number;
  legs_won: number;
  playoff_seed?: number;
}

export class SingleEliminationService {
  static readonly MAX_BRACKET_SIZE = 32;

  bracketSize(qualifierCount: number): number {
    if (!Number.isInteger(qualifierCount) || qualifierCount < 2) {
      throw new DomainValidationError("playoff_players_required", "At least two qualified players are required for a playoff.");
    }
    let size = 2;
    while (size < qualifierCount) size *= 2;
    if (size > SingleEliminationService.MAX_BRACKET_SIZE) {
      throw new DomainValidationError("playoff_too_large", "The playoff supports at most 32 qualified players.");
    }
    return size;
  }

  seedOrder(bracketSize: number): number[] {
    this.assertPowerOfTwo(bracketSize);
    if (bracketSize === 2) return [1, 2];
    const previous = this.seedOrder(bracketSize / 2);
    const order: number[] = [];
    for (const seed of previous) {
      order.push(seed, bracketSize + 1 - seed);
    }
    return order;
  }

  roundCount(bracketSize: number): number {
    this.assertPowerOfTwo(bracketSize);
    return Math.round(Math.log2(bracketSize));
  }

  roundLabel(bracketSize: number, roundNumber: number): string {
    const rounds = this.roundCount(bracketSize);
    if (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > rounds) {
      throw new DomainValidationError("invalid_playoff_round", "Invalid playoff round number.");
    }
    const remaining = bracketSize / (2 ** (roundNumber - 1));
    switch (remaining) {
      case 2: return "Finale";
      case 4: return "Semifinale";
      case 8: return "Kvartfinale";
      case 16: return "Åttedelsfinale";
      case 32: return "Sekstendelsfinale";
      default: return `Sluttspillrunde ${roundNumber}`;
    }
  }

  seedQualifiers(input: readonly PlayoffQualifier[]): PlayoffQualifier[] {
    const qualifiers = input.map((qualifier) => ({ ...qualifier }));
    qualifiers.sort((a, b) => {
      if (a.source_group_position !== b.source_group_position) return a.source_group_position - b.source_group_position;
      for (const field of ["points", "leg_diff", "legs_won"] as const) {
        if (a[field] !== b[field]) return b[field] - a[field];
      }
      if (a.seed_number !== null || b.seed_number !== null) {
        const seedA = a.seed_number ?? Number.MAX_SAFE_INTEGER;
        const seedB = b.seed_number ?? Number.MAX_SAFE_INTEGER;
        if (seedA !== seedB) return seedA - seedB;
      }
      return a.display_name.localeCompare(b.display_name, "nb", { sensitivity: "base" });
    });
    qualifiers.forEach((qualifier, index) => { qualifier.playoff_seed = index + 1; });
    this.reduceSameGroupFirstRoundConflicts(qualifiers);
    qualifiers.sort((a, b) => (a.playoff_seed ?? 0) - (b.playoff_seed ?? 0));
    return qualifiers;
  }

  private reduceSameGroupFirstRoundConflicts(qualifiers: PlayoffQualifier[]): void {
    if (qualifiers.length < 3) return;
    let bestConflicts = this.firstRoundConflictCount(qualifiers);
    for (let iteration = 0; iteration < 20 && bestConflicts > 0; iteration += 1) {
      let bestSwap: [number, number, number] | null = null;
      let bestDistance = Number.MAX_SAFE_INTEGER;
      for (let i = 0; i < qualifiers.length; i += 1) {
        for (let j = i + 1; j < qualifiers.length; j += 1) {
          const left = qualifiers[i]!;
          const right = qualifiers[j]!;
          if (left.source_group_position !== right.source_group_position) continue;
          const candidate = qualifiers.map((qualifier) => ({ ...qualifier }));
          const seedI = candidate[i]!.playoff_seed!;
          const seedJ = candidate[j]!.playoff_seed!;
          candidate[i]!.playoff_seed = seedJ;
          candidate[j]!.playoff_seed = seedI;
          const conflicts = this.firstRoundConflictCount(candidate);
          const distance = Math.abs(seedI - seedJ);
          if (conflicts < bestConflicts || (conflicts === bestConflicts && bestSwap !== null && distance < bestDistance)) {
            bestSwap = [i, j, conflicts];
            bestDistance = distance;
          }
        }
      }
      if (bestSwap === null || bestSwap[2] >= bestConflicts) break;
      const [i, j, conflicts] = bestSwap;
      const seedI = qualifiers[i]!.playoff_seed!;
      qualifiers[i]!.playoff_seed = qualifiers[j]!.playoff_seed!;
      qualifiers[j]!.playoff_seed = seedI;
      bestConflicts = conflicts;
    }
  }

  private firstRoundConflictCount(qualifiers: readonly PlayoffQualifier[]): number {
    const size = this.bracketSize(qualifiers.length);
    const order = this.seedOrder(size);
    const bySeed = new Map<number, PlayoffQualifier>();
    for (const qualifier of qualifiers) bySeed.set(qualifier.playoff_seed!, qualifier);
    let conflicts = 0;
    for (let slot = 0; slot < order.length; slot += 2) {
      const a = bySeed.get(order[slot]!);
      const b = bySeed.get(order[slot + 1]!);
      if (a && b && a.source_group_id === b.source_group_id) conflicts += 1;
    }
    return conflicts;
  }

  private assertPowerOfTwo(value: number): void {
    if (!Number.isInteger(value) || value < 2 || (value & (value - 1)) !== 0) {
      throw new DomainValidationError("invalid_bracket_size", "Bracket size must be a power of two.");
    }
  }
}
