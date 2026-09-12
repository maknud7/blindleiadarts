import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

interface TournamentRow extends QueryResultRow {
  id: unknown;
  club_id: unknown;
  name: unknown;
  status: unknown;
  start_at: unknown;
  registration_opens_at: unknown;
  registration_closes_at: unknown;
}

interface StartEloRow extends QueryResultRow {
  id: unknown;
  display_name: unknown;
  rating: unknown;
  matches_played: unknown;
  local_matches_played: unknown;
}

export interface TournamentStartResult {
  tournament_id: string;
  status: "in_progress";
  checked_in_count: number;
  no_show_count: number;
  withdrawn_waitlist_count: number;
  already_started: boolean;
}

export class MySqlTournamentFlowRepository {
  private static readonly MIN_PLAYERS = 2;

  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly prefix: TablePrefix,
  ) {}

  async findTournament(tournamentIdInput: unknown): Promise<TournamentRow | null> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<TournamentRow>(
        `SELECT id, club_id, name, status, start_at, registration_opens_at, registration_closes_at
           FROM \`${this.prefix}tournaments\` WHERE id=? LIMIT 1`,
        [tournamentId],
      );
      return rows[0] ?? null;
    });
  }

  async startTournament(tournamentIdInput: unknown): Promise<TournamentStartResult> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    const tournament = await this.findTournament(tournamentId);
    if (tournament === null) {
      throw new DomainValidationError("tournament_not_found", "Turneringen ble ikke funnet.", 404);
    }

    const status = String(tournament.status ?? "");
    if (status === "completed" || status === "archived") {
      throw new DomainValidationError("tournament_already_closed", "Turneringen er allerede avsluttet.");
    }

    const matchCount = await this.countMatches(tournamentId);
    if (matchCount > 0 && status !== "in_progress") {
      throw new DomainValidationError("tournament_has_matches", "Turneringen har allerede kamper og kan ikke startes på nytt.");
    }

    const checkedIn = await this.countRegistrations(tournamentId, ["checked_in"]);
    if (checkedIn < MySqlTournamentFlowRepository.MIN_PLAYERS) {
      throw new DomainValidationError(
        "not_enough_checked_in_players",
        "Minst to spillere må delta før turneringen kan startes.",
      );
    }

    if (status === "in_progress") {
      await this.sessions.withConnection((db) => this.captureEloStartSnapshotWith(db, tournamentId));
      return {
        tournament_id: tournamentId,
        status: "in_progress",
        checked_in_count: checkedIn,
        no_show_count: await this.countRegistrations(tournamentId, ["no_show"]),
        withdrawn_waitlist_count: 0,
        already_started: true,
      };
    }

    const registered = await this.countRegistrations(tournamentId, ["registered", "paused"]);
    const waitlisted = await this.countRegistrations(tournamentId, ["waitlisted"]);

    await this.sessions.withTransaction(async (db) => {
      await db.execute(
        `DELETE gp FROM \`${this.prefix}tournament_group_players\` gp
         INNER JOIN \`${this.prefix}tournament_groups\` g ON g.id=gp.group_id
         WHERE g.tournament_id=?`,
        [tournamentId],
      );
      await db.execute(`DELETE FROM \`${this.prefix}tournament_groups\` WHERE tournament_id=?`, [tournamentId]);
      await db.execute(
        `UPDATE \`${this.prefix}tournament_players\`
            SET status='no_show', seed=NULL, seed_rating=NULL, seed_rating_source=NULL
          WHERE tournament_id=? AND status IN ('registered','paused')`,
        [tournamentId],
      );
      await db.execute(
        `UPDATE \`${this.prefix}tournament_players\`
            SET status='withdrawn', seed=NULL, seed_rating=NULL, seed_rating_source=NULL
          WHERE tournament_id=? AND status='waitlisted'`,
        [tournamentId],
      );
      await db.execute(
        `UPDATE \`${this.prefix}tournament_players\`
            SET seed=NULL, seed_rating=NULL, seed_rating_source=NULL
          WHERE tournament_id=?`,
        [tournamentId],
      );
      await db.execute(
        `UPDATE \`${this.prefix}tournaments\`
            SET status='in_progress',
                registration_closes_at=COALESCE(registration_closes_at, NOW()),
                group_count=NULL, group_draw_mode=NULL, group_draw_seed=NULL, group_drawn_at=NULL
          WHERE id=?`,
        [tournamentId],
      );
      await this.captureEloStartSnapshotWith(db, tournamentId);
    });

    return {
      tournament_id: tournamentId,
      status: "in_progress",
      checked_in_count: checkedIn,
      no_show_count: registered,
      withdrawn_waitlist_count: waitlisted,
      already_started: false,
    };
  }

  private async countRegistrations(tournamentId: string, statuses: readonly string[]): Promise<number> {
    if (statuses.length === 0) return 0;
    const placeholders = statuses.map(() => "?").join(",");
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT COUNT(*) AS cnt FROM \`${this.prefix}tournament_players\`
          WHERE tournament_id=? AND status IN (${placeholders})`,
        [tournamentId, ...statuses],
      );
      return Number(rows[0]?.cnt ?? 0);
    });
  }

  private async countMatches(tournamentId: string): Promise<number> {
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT COUNT(*) AS cnt FROM \`${this.prefix}matches\` WHERE tournament_id=?`,
        [tournamentId],
      );
      return Number(rows[0]?.cnt ?? 0);
    });
  }

  /**
   * Capture the immutable full-club ELO/rank baseline at the explicit start
   * mutation boundary. Spectator GETs must never create or repair these rows.
   */
  private async captureEloStartSnapshotWith(db: SqlExecutor, tournamentId: string): Promise<void> {
    const tournamentRows = await db.query<QueryResultRow>(
      `SELECT id,club_id,season_id,start_at,elo_enabled
         FROM \`${this.prefix}tournaments\` WHERE id=? LIMIT 1`,
      [tournamentId],
    );
    const tournament = tournamentRows[0];
    if (
      tournament === undefined
      || Number(tournament.elo_enabled ?? 0) !== 1
      || tournament.season_id === null
      || tournament.season_id === undefined
    ) {
      return;
    }

    const clubId = requiredId(tournament.club_id, "club_id");
    const seasonId = requiredId(tournament.season_id, "season_id");
    const capturedAt = sqlDateTime(tournament.start_at) ?? sqlDateTime(new Date())!;

    const rankedRows = await db.query<StartEloRow>(
      `SELECT p.id,p.display_name,ecr.rating,ecr.matches_played,
              COUNT(DISTINCT CASE WHEN m.status='completed' THEN m.id END) AS local_matches_played
         FROM \`${this.prefix}players\` p
         LEFT JOIN \`${this.prefix}elo_current_ratings\` ecr ON ecr.player_id=p.id AND ecr.season_id=?
         LEFT JOIN \`${this.prefix}matches\` m ON (m.player_a_id=p.id OR m.player_b_id=p.id)
        WHERE p.club_id=? AND p.is_active=1
        GROUP BY p.id,p.display_name,ecr.rating,ecr.matches_played
        ORDER BY p.display_name ASC`,
      [seasonId, clubId],
    );

    const byName = new Map<string, {
      playerId: string;
      displayName: string;
      rating: number;
      matches: number;
      localMatches: number;
    }>();
    for (const row of rankedRows) {
      if (row.rating === null || row.rating === undefined) continue;
      const matches = integer(row.matches_played);
      if (matches <= 0) continue;
      const candidate = {
        playerId: requiredId(row.id, "player_id"),
        displayName: String(row.display_name ?? ""),
        rating: finiteNumber(row.rating, 1000),
        matches,
        localMatches: integer(row.local_matches_played),
      };
      const key = candidate.displayName.trim().toLocaleLowerCase("nb-NO");
      const current = byName.get(key);
      if (
        current === undefined
        || candidate.localMatches > current.localMatches
        || (candidate.localMatches === current.localMatches && BigInt(candidate.playerId) < BigInt(current.playerId))
      ) {
        byName.set(key, candidate);
      }
    }

    const ranked = [...byName.values()].sort((left, right) => {
      const rating = right.rating - left.rating;
      return rating !== 0
        ? rating
        : left.displayName.localeCompare(right.displayName, "nb-NO", { sensitivity: "base" });
    });

    for (let index = 0; index < ranked.length; index += 1) {
      const row = ranked[index]!;
      await db.execute(
        `INSERT IGNORE INTO \`${this.prefix}tournament_elo_snapshots\`
          (tournament_id,season_id,club_id,player_id,elo_before,matches_before,rank_before,rank_baseline_kind,captured_start_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [tournamentId, seasonId, clubId, row.playerId, row.rating, row.matches, index + 1, "start", capturedAt],
      );
    }

    // Checked-in players without an established ranked club row still need a
    // baseline so their tournament delta can be displayed. They intentionally
    // have no start rank until they enter the ranking.
    const participants = await db.query<QueryResultRow>(
      `SELECT tp.player_id,COALESCE(ecr.rating,1000) AS rating,COALESCE(ecr.matches_played,0) AS matches_played
         FROM \`${this.prefix}tournament_players\` tp
         INNER JOIN \`${this.prefix}tournaments\` t ON t.id=tp.tournament_id
         LEFT JOIN \`${this.prefix}elo_current_ratings\` ecr ON ecr.season_id=t.season_id AND ecr.player_id=tp.player_id
        WHERE tp.tournament_id=? AND tp.status='checked_in'`,
      [tournamentId],
    );
    for (const participant of participants) {
      const playerId = requiredId(participant.player_id, "player_id");
      await db.execute(
        `INSERT IGNORE INTO \`${this.prefix}tournament_elo_snapshots\`
          (tournament_id,season_id,club_id,player_id,elo_before,matches_before,rank_before,rank_baseline_kind,captured_start_at)
         VALUES (?,?,?,?,?,?,NULL,'start',?)`,
        [
          tournamentId,
          seasonId,
          clubId,
          playerId,
          finiteNumber(participant.rating, 1000),
          integer(participant.matches_played),
          capturedAt,
        ],
      );
    }
  }
}

function requiredId(value: unknown, name: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new DomainValidationError("invalid_id", `${name} must be a positive decimal id.`, 400);
  }
  return normalized;
}

function integer(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function finiteNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function sqlDateTime(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 19).replace("T", " ");
  }
  const text = String(value ?? "").trim();
  return text === "" ? null : text.slice(0, 19).replace("T", " ");
}
