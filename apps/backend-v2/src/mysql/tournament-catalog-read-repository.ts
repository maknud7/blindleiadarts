import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

export class MySqlTournamentCatalogReadRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly prefix: TablePrefix,
  ) {}

  async listByClubId(clubIdInput: unknown): Promise<Record<string, unknown>[]> {
    const clubId = requiredId(clubIdInput, "club_id");
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT t.id,t.club_id,t.season_id,t.name,t.slug,t.provider_system,t.status,t.max_visits_per_leg,
                t.start_at,t.end_at,
                COUNT(DISTINCT tp.id) AS registration_count,
                COUNT(DISTINCT m.id) AS match_count,
                COUNT(DISTINCT CASE WHEN m.status='completed' THEN m.id END) AS completed_match_count
           FROM \`${this.prefix}tournaments\` t
           LEFT JOIN \`${this.prefix}tournament_players\` tp ON tp.tournament_id=t.id AND tp.status<>'withdrawn'
           LEFT JOIN \`${this.prefix}matches\` m ON m.tournament_id=t.id
          WHERE t.club_id=?
          GROUP BY t.id,t.club_id,t.season_id,t.name,t.slug,t.provider_system,t.status,t.max_visits_per_leg,t.start_at,t.end_at
          ORDER BY COALESCE(t.start_at,'2999-12-31 23:59:59') ASC,t.id DESC`,
        [clubId],
      );
      return rows.map(formatTournamentListItem);
    });
  }

  async findDetail(tournamentIdInput: unknown): Promise<Record<string, unknown> | null> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT t.id,t.club_id,c.name AS club_name,t.season_id,t.name,t.slug,t.provider_system,t.status,
                t.max_visits_per_leg,t.start_at,t.end_at
           FROM \`${this.prefix}tournaments\` t
           INNER JOIN \`${this.prefix}clubs\` c ON c.id=t.club_id
          WHERE t.id=? LIMIT 1`,
        [tournamentId],
      );
      const tournament = rows[0];
      if (!tournament) return null;
      return {
        ...formatTournament(tournament),
        club_name: tournament.club_name ?? null,
        registrations: await this.listRegistrationsWith(db, tournamentId),
        matches: await this.listMatchesWith(db, tournamentId),
      };
    });
  }

  async listMatches(tournamentIdInput: unknown): Promise<Record<string, unknown>[]> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withConnection((db) => this.listMatchesWith(db, tournamentId));
  }

  private async listRegistrationsWith(db: SqlExecutor, tournamentId: string): Promise<Record<string, unknown>[]> {
    const rows = await db.query<QueryResultRow>(
      `SELECT tp.id,tp.player_id,tp.seed,tp.status,tp.created_at,p.display_name,p.nickname,
              mp.contact_email,mp.contact_phone
         FROM \`${this.prefix}tournament_players\` tp
         INNER JOIN \`${this.prefix}players\` p ON p.id=tp.player_id
         LEFT JOIN \`${this.prefix}member_profiles\` mp ON mp.player_id=p.id
        WHERE tp.tournament_id=?
        ORDER BY tp.created_at ASC,p.display_name ASC`,
      [tournamentId],
    );
    return rows.map((row) => ({
      id: requiredId(row.id, "registration_id"),
      player_id: requiredId(row.player_id, "player_id"),
      seed: row.seed == null ? null : numberValue(row.seed),
      status: row.status ?? null,
      created_at: row.created_at ?? null,
      display_name: row.display_name ?? null,
      nickname: row.nickname ?? null,
      contact_email: row.contact_email ?? null,
      contact_phone: row.contact_phone ?? null,
    }));
  }

  private async listMatchesWith(db: SqlExecutor, tournamentId: string): Promise<Record<string, unknown>[]> {
    const rows = await db.query<QueryResultRow>(
      `SELECT m.id,m.kiosk_id,m.round_label,m.bracket_label,m.status,m.best_of_legs,m.legs_to_win,
              m.player_a_id,pa.display_name AS player_a_name,m.player_b_id,pb.display_name AS player_b_name,
              m.winner_player_id,pw.display_name AS winner_name,m.starts_at,m.finished_at,
              k.code AS kiosk_code,k.name AS kiosk_name,k.board_number
         FROM \`${this.prefix}matches\` m
         INNER JOIN \`${this.prefix}players\` pa ON pa.id=m.player_a_id
         INNER JOIN \`${this.prefix}players\` pb ON pb.id=m.player_b_id
         LEFT JOIN \`${this.prefix}players\` pw ON pw.id=m.winner_player_id
         LEFT JOIN \`${this.prefix}kiosks\` k ON k.id=m.kiosk_id
        WHERE m.tournament_id=?
        ORDER BY FIELD(m.status,'in_progress','assigned','pending','completed','cancelled'),m.id ASC`,
      [tournamentId],
    );
    return rows.map((row) => ({
      id: requiredId(row.id, "match_id"),
      kiosk_id: nullableId(row.kiosk_id),
      round_label: row.round_label ?? null,
      bracket_label: row.bracket_label ?? null,
      status: row.status ?? null,
      best_of_legs: numberValue(row.best_of_legs),
      legs_to_win: numberValue(row.legs_to_win),
      player_a_id: requiredId(row.player_a_id, "player_a_id"),
      player_a_name: row.player_a_name ?? null,
      player_b_id: requiredId(row.player_b_id, "player_b_id"),
      player_b_name: row.player_b_name ?? null,
      winner_player_id: nullableId(row.winner_player_id),
      winner_name: row.winner_name ?? null,
      starts_at: row.starts_at ?? null,
      finished_at: row.finished_at ?? null,
      kiosk_code: row.kiosk_code ?? null,
      kiosk_name: row.kiosk_name ?? null,
      board_number: row.board_number == null ? null : numberValue(row.board_number),
    }));
  }
}

function formatTournamentListItem(row: QueryResultRow): Record<string, unknown> {
  return {
    ...formatTournament(row),
    registration_count: numberValue(row.registration_count),
    match_count: numberValue(row.match_count),
    completed_match_count: numberValue(row.completed_match_count),
  };
}

function formatTournament(row: QueryResultRow): Record<string, unknown> {
  return {
    id: requiredId(row.id, "tournament_id"),
    club_id: requiredId(row.club_id, "club_id"),
    season_id: nullableId(row.season_id),
    name: row.name ?? null,
    slug: row.slug ?? null,
    provider_system: row.provider_system ?? null,
    status: row.status ?? null,
    max_visits_per_leg: numberValue(row.max_visits_per_leg),
    start_at: row.start_at ?? null,
    end_at: row.end_at ?? null,
  };
}

function requiredId(value: unknown, name: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new TypeError(`${name} must be a positive decimal id.`);
  return normalized;
}

function nullableId(value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  return requiredId(value, "id");
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
