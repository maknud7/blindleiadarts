import type { DbId } from "../contracts/scoring.js";
import { asDbId } from "../contracts/scoring.js";
import type { CanonicalTournamentEloPort } from "../service/canonical-scoring-service.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

interface TournamentRow extends QueryResultRow {
  readonly id?: unknown;
  readonly club_id?: unknown;
  readonly season_id?: unknown;
  readonly status?: unknown;
  readonly start_at?: unknown;
  readonly end_at?: unknown;
  readonly elo_enabled?: unknown;
}

interface SnapshotRow extends QueryResultRow {
  readonly player_id?: unknown;
  readonly display_name?: unknown;
  readonly elo_before?: unknown;
  readonly elo_after?: unknown;
  readonly rank_before?: unknown;
  readonly rank_after?: unknown;
  readonly rank_baseline_kind?: unknown;
  readonly matches_before?: unknown;
  readonly matches_after?: unknown;
}

interface ClubEloRow extends QueryResultRow {
  readonly id?: unknown;
  readonly display_name?: unknown;
  readonly elo_rating?: unknown;
  readonly elo_matches_played?: unknown;
  readonly local_matches_played?: unknown;
}

interface EloEventStateRow extends QueryResultRow {
  readonly player_a_id?: unknown;
  readonly rating_a_before?: unknown;
  readonly rating_a_after?: unknown;
  readonly matches_before_a?: unknown;
  readonly player_b_id?: unknown;
  readonly rating_b_before?: unknown;
  readonly rating_b_after?: unknown;
  readonly matches_before_b?: unknown;
}

interface PlayerState {
  readonly rating: number;
  readonly matches: number;
}

interface RankedPlayer extends PlayerState {
  readonly playerId: DbId;
  readonly displayName: string;
  position: number;
}

/**
 * Canonical tournament-level ELO snapshots used for before/after and rank-delta
 * display. This ports the scoring-side `syncByMatchId` behavior from PHP; the
 * PHP read/decorate method remains available during coexistence.
 */
export class MySqlTournamentEloProjection implements CanonicalTournamentEloPort {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
  ) {}

  async syncTournamentElo(matchId: DbId | null): Promise<void> {
    if (matchId === null) return;

    await this.sessions.withTransaction(async (sql) => {
      const matchRows = await sql.query<QueryResultRow>(
        `SELECT tournament_id FROM ${this.table("matches")} WHERE id=? LIMIT 1`,
        [matchId],
      );
      const rawTournamentId = matchRows[0]?.tournament_id;
      if (rawTournamentId === undefined || rawTournamentId === null) return;
      const tournamentId = dbId(rawTournamentId, "matches.tournament_id");

      const tournament = await this.tournament(sql, tournamentId);
      if (
        tournament === null
        || dbInt(tournament.elo_enabled, "tournaments.elo_enabled") !== 1
        || tournament.season_id === null
        || tournament.season_id === undefined
      ) {
        return;
      }

      await this.captureStart(sql, tournamentId, tournament);

      if (dbString(tournament.status) !== "completed") {
        await sql.execute(
          `UPDATE ${this.table("tournament_elo_snapshots")}
           SET elo_after=NULL, rank_after=NULL, matches_after=NULL, captured_end_at=NULL
           WHERE tournament_id=?`,
          [tournamentId],
        );
        return;
      }

      await this.captureEnd(sql, tournamentId, tournament);
    });
  }

  private async tournament(sql: SqlExecutor, tournamentId: DbId): Promise<TournamentRow | null> {
    const rows = await sql.query<TournamentRow>(
      `SELECT id,club_id,season_id,status,start_at,end_at,elo_enabled
       FROM ${this.table("tournaments")} WHERE id=? LIMIT 1 FOR UPDATE`,
      [tournamentId],
    );
    return rows[0] ?? null;
  }

  private async captureStart(sql: SqlExecutor, tournamentId: DbId, tournament: TournamentRow): Promise<void> {
    const seasonId = dbId(tournament.season_id, "tournaments.season_id");
    const clubId = dbId(tournament.club_id, "tournaments.club_id");
    let snapshots = await this.listSnapshots(sql, tournamentId);
    const initialBatch = snapshots.length === 0;
    const existing = new Set(snapshots.map((row) => dbId(row.player_id, "tournament_elo_snapshots.player_id")));
    const ranking = await this.listClubElo(sql, clubId, seasonId);
    const rankingByPlayer = new Map(ranking.map((row) => [row.playerId, row] as const));
    const eventStarts = await this.eventState(sql, tournamentId, "start");
    const participantIds = await this.participantIds(sql, tournamentId);
    const tournamentStartAt = dateTime(tournament.start_at) ?? nowSqlDateTime();

    if (initialBatch) {
      // Reconstruct the full club order at tournament start. For players who
      // already completed a match before the first sync, use their earliest
      // event-before state rather than their now-updated current rating.
      const baseline = ranking.map((row) => {
        const event = eventStarts.get(row.playerId);
        return {
          ...row,
          rating: event?.rating ?? row.rating,
          matches: event?.matches ?? row.matches,
        };
      });
      rankRows(baseline);
      for (const row of baseline) {
        await this.insertSnapshot(sql, {
          tournamentId,
          seasonId,
          clubId,
          playerId: row.playerId,
          eloBefore: row.rating,
          matchesBefore: row.matches,
          rankBefore: row.position,
          baselineKind: "start",
          capturedStartAt: tournamentStartAt,
        });
        existing.add(row.playerId);
      }
    }

    for (const playerId of participantIds) {
      if (existing.has(playerId)) continue;
      const event = eventStarts.get(playerId);
      const ranked = rankingByPlayer.get(playerId);
      const current = event ?? ranked ?? await this.currentPlayerState(sql, seasonId, playerId) ?? { rating: 1000, matches: 0 };
      await this.insertSnapshot(sql, {
        tournamentId,
        seasonId,
        clubId,
        playerId,
        eloBefore: current.rating,
        matchesBefore: current.matches,
        rankBefore: event ? null : ranked?.position ?? null,
        baselineKind: initialBatch ? "start" : "entry",
        capturedStartAt: initialBatch ? tournamentStartAt : nowSqlDateTime(),
      });
      existing.add(playerId);
    }

    // Repair participant-only historical snapshots from the first implementation
    // and ensure rank_before represents the whole club at tournament start.
    snapshots = await this.listSnapshots(sql, tournamentId);
    await this.ensureClubStartBaselines(sql, tournamentId, tournament, ranking, snapshots, eventStarts);
  }

  private async ensureClubStartBaselines(
    sql: SqlExecutor,
    tournamentId: DbId,
    tournament: TournamentRow,
    ranking: readonly RankedPlayer[],
    snapshots: readonly SnapshotRow[],
    eventStarts: ReadonlyMap<DbId, PlayerState>,
  ): Promise<void> {
    if (ranking.length === 0) return;
    const seasonId = dbId(tournament.season_id, "tournaments.season_id");
    const clubId = dbId(tournament.club_id, "tournaments.club_id");
    const tournamentStartAt = dateTime(tournament.start_at) ?? nowSqlDateTime();
    const byPlayer = new Map<DbId, SnapshotRow>();
    for (const snapshot of snapshots) {
      byPlayer.set(dbId(snapshot.player_id, "tournament_elo_snapshots.player_id"), snapshot);
    }

    for (const ranked of ranking) {
      if (byPlayer.has(ranked.playerId)) continue;
      const event = eventStarts.get(ranked.playerId);
      await this.insertSnapshot(sql, {
        tournamentId,
        seasonId,
        clubId,
        playerId: ranked.playerId,
        eloBefore: event?.rating ?? ranked.rating,
        matchesBefore: event?.matches ?? ranked.matches,
        rankBefore: null,
        baselineKind: "start",
        capturedStartAt: tournamentStartAt,
      });
      byPlayer.set(ranked.playerId, {
        player_id: ranked.playerId,
        display_name: ranked.displayName,
        elo_before: event?.rating ?? ranked.rating,
        matches_before: event?.matches ?? ranked.matches,
        rank_baseline_kind: "start",
      });
    }

    const startRows: RankedPlayer[] = [];
    const displayNameByPlayer = new Map(ranking.map((row) => [row.playerId, row.displayName] as const));
    for (const [playerId, snapshot] of byPlayer) {
      if (dbString(snapshot.rank_baseline_kind || "start") !== "start") continue;
      startRows.push({
        playerId,
        displayName: dbString(snapshot.display_name) || displayNameByPlayer.get(playerId) || "",
        rating: dbFloat(snapshot.elo_before, "tournament_elo_snapshots.elo_before"),
        matches: dbInt(snapshot.matches_before, "tournament_elo_snapshots.matches_before"),
        position: 0,
      });
    }
    rankRows(startRows);
    for (const row of startRows) {
      await sql.execute(
        `UPDATE ${this.table("tournament_elo_snapshots")} SET rank_before=?
         WHERE tournament_id=? AND player_id=?`,
        [row.position, tournamentId, row.playerId],
      );
    }
  }

  private async captureEnd(sql: SqlExecutor, tournamentId: DbId, tournament: TournamentRow): Promise<void> {
    const seasonId = dbId(tournament.season_id, "tournaments.season_id");
    const clubId = dbId(tournament.club_id, "tournaments.club_id");
    const events = await this.eventState(sql, tournamentId, "end");
    const snapshots = await this.listSnapshots(sql, tournamentId);
    if (snapshots.length === 0) return;
    const ranking = await this.listClubElo(sql, clubId, seasonId);
    const byPlayer = new Map(ranking.map((row) => [row.playerId, row] as const));
    const byName = uniqueByName(ranking);
    const capturedEndAt = dateTime(tournament.end_at) ?? nowSqlDateTime();

    for (const snapshot of snapshots) {
      const playerId = dbId(snapshot.player_id, "tournament_elo_snapshots.player_id");
      const event = events.get(playerId);
      let current = byPlayer.get(playerId) ?? null;
      if (current === null) {
        const key = normalizedName(dbString(snapshot.display_name));
        current = key === "" ? null : byName.get(key) ?? null;
      }
      const eloAfter = event?.rating ?? current?.rating ?? dbFloat(snapshot.elo_before, "tournament_elo_snapshots.elo_before");
      const matchesAfter = event?.matches ?? current?.matches ?? dbInt(snapshot.matches_before, "tournament_elo_snapshots.matches_before");
      const rankAfter = current?.position ?? null;
      await sql.execute(
        `UPDATE ${this.table("tournament_elo_snapshots")}
         SET elo_after=?, rank_after=?, matches_after=?, captured_end_at=?
         WHERE tournament_id=? AND player_id=?`,
        [eloAfter, rankAfter, matchesAfter, capturedEndAt, tournamentId, playerId],
      );
    }
  }

  private async listSnapshots(sql: SqlExecutor, tournamentId: DbId): Promise<readonly SnapshotRow[]> {
    return sql.query<SnapshotRow>(
      `SELECT s.*, p.display_name
       FROM ${this.table("tournament_elo_snapshots")} s
       INNER JOIN ${this.table("players")} p ON p.id=s.player_id
       WHERE s.tournament_id=? ORDER BY s.player_id ASC`,
      [tournamentId],
    );
  }

  private async participantIds(sql: SqlExecutor, tournamentId: DbId): Promise<readonly DbId[]> {
    const rows = await sql.query<QueryResultRow>(
      `SELECT player_id FROM ${this.table("tournament_players")}
       WHERE tournament_id=? AND status NOT IN ("withdrawn","no_show")`,
      [tournamentId],
    );
    return rows.map((row) => dbId(row.player_id, "tournament_players.player_id"));
  }

  private async currentPlayerState(sql: SqlExecutor, seasonId: DbId, playerId: DbId): Promise<PlayerState | null> {
    const rows = await sql.query<QueryResultRow>(
      `SELECT rating,matches_played FROM ${this.table("elo_current_ratings")}
       WHERE season_id=? AND player_id=? LIMIT 1`,
      [seasonId, playerId],
    );
    const row = rows[0];
    return row ? {
      rating: dbFloat(row.rating, "elo_current_ratings.rating"),
      matches: dbInt(row.matches_played, "elo_current_ratings.matches_played"),
    } : null;
  }

  private async eventState(
    sql: SqlExecutor,
    tournamentId: DbId,
    edge: "start" | "end",
  ): Promise<ReadonlyMap<DbId, PlayerState>> {
    const rows = await sql.query<EloEventStateRow>(
      `SELECT player_a_id,rating_a_before,rating_a_after,matches_before_a,
              player_b_id,rating_b_before,rating_b_after,matches_before_b
       FROM ${this.table("elo_match_events")}
       WHERE tournament_id=? AND status="applied"
         AND rating_a_before IS NOT NULL AND rating_a_after IS NOT NULL
         AND rating_b_before IS NOT NULL AND rating_b_after IS NOT NULL
       ORDER BY id ASC`,
      [tournamentId],
    );
    const state = new Map<DbId, PlayerState & { order: number }>();
    for (const row of rows) {
      for (const side of ["a", "b"] as const) {
        const playerId = dbId(row[`player_${side}_id`], `elo_match_events.player_${side}_id`);
        const matchesBefore = dbInt(row[`matches_before_${side}`], `elo_match_events.matches_before_${side}`);
        const candidate: PlayerState & { order: number } = {
          rating: dbFloat(
            edge === "start" ? row[`rating_${side}_before`] : row[`rating_${side}_after`],
            `elo_match_events.rating_${side}_${edge === "start" ? "before" : "after"}`,
          ),
          matches: edge === "start" ? matchesBefore : matchesBefore + 1,
          order: matchesBefore,
        };
        const previous = state.get(playerId);
        if (
          previous === undefined
          || (edge === "start" ? candidate.order < previous.order : candidate.order >= previous.order)
        ) {
          state.set(playerId, candidate);
        }
      }
    }
    return new Map([...state].map(([playerId, value]) => [playerId, { rating: value.rating, matches: value.matches }]));
  }

  private async listClubElo(sql: SqlExecutor, clubId: DbId, seasonId: DbId): Promise<RankedPlayer[]> {
    const rows = await sql.query<ClubEloRow>(
      `SELECT p.id,p.display_name,ecr.rating AS elo_rating,ecr.matches_played AS elo_matches_played,
              COUNT(DISTINCT CASE WHEN m.status="completed" THEN m.id END) AS local_matches_played
       FROM ${this.table("players")} p
       LEFT JOIN ${this.table("elo_current_ratings")} ecr ON ecr.player_id=p.id AND ecr.season_id=?
       LEFT JOIN ${this.table("matches")} m ON (m.player_a_id=p.id OR m.player_b_id=p.id)
       WHERE p.club_id=? AND p.is_active=1
       GROUP BY p.id,p.display_name,ecr.rating,ecr.matches_played
       ORDER BY p.display_name ASC`,
      [seasonId, clubId],
    );

    // `elo_current_ratings` is canonical after season replay. Historical baseline
    // data was migrated into the ledger/current state before backend-v2 cutover;
    // unplayed/default rows therefore do not belong in the ranked club baseline.
    const byName = new Map<string, RankedPlayer & { localMatches: number }>();
    for (const row of rows) {
      if (row.elo_rating === null || row.elo_rating === undefined) continue;
      const matches = dbInt(row.elo_matches_played ?? 0, "elo_current_ratings.matches_played");
      if (matches <= 0) continue;
      const playerId = dbId(row.id, "players.id");
      const displayName = dbString(row.display_name);
      const key = normalizedName(displayName);
      const candidate = {
        playerId,
        displayName,
        rating: dbFloat(row.elo_rating, "elo_current_ratings.rating"),
        matches,
        position: 0,
        localMatches: dbInt(row.local_matches_played ?? 0, "local_matches_played"),
      };
      const current = byName.get(key);
      if (
        current === undefined
        || candidate.localMatches > current.localMatches
        || (candidate.localMatches === current.localMatches && BigInt(candidate.playerId) < BigInt(current.playerId))
      ) {
        byName.set(key, candidate);
      }
    }
    const ranked = [...byName.values()].map(({ localMatches: _localMatches, ...row }) => row);
    rankRows(ranked);
    return ranked;
  }

  private async insertSnapshot(sql: SqlExecutor, input: {
    tournamentId: DbId;
    seasonId: DbId;
    clubId: DbId;
    playerId: DbId;
    eloBefore: number;
    matchesBefore: number;
    rankBefore: number | null;
    baselineKind: "start" | "entry";
    capturedStartAt: string;
  }): Promise<void> {
    await sql.execute(
      `INSERT IGNORE INTO ${this.table("tournament_elo_snapshots")}
       (tournament_id,season_id,club_id,player_id,elo_before,matches_before,rank_before,rank_baseline_kind,captured_start_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        input.tournamentId,
        input.seasonId,
        input.clubId,
        input.playerId,
        input.eloBefore,
        input.matchesBefore,
        input.rankBefore,
        input.baselineKind,
        input.capturedStartAt,
      ],
    );
  }

  private table(name: TournamentEloTable): string {
    return `\`${this.runtimePrefix}${name}\``;
  }
}

type TournamentEloTable =
  | "matches"
  | "tournaments"
  | "players"
  | "tournament_players"
  | "elo_match_events"
  | "elo_current_ratings"
  | "tournament_elo_snapshots";

function rankRows(rows: RankedPlayer[]): void {
  rows.sort((left, right) => {
    const rating = right.rating - left.rating;
    return rating !== 0 ? rating : left.displayName.localeCompare(right.displayName, "nb", { sensitivity: "base" });
  });
  rows.forEach((row, index) => { row.position = index + 1; });
}

function uniqueByName(rows: readonly RankedPlayer[]): ReadonlyMap<string, RankedPlayer | null> {
  const result = new Map<string, RankedPlayer | null>();
  for (const row of rows) {
    const key = normalizedName(row.displayName);
    if (!result.has(key)) result.set(key, row);
    else result.set(key, null);
  }
  return result;
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase("nb-NO");
}

function dbId(value: unknown, field: string): DbId {
  if (typeof value !== "string") throw new TypeError(`${field} must be returned from MySQL as a decimal string.`);
  return asDbId(value);
}

function dbString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function dbInt(value: unknown, field: string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numeric)) throw new TypeError(`${field} must be an integer-compatible MySQL value.`);
  return numeric;
}

function dbFloat(value: unknown, field: string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) throw new TypeError(`${field} must be a finite MySQL numeric value.`);
  return numeric;
}

function dateTime(value: unknown): string | null {
  const text = dbString(value).trim();
  return text === "" ? null : text.slice(0, 19);
}

function nowSqlDateTime(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}
