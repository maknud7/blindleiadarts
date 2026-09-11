import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

type TableRow = Record<string, unknown> & {
  _player_id: string;
  display_name: string;
  points: number;
  leg_diff: number;
  head_to_head_points: number;
  three_dart_average: number;
};

export class MySqlTournamentPublicReadRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
  ) {}

  async tournamentTables(tournamentId: string): Promise<Record<string, unknown> | null> {
    return this.sessions.withConnection((db) => this.tournamentTablesWithDb(db, tournamentId));
  }

  async tournamentResults(tournamentId: string): Promise<Record<string, unknown> | null> {
    return this.sessions.withConnection(async (db) => {
      const tables = await this.tournamentTablesWithDb(db, tournamentId);
      if (tables === null) return null;
      return {
        tournament: tables.tournament,
        items: await this.listTournamentMatchesWithDb(db, tournamentId, 250),
      };
    });
  }

  async matchDetail(matchId: string): Promise<Record<string, unknown> | null> {
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT m.id,m.tournament_id,t.name AS tournament_name,t.season_id,
                m.tournament_group_id,g.name AS group_name,m.round_label,m.round_number,m.bracket_label,
                m.status,m.best_of_legs,m.legs_to_win,m.winner_player_id,m.starts_at,m.finished_at,
                m.kiosk_id,k.board_number,
                m.player_a_id,pa.display_name AS player_a_name,pa.nickname AS player_a_nickname,
                m.player_b_id,pb.display_name AS player_b_name,pb.nickname AS player_b_nickname
           FROM ${this.table("matches")} m
           INNER JOIN ${this.table("tournaments")} t ON t.id=m.tournament_id
           INNER JOIN ${this.table("players")} pa ON pa.id=m.player_a_id
           INNER JOIN ${this.table("players")} pb ON pb.id=m.player_b_id
           LEFT JOIN ${this.table("tournament_groups")} g ON g.id=m.tournament_group_id
           LEFT JOIN ${this.table("kiosks")} k ON k.id=m.kiosk_id
          WHERE m.id=? LIMIT 1`,
        [matchId],
      );
      const rawMatch = rows[0];
      if (rawMatch === undefined) return null;
      const match = normalizeIds(rawMatch, [
        "id", "tournament_id", "season_id", "tournament_group_id", "round_number", "best_of_legs",
        "legs_to_win", "winner_player_id", "kiosk_id", "board_number", "player_a_id", "player_b_id",
      ]);

      const statsRows = await db.query<QueryResultRow>(
        `SELECT ms.player_id,ms.legs_won,ms.average,ms.first_nine_average,ms.darts_thrown,
                ms.checkout_hits,ms.checkout_attempts,ms.highest_checkout,
                ms.score_100_plus,ms.score_140_plus,ms.score_180
           FROM ${this.table("match_statistics")} ms WHERE ms.match_id=?`,
        [matchId],
      );
      const stats = new Map<string, Record<string, unknown>>();
      for (const raw of statsRows) {
        const playerId = decimalId(raw.player_id);
        if (playerId === null) continue;
        const row: Record<string, unknown> = {
          ...raw,
          player_id: publicId(playerId),
        };
        for (const field of ["legs_won", "darts_thrown", "checkout_hits", "checkout_attempts", "highest_checkout", "score_100_plus", "score_140_plus", "score_180"]) {
          row[field] = raw[field] === null || raw[field] === undefined ? null : integer(raw[field]);
        }
        for (const field of ["average", "first_nine_average"]) {
          row[field] = raw[field] === null || raw[field] === undefined ? null : numberValue(raw[field]);
        }
        const attempts = integer(row.checkout_attempts);
        row.checkout_percentage = attempts > 0 ? round((integer(row.checkout_hits) / attempts) * 100, 1) : null;
        stats.set(playerId, row);
      }

      const legs = (await db.query<QueryResultRow>(
        `SELECT l.id,l.leg_number,l.starting_player_id,l.winner_player_id,l.status,l.start_score,l.finished_at,
                COALESCE(ROUND(SUM(CASE WHEN v.player_id=m.player_a_id AND v.is_bust=0 THEN v.score ELSE 0 END)*3/
                    NULLIF(SUM(CASE WHEN v.player_id=m.player_a_id THEN v.darts_used ELSE 0 END),0),2),0) AS player_a_average,
                COALESCE(ROUND(SUM(CASE WHEN v.player_id=m.player_b_id AND v.is_bust=0 THEN v.score ELSE 0 END)*3/
                    NULLIF(SUM(CASE WHEN v.player_id=m.player_b_id THEN v.darts_used ELSE 0 END),0),2),0) AS player_b_average,
                SUM(CASE WHEN v.player_id=m.player_a_id THEN v.darts_used ELSE 0 END) AS player_a_darts,
                SUM(CASE WHEN v.player_id=m.player_b_id THEN v.darts_used ELSE 0 END) AS player_b_darts
           FROM ${this.table("legs")} l
           INNER JOIN ${this.table("matches")} m ON m.id=l.match_id
           LEFT JOIN ${this.table("visits")} v ON v.leg_id=l.id
          WHERE l.match_id=?
          GROUP BY l.id,l.leg_number,l.starting_player_id,l.winner_player_id,l.status,l.start_score,l.finished_at,m.player_a_id,m.player_b_id
          ORDER BY l.leg_number ASC`,
        [matchId],
      )).map((raw) => ({
        ...normalizeIds(raw, ["id", "leg_number", "starting_player_id", "winner_player_id"]),
        start_score: integer(raw.start_score),
        player_a_darts: integer(raw.player_a_darts),
        player_b_darts: integer(raw.player_b_darts),
        player_a_average: numberValue(raw.player_a_average),
        player_b_average: numberValue(raw.player_b_average),
      }));

      const visits = (await db.query<QueryResultRow>(
        `SELECT v.id,v.leg_id,l.leg_number,v.player_id,v.visit_number,v.score,v.darts_used,v.input_mode,
                v.darts_json,v.is_bust,v.remaining_after,v.created_at
           FROM ${this.table("visits")} v
           INNER JOIN ${this.table("legs")} l ON l.id=v.leg_id
          WHERE v.match_id=? ORDER BY l.leg_number ASC,v.id ASC`,
        [matchId],
      )).map((raw) => {
        let darts: unknown[] = [];
        if (typeof raw.darts_json === "string" && raw.darts_json !== "") {
          try {
            const parsed: unknown = JSON.parse(raw.darts_json);
            darts = Array.isArray(parsed) ? parsed : [];
          } catch {
            darts = [];
          }
        }
        return {
          ...normalizeIds(raw, ["id", "leg_id", "player_id"]),
          leg_number: integer(raw.leg_number),
          visit_number: integer(raw.visit_number),
          score: integer(raw.score),
          darts_used: integer(raw.darts_used),
          remaining_after: integer(raw.remaining_after),
          is_bust: integer(raw.is_bust) === 1,
          darts,
          darts_json: undefined,
        };
      }).map(({ darts_json: _ignored, ...visit }) => visit);

      const playerAId = decimalId(rawMatch.player_a_id);
      const playerBId = decimalId(rawMatch.player_b_id);
      return {
        match,
        player_a_stats: playerAId === null ? null : (stats.get(playerAId) ?? null),
        player_b_stats: playerBId === null ? null : (stats.get(playerBId) ?? null),
        legs,
        visits,
      };
    });
  }

  async publishedSummaries(clubId: string, limit = 12): Promise<Record<string, unknown>[]> {
    return this.sessions.withConnection(async (db) => {
      const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
      const rows = await db.query<QueryResultRow>(
        `SELECT s.id,s.tournament_id,s.title,s.body_text,s.published_at,s.updated_at,
                t.name AS tournament_name,t.start_at,t.status AS tournament_status
           FROM ${this.table("tournament_summaries")} s
           INNER JOIN ${this.table("tournaments")} t ON t.id=s.tournament_id
          WHERE t.club_id=? AND s.status='published'
          ORDER BY COALESCE(s.published_at,s.updated_at) DESC,s.id DESC
          LIMIT ${safeLimit}`,
        [clubId],
      );
      return rows.map((row) => normalizeIds(row, ["id", "tournament_id"]));
    });
  }

  async tournamentSummary(tournamentId: string): Promise<Record<string, unknown> | null> {
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT s.id,s.tournament_id,s.title,s.body_text,s.status,s.published_at,s.created_at,s.updated_at,
                t.club_id,t.name AS tournament_name,t.start_at
           FROM ${this.table("tournament_summaries")} s
           INNER JOIN ${this.table("tournaments")} t ON t.id=s.tournament_id
          WHERE s.tournament_id=? AND s.status='published' LIMIT 1`,
        [tournamentId],
      );
      const row = rows[0];
      return row === undefined ? null : normalizeIds(row, ["id", "tournament_id", "club_id"]);
    });
  }

  private async tournamentTablesWithDb(db: SqlExecutor, tournamentId: string): Promise<Record<string, unknown> | null> {
    const tournaments = await db.query<QueryResultRow>(
      `SELECT t.id,t.club_id,t.season_id,t.name,t.status,t.start_at,t.end_at
         FROM ${this.table("tournaments")} t WHERE t.id=? LIMIT 1`,
      [tournamentId],
    );
    const rawTournament = tournaments[0];
    if (rawTournament === undefined) return null;
    const tournament = normalizeIds(rawTournament, ["id", "club_id", "season_id"]);

    const groups = await db.query<QueryResultRow>(
      `SELECT g.id,g.name,g.sort_order FROM ${this.table("tournament_groups")} g
        WHERE g.tournament_id=? ORDER BY g.sort_order ASC`,
      [tournamentId],
    );
    const tables: Record<string, unknown>[] = [];
    for (const group of groups) {
      const groupId = decimalId(group.id);
      if (groupId === null) continue;
      tables.push({
        id: publicId(groupId),
        name: group.name,
        sort_order: integer(group.sort_order),
        rows: await this.groupTableRows(db, tournamentId, groupId),
      });
    }
    if (tables.length === 0) {
      tables.push({ id: null, name: "Turnering", sort_order: 1, rows: await this.ungroupedTableRows(db, tournamentId) });
    }
    return { tournament, groups: tables, tie_break_order: ["leg_difference", "head_to_head", "three_dart_average"] };
  }

  private async listTournamentMatchesWithDb(db: SqlExecutor, tournamentId: string, limit: number): Promise<Record<string, unknown>[]> {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = await db.query<QueryResultRow>(
      `SELECT m.id,m.tournament_id,m.tournament_group_id,g.name AS group_name,
              m.round_label,m.round_number,m.bracket_label,m.status,m.winner_player_id,
              m.starts_at,m.finished_at,m.kiosk_id,k.board_number,
              m.player_a_id,pa.display_name AS player_a_name,
              m.player_b_id,pb.display_name AS player_b_name,
              msa.legs_won AS player_a_legs,msa.average AS player_a_average,
              msb.legs_won AS player_b_legs,msb.average AS player_b_average
         FROM ${this.table("matches")} m
         INNER JOIN ${this.table("players")} pa ON pa.id=m.player_a_id
         INNER JOIN ${this.table("players")} pb ON pb.id=m.player_b_id
         LEFT JOIN ${this.table("tournament_groups")} g ON g.id=m.tournament_group_id
         LEFT JOIN ${this.table("kiosks")} k ON k.id=m.kiosk_id
         LEFT JOIN ${this.table("match_statistics")} msa ON msa.match_id=m.id AND msa.player_id=m.player_a_id
         LEFT JOIN ${this.table("match_statistics")} msb ON msb.match_id=m.id AND msb.player_id=m.player_b_id
        WHERE m.tournament_id=? AND m.status='completed'
        ORDER BY COALESCE(m.round_number,9999) ASC,COALESCE(m.finished_at,m.starts_at,m.created_at) ASC,m.id ASC
        LIMIT ${safeLimit}`,
      [tournamentId],
    );
    return rows.map((raw) => ({
      ...normalizeIds(raw, ["id", "tournament_id", "tournament_group_id", "winner_player_id", "kiosk_id", "player_a_id", "player_b_id"]),
      round_number: raw.round_number === null || raw.round_number === undefined ? null : integer(raw.round_number),
      board_number: raw.board_number === null || raw.board_number === undefined ? null : integer(raw.board_number),
      player_a_legs: raw.player_a_legs === null || raw.player_a_legs === undefined ? null : integer(raw.player_a_legs),
      player_b_legs: raw.player_b_legs === null || raw.player_b_legs === undefined ? null : integer(raw.player_b_legs),
      player_a_average: raw.player_a_average === null || raw.player_a_average === undefined ? null : numberValue(raw.player_a_average),
      player_b_average: raw.player_b_average === null || raw.player_b_average === undefined ? null : numberValue(raw.player_b_average),
    }));
  }

  private async groupTableRows(db: SqlExecutor, tournamentId: string, groupId: string): Promise<Record<string, unknown>[]> {
    const rows = await db.query<QueryResultRow>(
      `SELECT p.id AS player_id,p.display_name,gp.seed_number,
              COUNT(DISTINCT CASE WHEN m.status='completed' THEN m.id END) AS played,
              COUNT(DISTINCT CASE WHEN m.status='completed' AND m.winner_player_id=p.id THEN m.id END) AS wins,
              COUNT(DISTINCT CASE WHEN m.status='completed' AND m.winner_player_id IS NULL THEN m.id END) AS draws,
              COUNT(DISTINCT CASE WHEN m.status='completed' AND m.winner_player_id IS NOT NULL AND m.winner_player_id<>p.id THEN m.id END) AS losses,
              COUNT(DISTINCT CASE WHEN l.winner_player_id=p.id THEN l.id END) AS legs_won,
              COUNT(DISTINCT CASE WHEN l.winner_player_id IS NOT NULL AND l.winner_player_id<>p.id THEN l.id END) AS legs_lost,
              COALESCE((SELECT ROUND(COALESCE(
                SUM(ms.average*COALESCE(ms.darts_thrown,0))/NULLIF(SUM(COALESCE(ms.darts_thrown,0)),0),AVG(ms.average)
              ),2) FROM ${this.table("match_statistics")} ms
                INNER JOIN ${this.table("matches")} sm ON sm.id=ms.match_id
               WHERE ms.player_id=p.id AND sm.tournament_id=? AND sm.tournament_group_id=? AND sm.status='completed' AND ms.average IS NOT NULL),0) AS three_dart_average
         FROM ${this.table("tournament_group_players")} gp
         INNER JOIN ${this.table("tournament_players")} tp ON tp.id=gp.tournament_player_id
         INNER JOIN ${this.table("players")} p ON p.id=tp.player_id
         LEFT JOIN ${this.table("matches")} m ON m.tournament_id=? AND m.tournament_group_id=? AND (m.player_a_id=p.id OR m.player_b_id=p.id)
         LEFT JOIN ${this.table("legs")} l ON l.match_id=m.id
        WHERE gp.group_id=?
        GROUP BY p.id,p.display_name,gp.seed_number`,
      [tournamentId, groupId, tournamentId, groupId, groupId],
    );
    return this.normalizeTableRows(db, rows, tournamentId, groupId);
  }

  private async ungroupedTableRows(db: SqlExecutor, tournamentId: string): Promise<Record<string, unknown>[]> {
    const rows = await db.query<QueryResultRow>(
      `SELECT p.id AS player_id,p.display_name,tp.seed AS seed_number,
              COUNT(DISTINCT CASE WHEN m.status='completed' THEN m.id END) AS played,
              COUNT(DISTINCT CASE WHEN m.status='completed' AND m.winner_player_id=p.id THEN m.id END) AS wins,
              COUNT(DISTINCT CASE WHEN m.status='completed' AND m.winner_player_id IS NULL THEN m.id END) AS draws,
              COUNT(DISTINCT CASE WHEN m.status='completed' AND m.winner_player_id IS NOT NULL AND m.winner_player_id<>p.id THEN m.id END) AS losses,
              COUNT(DISTINCT CASE WHEN l.winner_player_id=p.id THEN l.id END) AS legs_won,
              COUNT(DISTINCT CASE WHEN l.winner_player_id IS NOT NULL AND l.winner_player_id<>p.id THEN l.id END) AS legs_lost,
              COALESCE((SELECT ROUND(COALESCE(
                SUM(ms.average*COALESCE(ms.darts_thrown,0))/NULLIF(SUM(COALESCE(ms.darts_thrown,0)),0),AVG(ms.average)
              ),2) FROM ${this.table("match_statistics")} ms
                INNER JOIN ${this.table("matches")} sm ON sm.id=ms.match_id
               WHERE ms.player_id=p.id AND sm.tournament_id=? AND sm.status='completed' AND ms.average IS NOT NULL),0) AS three_dart_average
         FROM ${this.table("tournament_players")} tp
         INNER JOIN ${this.table("players")} p ON p.id=tp.player_id
         LEFT JOIN ${this.table("matches")} m ON m.tournament_id=tp.tournament_id AND (m.player_a_id=p.id OR m.player_b_id=p.id)
         LEFT JOIN ${this.table("legs")} l ON l.match_id=m.id
        WHERE tp.tournament_id=? AND tp.status IN ('registered','checked_in','eliminated')
        GROUP BY p.id,p.display_name,tp.seed`,
      [tournamentId, tournamentId],
    );
    return this.normalizeTableRows(db, rows, tournamentId, null);
  }

  private async normalizeTableRows(db: SqlExecutor, rows: readonly QueryResultRow[], tournamentId: string, groupId: string | null): Promise<Record<string, unknown>[]> {
    const normalized: TableRow[] = rows.map((raw) => {
      const playerId = decimalId(raw.player_id);
      if (playerId === null) throw new TypeError("Tournament table row has invalid player id.");
      const wins = integer(raw.wins);
      const draws = integer(raw.draws);
      const legsWon = integer(raw.legs_won);
      const legsLost = integer(raw.legs_lost);
      return {
        ...raw,
        _player_id: playerId,
        player_id: publicId(playerId),
        display_name: String(raw.display_name ?? ""),
        seed_number: raw.seed_number === null || raw.seed_number === undefined ? null : integer(raw.seed_number),
        played: integer(raw.played),
        wins,
        draws,
        losses: integer(raw.losses),
        legs_won: legsWon,
        legs_lost: legsLost,
        three_dart_average: round(numberValue(raw.three_dart_average), 2),
        points: (wins * 2) + draws,
        leg_diff: legsWon - legsLost,
        head_to_head_points: 0,
      };
    });
    normalized.sort((a, b) => compareDesc(a.points, b.points) || compareDesc(a.leg_diff, b.leg_diff) || compareName(a.display_name, b.display_name));

    const ranked: TableRow[] = [];
    for (let index = 0; index < normalized.length;) {
      const first = normalized[index]!;
      const bucket = [first];
      let cursor = index + 1;
      while (cursor < normalized.length && normalized[cursor]!.points === first.points && normalized[cursor]!.leg_diff === first.leg_diff) {
        bucket.push(normalized[cursor]!);
        cursor += 1;
      }
      if (bucket.length > 1) {
        const h2h = await this.headToHeadPoints(db, tournamentId, bucket.map((row) => row._player_id), groupId);
        for (const row of bucket) row.head_to_head_points = h2h.get(row._player_id) ?? 0;
        bucket.sort((a, b) => compareDesc(a.head_to_head_points, b.head_to_head_points)
          || compareDesc(a.three_dart_average, b.three_dart_average)
          || compareName(a.display_name, b.display_name));
      }
      ranked.push(...bucket);
      index = cursor;
    }
    return ranked.map((row, index) => {
      const result: Record<string, unknown> = { ...row, position: index + 1 };
      delete result._player_id;
      return result;
    });
  }

  private async headToHeadPoints(db: SqlExecutor, tournamentId: string, playerIds: string[], groupId: string | null): Promise<Map<string, number>> {
    const ids = [...new Set(playerIds.filter((id) => /^[1-9][0-9]*$/.test(id)))];
    if (ids.length < 2) return new Map();
    const placeholders = ids.map(() => "?").join(",");
    const groupClause = groupId === null ? "" : " AND m.tournament_group_id=?";
    const params: unknown[] = [tournamentId];
    if (groupId !== null) params.push(groupId);
    params.push(...ids, ...ids);
    const rows = await db.query<QueryResultRow>(
      `SELECT m.player_a_id,m.player_b_id,m.winner_player_id
         FROM ${this.table("matches")} m
        WHERE m.tournament_id=? AND m.status='completed'${groupClause}
          AND m.player_a_id IN (${placeholders}) AND m.player_b_id IN (${placeholders})`,
      params,
    );
    const points = new Map(ids.map((id) => [id, 0]));
    for (const row of rows) {
      const a = decimalId(row.player_a_id);
      const b = decimalId(row.player_b_id);
      const winner = decimalId(row.winner_player_id);
      if (a === null || b === null) continue;
      if (winner === null) {
        points.set(a, (points.get(a) ?? 0) + 1);
        points.set(b, (points.get(b) ?? 0) + 1);
      } else {
        points.set(winner, (points.get(winner) ?? 0) + 2);
      }
    }
    return points;
  }

  private table(name: string): string {
    if (!/^[a-z0-9_]+$/i.test(name)) throw new TypeError("Invalid table name.");
    return `\`${this.runtimePrefix}${name}\``;
  }
}

function normalizeIds(row: QueryResultRow, fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = { ...row };
  for (const field of fields) {
    const value = decimalId(row[field]);
    result[field] = value === null ? null : publicId(value);
  }
  return result;
}

function decimalId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}

function publicId(value: string): number | string {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

function integer(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function compareDesc(a: number, b: number): number {
  return b < a ? -1 : b > a ? 1 : 0;
}

function compareName(a: string, b: string): number {
  return a.toLocaleLowerCase("nb-NO").localeCompare(b.toLocaleLowerCase("nb-NO"), "nb-NO");
}
