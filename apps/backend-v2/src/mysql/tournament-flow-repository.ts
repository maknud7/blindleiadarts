import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, TablePrefix } from "./contracts.js";

interface TournamentRow extends QueryResultRow {
  id: string | number;
  club_id: string | number;
  name: string;
  status: string;
  start_at: string | null;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
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

  async findTournament(tournamentId: string): Promise<TournamentRow | null> {
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<TournamentRow>(
        `SELECT id, club_id, name, status, start_at, registration_opens_at, registration_closes_at
           FROM \`${this.prefix}tournaments\` WHERE id=? LIMIT 1`,
        [tournamentId],
      );
      return rows[0] ?? null;
    });
  }

  async startTournament(tournamentId: string): Promise<TournamentStartResult> {
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
      await this.captureEloStartSnapshot(tournamentId);
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
      await this.captureEloStartSnapshotWithExecutor(db, tournamentId);
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

  private async captureEloStartSnapshot(tournamentId: string): Promise<void> {
    await this.sessions.withConnection((db) => this.captureEloStartSnapshotWithExecutor(db, tournamentId));
  }

  private async captureEloStartSnapshotWithExecutor(
    db: { execute(sql: string, params?: readonly unknown[]): Promise<{ affectedRows: number }> },
    tournamentId: string,
  ): Promise<void> {
    await db.execute(
      `INSERT IGNORE INTO \`${this.prefix}tournament_elo_snapshots\`
       (tournament_id,season_id,club_id,player_id,elo_before,matches_before,captured_start_at)
       SELECT t.id,t.season_id,t.club_id,tp.player_id,
              COALESCE(ecr.rating,1000),COALESCE(ecr.matches_played,0),COALESCE(t.start_at,NOW())
         FROM \`${this.prefix}tournaments\` t
         INNER JOIN \`${this.prefix}tournament_players\` tp ON tp.tournament_id=t.id
         LEFT JOIN \`${this.prefix}elo_current_ratings\` ecr ON ecr.season_id=t.season_id AND ecr.player_id=tp.player_id
        WHERE t.id=? AND t.elo_enabled=1 AND t.season_id IS NOT NULL
          AND tp.status='checked_in'`,
      [tournamentId],
    );
  }
}
