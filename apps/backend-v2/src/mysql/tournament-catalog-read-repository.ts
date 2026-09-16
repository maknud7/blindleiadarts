import { eloBaselineFor } from "../data/mandagsserien-elo-2026-08-24.js";
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

  async listClubPlayers(clubIdInput: unknown): Promise<Record<string, unknown>[]> {
    const clubId = requiredId(clubIdInput, "club_id");
    return this.sessions.withConnection((db) => this.listClubPlayersWith(db, clubId));
  }

  async getClubDashboard(clubIdInput: unknown): Promise<Record<string, unknown> | null> {
    const clubId = requiredId(clubIdInput, "club_id");
    return this.sessions.withConnection(async (db) => {
      const clubRows = await db.query<QueryResultRow>(
        `SELECT id,name,slug,logo_url,kiosk_pairing_code,created_at,updated_at
           FROM \`${this.prefix}clubs\`
          WHERE id=?
          LIMIT 1`,
        [clubId],
      );
      const club = clubRows[0];
      if (!club) return null;

      const [players, kiosks, tournaments, recentMatches] = await Promise.all([
        this.listClubPlayersWith(db, clubId),
        this.listClubKiosksWith(db, clubId),
        this.listClubTournamentSummariesWith(db, clubId),
        this.listRecentClubMatchesWith(db, clubId),
      ]);

      return {
        club: {
          id: requiredId(club.id, "club_id"),
          name: club.name ?? null,
          slug: club.slug ?? null,
          logo_url: club.logo_url ?? null,
          kiosk_pairing_code: club.kiosk_pairing_code ?? null,
          created_at: club.created_at ?? null,
          updated_at: club.updated_at ?? null,
        },
        players,
        kiosks,
        tournaments,
        recent_matches: recentMatches,
      };
    });
  }

  async listClubElo(clubIdInput: unknown): Promise<Record<string, unknown>[]> {
    const clubId = requiredId(clubIdInput, "club_id");
    return this.sessions.withConnection(async (db) => {
      const seasonId = await this.resolveEloSeasonId(db, clubId);
      const rows = await db.query<QueryResultRow>(
        `SELECT p.id,p.display_name,p.nickname,p.avatar_url,
                ecr.rating AS elo_rating,ecr.matches_played AS elo_matches_played,ecr.updated_at AS elo_calculated_at,
                COUNT(DISTINCT CASE WHEN m.status='completed' THEN m.id END) AS local_matches_played,
                COUNT(DISTINCT CASE WHEN m.status='completed' AND m.winner_player_id=p.id THEN m.id END) AS matches_won
           FROM \`${this.prefix}players\` p
           LEFT JOIN \`${this.prefix}elo_current_ratings\` ecr ON ecr.player_id=p.id AND ecr.season_id=?
           LEFT JOIN \`${this.prefix}matches\` m ON (m.player_a_id=p.id OR m.player_b_id=p.id)
          WHERE p.club_id=? AND p.is_active=1
          GROUP BY p.id,p.display_name,p.nickname,p.avatar_url,ecr.rating,ecr.matches_played,ecr.updated_at
          ORDER BY p.display_name ASC`,
        [seasonId, clubId],
      );

      const normalized = rows.map((row) => normalizeEloRow(row, seasonId));
      const byName = new Map<string, Record<string, unknown>>();
      for (const row of normalized) {
        const key = normalizedName(row.display_name);
        const current = byName.get(key);
        if (current === undefined || preferEloRow(row, current)) byName.set(key, row);
      }

      const ranked = [...byName.values()]
        .filter((row) => integer(row.elo_matches_played) > 0)
        .sort((a, b) => {
          const rating = numberValue(b.elo_rating, 1000) - numberValue(a.elo_rating, 1000);
          if (rating !== 0) return rating;
          return compareNames(a.display_name, b.display_name);
        });

      return ranked.map((row, index) => ({
        ...row,
        position: index + 1,
        matches_played: integer(row.elo_matches_played),
        baseline_played: integer(row.elo_matches_played),
      }));
    });
  }

  async getTournamentEloSetting(tournamentIdInput: unknown): Promise<Record<string, unknown> | null> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT id,club_id,season_id,name,elo_enabled
           FROM \`${this.prefix}tournaments\` WHERE id=? LIMIT 1`,
        [tournamentId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: requiredId(row.id, "tournament_id"),
        club_id: requiredId(row.club_id, "club_id"),
        season_id: nullableId(row.season_id),
        name: row.name ?? null,
        elo_enabled: integer(row.elo_enabled) === 1,
      };
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

  private async listClubPlayersWith(db: SqlExecutor, clubId: string): Promise<Record<string, unknown>[]> {
    const rows = await db.query<QueryResultRow>(
      `SELECT p.id,p.display_name,p.first_name,p.last_name,p.nickname,p.avatar_url,p.is_active,
              mp.contact_email,mp.contact_phone,
              ua.id AS user_account_id,ua.username,ua.role
         FROM \`${this.prefix}players\` p
         LEFT JOIN \`${this.prefix}member_profiles\` mp ON mp.player_id=p.id
         LEFT JOIN \`${this.prefix}user_accounts\` ua ON ua.id=mp.user_account_id
        WHERE p.club_id=?
        ORDER BY p.display_name ASC`,
      [clubId],
    );
    return rows.map((row) => ({
      id: requiredId(row.id, "player_id"),
      display_name: row.display_name ?? null,
      first_name: row.first_name ?? null,
      last_name: row.last_name ?? null,
      nickname: row.nickname ?? null,
      avatar_url: row.avatar_url ?? null,
      is_active: integer(row.is_active),
      contact_email: row.contact_email ?? null,
      contact_phone: row.contact_phone ?? null,
      user_account_id: nullableId(row.user_account_id),
      username: row.username ?? null,
      role: row.role ?? null,
    }));
  }

  private async listClubKiosksWith(db: SqlExecutor, clubId: string): Promise<Record<string, unknown>[]> {
    const rows = await db.query<QueryResultRow>(
      `SELECT id,code,name,board_number,sponsor_label,sponsor_logo_url,scoring_mode,
              CASE WHEN pairing_token_hash IS NULL OR pairing_token_hash='' THEN 0 ELSE 1 END AS is_paired,
              paired_device_name,paired_at,is_active,last_seen_at
         FROM \`${this.prefix}kiosks\`
        WHERE club_id=?
        ORDER BY board_number ASC,name ASC`,
      [clubId],
    );
    return rows.map((row) => ({
      id: requiredId(row.id, "kiosk_id"),
      code: row.code ?? null,
      name: row.name ?? null,
      board_number: integer(row.board_number),
      sponsor_label: row.sponsor_label ?? null,
      sponsor_logo_url: row.sponsor_logo_url ?? null,
      scoring_mode: row.scoring_mode ?? null,
      is_paired: integer(row.is_paired),
      paired_device_name: row.paired_device_name ?? null,
      paired_at: row.paired_at ?? null,
      is_active: integer(row.is_active),
      last_seen_at: row.last_seen_at ?? null,
    }));
  }

  private async listClubTournamentSummariesWith(db: SqlExecutor, clubId: string): Promise<Record<string, unknown>[]> {
    const rows = await db.query<QueryResultRow>(
      `SELECT t.id,t.name,t.slug,t.provider_system,t.status,t.start_at,t.end_at,
              COUNT(DISTINCT tp.id) AS registration_count,
              COUNT(DISTINCT m.id) AS match_count,
              COUNT(DISTINCT CASE WHEN m.status='completed' THEN m.id END) AS completed_match_count
         FROM \`${this.prefix}tournaments\` t
         LEFT JOIN \`${this.prefix}tournament_players\` tp ON tp.tournament_id=t.id AND tp.status<>'withdrawn'
         LEFT JOIN \`${this.prefix}matches\` m ON m.tournament_id=t.id
        WHERE t.club_id=?
        GROUP BY t.id,t.name,t.slug,t.provider_system,t.status,t.start_at,t.end_at
        ORDER BY COALESCE(t.start_at,'2999-12-31 23:59:59') ASC,t.id DESC`,
      [clubId],
    );
    return rows.map((row) => ({
      id: requiredId(row.id, "tournament_id"),
      name: row.name ?? null,
      slug: row.slug ?? null,
      provider_system: row.provider_system ?? null,
      status: row.status ?? null,
      start_at: row.start_at ?? null,
      end_at: row.end_at ?? null,
      registration_count: integer(row.registration_count),
      match_count: integer(row.match_count),
      completed_match_count: integer(row.completed_match_count),
    }));
  }

  private async listRecentClubMatchesWith(db: SqlExecutor, clubId: string): Promise<Record<string, unknown>[]> {
    const rows = await db.query<QueryResultRow>(
      `SELECT m.id,m.status,m.round_label,m.bracket_label,m.starts_at,m.finished_at,
              t.id AS tournament_id,t.name AS tournament_name,
              k.code AS kiosk_code,k.board_number,
              pa.display_name AS player_a_name,pb.display_name AS player_b_name,pw.display_name AS winner_name
         FROM \`${this.prefix}matches\` m
         INNER JOIN \`${this.prefix}tournaments\` t ON t.id=m.tournament_id
         INNER JOIN \`${this.prefix}players\` pa ON pa.id=m.player_a_id
         INNER JOIN \`${this.prefix}players\` pb ON pb.id=m.player_b_id
         LEFT JOIN \`${this.prefix}players\` pw ON pw.id=m.winner_player_id
         LEFT JOIN \`${this.prefix}kiosks\` k ON k.id=m.kiosk_id
        WHERE t.club_id=?
        ORDER BY COALESCE(m.finished_at,m.starts_at,m.id) DESC
        LIMIT 12`,
      [clubId],
    );
    return rows.map((row) => ({
      id: requiredId(row.id, "match_id"),
      status: row.status ?? null,
      round_label: row.round_label ?? null,
      bracket_label: row.bracket_label ?? null,
      starts_at: row.starts_at ?? null,
      finished_at: row.finished_at ?? null,
      tournament_id: requiredId(row.tournament_id, "tournament_id"),
      tournament_name: row.tournament_name ?? null,
      kiosk_code: row.kiosk_code ?? null,
      board_number: row.board_number == null ? null : integer(row.board_number),
      player_a_name: row.player_a_name ?? null,
      player_b_name: row.player_b_name ?? null,
      winner_name: row.winner_name ?? null,
    }));
  }

  private async resolveEloSeasonId(db: SqlExecutor, clubId: string): Promise<string> {
    const rows = await db.query<QueryResultRow>(
      `SELECT id FROM \`${this.prefix}seasons\`
        WHERE club_id=?
        ORDER BY is_active DESC,COALESCE(starts_on,'0000-01-01') DESC,id DESC
        LIMIT 1`,
      [clubId],
    );
    return rows[0] ? requiredId(rows[0].id, "season_id") : "0";
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

function normalizeEloRow(row: QueryResultRow, seasonId: string): Record<string, unknown> {
  const playerId = requiredId(row.id, "player_id");
  const baseline = eloBaselineFor(row.display_name);
  const hasLedger = row.elo_rating !== null && row.elo_rating !== undefined;
  const played = hasLedger ? integer(row.elo_matches_played) : (baseline?.played ?? 0);
  return {
    ...row,
    id: playerId,
    elo_rating: hasLedger ? numberValue(row.elo_rating, 1000) : (baseline?.rating ?? 1000),
    elo_matches_played: played,
    elo_source: hasLedger ? "elo_ledger" : baseline ? "mandagsserien_2026_08_24" : "default_1000",
    local_matches_played: integer(row.local_matches_played),
    matches_won: integer(row.matches_won),
    season_id: seasonId,
  };
}

function preferEloRow(candidate: Record<string, unknown>, current: Record<string, unknown>): boolean {
  const candidateLedger = candidate.elo_source === "elo_ledger" ? 1 : 0;
  const currentLedger = current.elo_source === "elo_ledger" ? 1 : 0;
  if (candidateLedger !== currentLedger) return candidateLedger > currentLedger;
  const candidateMatches = integer(candidate.local_matches_played);
  const currentMatches = integer(current.local_matches_played);
  if (candidateMatches !== currentMatches) return candidateMatches > currentMatches;
  return compareDecimalIds(requiredId(candidate.id, "player_id"), requiredId(current.id, "player_id")) < 0;
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

function integer(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizedName(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase("nb-NO");
}

function compareNames(a: unknown, b: unknown): number {
  return String(a ?? "").localeCompare(String(b ?? ""), "nb-NO", { sensitivity: "base" });
}

function compareDecimalIds(a: string, b: string): number {
  const aa = a.replace(/^0+/, "") || "0";
  const bb = b.replace(/^0+/, "") || "0";
  if (aa.length !== bb.length) return aa.length < bb.length ? -1 : 1;
  return aa === bb ? 0 : aa < bb ? -1 : 1;
}