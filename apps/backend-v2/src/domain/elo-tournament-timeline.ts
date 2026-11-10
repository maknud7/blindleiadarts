/**
 * Build an ELO time series on the tournament calendar, not on the player's
 * attendance calendar. Every finished, ELO-enabled club tournament gets one
 * point, even when this player was absent.
 *
 * Missing snapshots never imply an ELO win/loss: carry forward the previous
 * confirmed rating. Season resets are kept separate. Never backfill later
 * ratings into earlier tournaments.
 */
export function composePlayerEloTournamentTimeline(
  tournaments: ReadonlyArray<Record<string, unknown>>,
  snapshots: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown>[] {
  const byTournament = new Map(snapshots.map((row) => [String(row.tournament_id), row]));
  const lastBySeason = new Map<string, number>();
  return tournaments.map((tournament) => {
    const tournamentId = String(tournament.id);
    const season = String(tournament.season_id ?? "none");
    const snapshot = byTournament.get(tournamentId);
    const current = lastBySeason.get(season) ?? 1000;
    const before = snapshot && Number.isFinite(Number(snapshot.rating_before))
      ? Number(snapshot.rating_before) : current;
    const knownAfter = snapshot?.rating_after !== null && snapshot?.rating_after !== undefined
      ? Number(snapshot.rating_after) : null;
    const after = knownAfter !== null && Number.isFinite(knownAfter) ? knownAfter : current;
    const matches = Math.max(0, Number(snapshot?.tournament_matches ?? 0) || 0);
    lastBySeason.set(season, after);
    return {
      tournament_id: tournament.id,
      season_id: tournament.season_id,
      tournament_name: String(tournament.name ?? ""),
      tournament_status: String(tournament.status ?? ""),
      start_at: tournament.start_at ?? null,
      end_at: tournament.end_at ?? null,
      rating_before: before,
      rating_after: after,
      matches_before: snapshot?.matches_before ?? null,
      matches_after: snapshot?.matches_after ?? null,
      tournament_matches: matches,
      delta: after - before,
      completed: true,
      played_elo: matches > 0,
      has_snapshot: Boolean(snapshot),
    };
  });
}
