import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

export const PLAYER_BREAK_MINUTES = 7;

export class MySqlTournamentPlayerBreakRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly prefix: TablePrefix,
  ) {}

  async requestBreak(tournamentIdInput: unknown, playerIdInput: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    const playerId = requiredId(playerIdInput, "player_id");
    return this.sessions.withTransaction(async (db) => {
      await this.normalizeTournamentWith(db, tournamentId);
      const existing = await this.currentBreakWith(db, tournamentId, playerId);
      if (existing !== null && ["scheduled", "active"].includes(String(existing.status ?? ""))) return existing;

      await this.assertEligibleWith(db, tournamentId, playerId);
      const match = await this.activeMatchWith(db, tournamentId, playerId);
      if (match !== null) {
        await db.execute(
          `INSERT INTO \`${this.prefix}tournament_player_breaks\`
            (tournament_id,player_id,after_match_id,status,requested_at)
           VALUES (?,?,?,'scheduled',NOW())`,
          [tournamentId, playerId, requiredId(match.id, "match_id")],
        );
      } else {
        await db.execute(
          `INSERT INTO \`${this.prefix}tournament_player_breaks\`
            (tournament_id,player_id,status,requested_at,starts_at,ends_at)
           VALUES (?,?,'active',NOW(),NOW(),DATE_ADD(NOW(),INTERVAL ${PLAYER_BREAK_MINUTES} MINUTE))`,
          [tournamentId, playerId],
        );
      }
      await db.execute(
        `UPDATE \`${this.prefix}tournament_players\` SET status='paused'
          WHERE tournament_id=? AND player_id=? AND status='checked_in'`,
        [tournamentId, playerId],
      );
      const fresh = await this.currentBreakWith(db, tournamentId, playerId);
      if (fresh === null) throw new DomainValidationError("break_not_found", "Pauseforespørselen ble ikke funnet etter opprettelse.", 500);
      return fresh;
    });
  }

  async getStatus(tournamentIdInput: unknown, playerIdInput: unknown): Promise<Record<string, unknown> | null> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    const playerId = requiredId(playerIdInput, "player_id");
    return this.sessions.withTransaction(async (db) => {
      await this.normalizeTournamentWith(db, tournamentId);
      return this.currentBreakWith(db, tournamentId, playerId);
    });
  }

  async findContext(playerIdInput: unknown): Promise<Record<string, unknown> | null> {
    const playerId = requiredId(playerIdInput, "player_id");
    return this.sessions.withTransaction(async (db) => {
      await this.normalizeAllWith(db);
      const rows = await db.query<QueryResultRow>(
        `SELECT t.id AS tournament_id,t.name AS tournament_name,t.status AS tournament_status,
                t.start_at,t.end_at,tp.status AS registration_status
           FROM \`${this.prefix}tournament_players\` tp
           INNER JOIN \`${this.prefix}tournaments\` t ON t.id=tp.tournament_id
          WHERE tp.player_id=? AND tp.status IN ('checked_in','paused')
            AND t.status IN ('ready','in_progress')
          ORDER BY FIELD(t.status,'in_progress','ready'),COALESCE(t.start_at,'2999-12-31 23:59:59') ASC,t.id ASC`,
        [playerId],
      );
      let selected: QueryResultRow | null = null;
      for (const candidate of rows) {
        const tournamentId = requiredId(candidate.tournament_id, "tournament_id");
        if (await this.isTournamentLiveNowWith(db, tournamentId, playerId)) {
          selected = candidate;
          break;
        }
      }
      if (selected === null) return null;
      const tournamentId = requiredId(selected.tournament_id, "tournament_id");
      return {
        ...selected,
        tournament_id: publicId(tournamentId),
        break_minutes: PLAYER_BREAK_MINUTES,
        break: await this.currentBreakWith(db, tournamentId, playerId),
        match: await this.activeMatchWith(db, tournamentId, playerId),
      };
    });
  }

  async normalizeTournament(tournamentIdInput: unknown): Promise<void> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    await this.sessions.withTransaction((db) => this.normalizeTournamentWith(db, tournamentId));
  }

  private async normalizeAllWith(db: SqlExecutor): Promise<void> {
    const rows = await db.query<QueryResultRow>(
      `SELECT DISTINCT tournament_id FROM \`${this.prefix}tournament_player_breaks\`
        WHERE status IN ('scheduled','active')`,
    );
    for (const row of rows) {
      await this.normalizeTournamentWith(db, requiredId(row.tournament_id, "tournament_id"));
    }
  }

  private async normalizeTournamentWith(db: SqlExecutor, tournamentId: string): Promise<void> {
    await db.execute(
      `UPDATE \`${this.prefix}tournament_player_breaks\` pb
       INNER JOIN \`${this.prefix}matches\` m ON m.id=pb.after_match_id
          SET pb.starts_at=COALESCE(m.finished_at,NOW()),
              pb.ends_at=DATE_ADD(COALESCE(m.finished_at,NOW()),INTERVAL ${PLAYER_BREAK_MINUTES} MINUTE),
              pb.status=CASE
                WHEN DATE_ADD(COALESCE(m.finished_at,NOW()),INTERVAL ${PLAYER_BREAK_MINUTES} MINUTE)<=NOW() THEN 'completed'
                ELSE 'active'
              END
        WHERE pb.tournament_id=? AND pb.status='scheduled' AND m.status IN ('completed','cancelled')`,
      [tournamentId],
    );
    await db.execute(
      `UPDATE \`${this.prefix}tournament_player_breaks\` SET status='completed'
        WHERE tournament_id=? AND status='active' AND ends_at<=NOW()`,
      [tournamentId],
    );
    await db.execute(
      `UPDATE \`${this.prefix}tournament_players\` tp
       INNER JOIN \`${this.prefix}tournament_player_breaks\` pb
          ON pb.tournament_id=tp.tournament_id AND pb.player_id=tp.player_id
          SET tp.status='paused'
        WHERE tp.tournament_id=? AND pb.status IN ('scheduled','active')
          AND tp.status IN ('registered','checked_in','paused')`,
      [tournamentId],
    );
    await db.execute(
      `UPDATE \`${this.prefix}tournament_players\` tp SET tp.status='checked_in'
        WHERE tp.tournament_id=? AND tp.status='paused'
          AND NOT EXISTS (
            SELECT 1 FROM \`${this.prefix}tournament_player_breaks\` pb
             WHERE pb.tournament_id=tp.tournament_id AND pb.player_id=tp.player_id
               AND pb.status IN ('scheduled','active')
          )`,
      [tournamentId],
    );
  }

  private async assertEligibleWith(db: SqlExecutor, tournamentId: string, playerId: string): Promise<void> {
    const rows = await db.query<QueryResultRow>(
      `SELECT t.status AS tournament_status,tp.status AS registration_status
         FROM \`${this.prefix}tournaments\` t
         INNER JOIN \`${this.prefix}tournament_players\` tp ON tp.tournament_id=t.id AND tp.player_id=?
        WHERE t.id=? LIMIT 1`,
      [playerId, tournamentId],
    );
    const row = rows[0];
    if (!row) throw new DomainValidationError("registration_not_found", "Du er ikke registrert i denne turneringen.", 404);
    if (String(row.registration_status ?? "") !== "checked_in") {
      throw new DomainValidationError("check_in_required_for_break", "Du må være checket inn før du kan ta pause.", 409);
    }
    if (!["ready", "in_progress"].includes(String(row.tournament_status ?? "")) ||
        !(await this.isTournamentLiveNowWith(db, tournamentId, playerId))) {
      throw new DomainValidationError("tournament_not_active_for_break", "Pause kan bare brukes mens turneringen faktisk pågår nå.", 409);
    }
  }

  private async isTournamentLiveNowWith(db: SqlExecutor, tournamentId: string, playerId: string): Promise<boolean> {
    const rows = await db.query<QueryResultRow>(
      `SELECT CASE WHEN
          EXISTS (
            SELECT 1 FROM \`${this.prefix}matches\` m
             WHERE m.tournament_id=t.id AND (m.player_a_id=? OR m.player_b_id=?)
               AND m.status IN ('pending','assigned','in_progress')
          ) OR (
            t.start_at IS NOT NULL
            AND t.start_at BETWEEN DATE_SUB(NOW(),INTERVAL 18 HOUR) AND DATE_ADD(NOW(),INTERVAL 6 HOUR)
            AND (t.end_at IS NULL OR t.end_at>=NOW())
          ) OR (
            t.start_at IS NOT NULL AND t.start_at<=NOW() AND t.end_at IS NOT NULL AND t.end_at>=NOW()
          ) THEN 1 ELSE 0 END AS live_now
         FROM \`${this.prefix}tournaments\` t
        WHERE t.id=? AND t.status IN ('ready','in_progress') LIMIT 1`,
      [playerId, playerId, tournamentId],
    );
    return Number(rows[0]?.live_now ?? 0) === 1;
  }

  private async activeMatchWith(db: SqlExecutor, tournamentId: string, playerId: string): Promise<Record<string, unknown> | null> {
    const rows = await db.query<QueryResultRow>(
      `SELECT id,status,starts_at,round_label,bracket_label FROM \`${this.prefix}matches\`
        WHERE tournament_id=? AND (player_a_id=? OR player_b_id=?)
          AND status IN ('assigned','in_progress')
        ORDER BY FIELD(status,'in_progress','assigned'),id ASC LIMIT 1`,
      [tournamentId, playerId, playerId],
    );
    const row = rows[0];
    return row ? { ...row, id: publicId(requiredId(row.id, "match_id")) } : null;
  }

  private async currentBreakWith(db: SqlExecutor, tournamentId: string, playerId: string): Promise<Record<string, unknown> | null> {
    const rows = await db.query<QueryResultRow>(
      `SELECT pb.id,pb.tournament_id,pb.player_id,pb.after_match_id,pb.status,
              pb.requested_at,pb.starts_at,pb.ends_at,
              CASE WHEN pb.status='active' THEN GREATEST(0,TIMESTAMPDIFF(SECOND,NOW(),pb.ends_at)) ELSE NULL END AS remaining_seconds,
              m.status AS after_match_status,m.round_label AS after_match_round
         FROM \`${this.prefix}tournament_player_breaks\` pb
         LEFT JOIN \`${this.prefix}matches\` m ON m.id=pb.after_match_id
        WHERE pb.tournament_id=? AND pb.player_id=?
        ORDER BY FIELD(pb.status,'active','scheduled','completed'),pb.id DESC LIMIT 1`,
      [tournamentId, playerId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      id: publicId(requiredId(row.id, "break_id")),
      tournament_id: publicId(requiredId(row.tournament_id, "tournament_id")),
      player_id: publicId(requiredId(row.player_id, "player_id")),
      after_match_id: optionalPublicId(row.after_match_id),
      break_minutes: PLAYER_BREAK_MINUTES,
      remaining_seconds: row.remaining_seconds == null ? null : Math.max(0, Number(row.remaining_seconds)),
    };
  }
}

function requiredId(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new DomainValidationError("invalid_id", `${field} must be a positive decimal id.`, 400);
  }
  return normalized;
}

function publicId(value: string): number | string {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

function optionalPublicId(value: unknown): number | string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? publicId(normalized) : null;
}
