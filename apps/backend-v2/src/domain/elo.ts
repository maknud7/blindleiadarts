export interface EloCalculation {
  readonly rating_a_before: number;
  readonly rating_b_before: number;
  readonly rating_a_after: number;
  readonly rating_b_after: number;
  readonly delta_a: number;
  readonly delta_b: number;
  readonly expected_a: number;
  readonly expected_b: number;
  readonly k_a: number;
  readonly k_b: number;
  readonly matches_before_a: number;
  readonly matches_before_b: number;
  readonly matches_after_a: number;
  readonly matches_after_b: number;
}

export interface EloCalculatorOptions {
  readonly divisor?: number;
  readonly provisionalK?: number;
  readonly establishedK?: number;
  readonly provisionalMatchLimit?: number;
}

/** Behavioral port of PHP EloCalculator. Keep floating-point values unrounded. */
export class EloCalculator {
  private readonly divisor: number;
  private readonly provisionalK: number;
  private readonly establishedK: number;
  private readonly provisionalMatchLimit: number;

  constructor(options: EloCalculatorOptions = {}) {
    this.divisor = options.divisor ?? 400;
    this.provisionalK = options.provisionalK ?? 25;
    this.establishedK = options.establishedK ?? 15;
    this.provisionalMatchLimit = options.provisionalMatchLimit ?? 10;
  }

  calculate(
    ratingA: number,
    ratingB: number,
    matchesBeforeA: number,
    matchesBeforeB: number,
    scoreA: number,
  ): EloCalculation {
    const boundedScoreA = Math.max(0, Math.min(1, scoreA));
    const scoreB = 1 - boundedScoreA;
    const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / this.divisor));
    const expectedB = 1 - expectedA;
    const kA = matchesBeforeA <= this.provisionalMatchLimit ? this.provisionalK : this.establishedK;
    const kB = matchesBeforeB <= this.provisionalMatchLimit ? this.provisionalK : this.establishedK;
    const deltaA = kA * (boundedScoreA - expectedA);
    const deltaB = kB * (scoreB - expectedB);

    return {
      rating_a_before: ratingA,
      rating_b_before: ratingB,
      rating_a_after: ratingA + deltaA,
      rating_b_after: ratingB + deltaB,
      delta_a: deltaA,
      delta_b: deltaB,
      expected_a: expectedA,
      expected_b: expectedB,
      k_a: kA,
      k_b: kB,
      matches_before_a: matchesBeforeA,
      matches_before_b: matchesBeforeB,
      matches_after_a: matchesBeforeA + 1,
      matches_after_b: matchesBeforeB + 1,
    };
  }
}
