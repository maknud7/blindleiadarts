export interface EloBaselineEntry {
  rating: number;
  played: number;
}

// Mirrors apps/api/data/mandagsserien-elo-2026-08-24.php during the
// transition. Remove this duplicate once the PHP runtime is deleted and the
// historical baseline has one canonical non-PHP representation.
export const MANDAGSSERIEN_ELO_2026_08_24 = new Map<string, EloBaselineEntry>([
  ["andre kendrick", { rating: 1077.3, played: 18 }],
  ["jon-henning næss", { rating: 1067.3, played: 17 }],
  ["vetle ribe davidsen", { rating: 1035.2, played: 17 }],
  ["thomas kildal", { rating: 1031.5, played: 16 }],
  ["arild eidesund", { rating: 1024.9, played: 17 }],
  ["hans øyvind reiersen", { rating: 1019.3, played: 8 }],
  ["magnus knudsen", { rating: 1018.3, played: 15 }],
  ["steffen madsen", { rating: 1001.7, played: 14 }],
  ["kjell moyle", { rating: 1001.4, played: 8 }],
  ["tormod haga", { rating: 992.3, played: 13 }],
  ["andreas hasselgård", { rating: 986.3, played: 14 }],
  ["tor egil olsen", { rating: 983.0, played: 13 }],
  ["andreas tingstveit hansen", { rating: 974.3, played: 14 }],
  ["leif atle franksson", { rating: 966.7, played: 14 }],
  ["sven einar davidsen", { rating: 953.7, played: 6 }],
  ["dan christian birkeland", { rating: 939.5, played: 13 }],
  ["boye buckingham", { rating: 921.0, played: 7 }],
]);

export function eloBaselineFor(displayName: unknown): EloBaselineEntry | null {
  const key = String(displayName ?? "").trim().toLocaleLowerCase("nb-NO");
  return MANDAGSSERIEN_ELO_2026_08_24.get(key) ?? null;
}
