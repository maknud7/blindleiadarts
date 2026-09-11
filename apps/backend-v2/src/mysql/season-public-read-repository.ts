import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

interface SeasonRow extends QueryResultRow {
  readonly id?: unknown;
  readonly club_id?: unknown;
  readonly name?: unknown;
  readonly starts_on?: unknown;
  readonly ends_on?: unknown;
  readonly is_active?: unknown;
  readonly status?: unknown;
  readonly ranking_method?: unknown;
  readonly points_win?: unknown;
  readonly points_draw?: unknown;
  readonly points_loss?: unknown;
  readonly champion_player_id?: unknown;
  readonly champion_name?: unknown;
  readonly completed_at?: unknown;
  readonly tournament_count?: unknown;
  readonly completed_tournament_count?: unknown;
}

type Standing = Record<string, unknown> & {
  _player_id: string;
  display_name: string;
  points: number;
  elo_rating: number;
  leg_diff: number;
  three_dart_average: number;
  head_to_head_points: number;
};

export class MySqlSeasonPublicReadRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
  ) {}

  async listByClub(clubId: string): Promise<Record<string, unknown>[]> {
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<SeasonRow>(
        `SELECT s.id,s.club_id,s.name,s.starts_on,s.ends_on,s.is_active,s.status,s.ranking_method,
                s.points_win,s.points_draw,s.points_loss,s.champion_player_id,s.completed_at,
                p.display_name AS champion_name,
                COUNT(DISTINCT t.id) AS tournament_count,
                COUNT(DISTINCT CASE WHEN t.status='completed' THEN t.id END) AS completed_tournament_count
           FROM ${this.table("seasons")} s
           LEFT JOIN ${this.table("players")} p ON p.id=s.champion_player_id
           LEFT JOIN ${this.table("tournaments")} t ON t.season_id=s.id
          WHERE s.club_id=?
          GROUP BY s.id,s.club_id,s.name,s.starts_on,s.ends_on,s.is_active,s.status,s.ranking_method,
                   s.points_win,s.points_draw,s.points_loss,s.champion_player_id,s.completed_at,p.display_name
          ORDER BY s.is_active DESC, COALESCE(s.starts_on,'0000-01-01') DESC, s.id DESC`,
        [clubId],
      );
      return rows.map((row) => formatSeason(row));
    });
  }

  async find(seasonId: string): Promise<Record<string, unknown> | null> {
    return this.sessions.withConnection(async (db) => {
      const row = await this.findWithDb(db, seasonId);
      return row === null ? null : formatSeason(row);
    });
  }

  async standings(seasonId: string): Promise<{ season: Record<string, unknown>; items: Record<string, unknown>[] } | null> {
    return this.sessions.withConnection(async (db) => {
      const rawSeason = await this.findWithDb(db, seasonId);
      if (rawSeason === null) return null;
      const season = formatSeason(rawSeason);

      const rows = await db.query<QueryResultRow>(
        `SELECT p.id,p.display_name,p.nickname,
                COUNT(DISTINCT t.id) AS tournaments,
                COUNT(DISTINCT m.id) AS matches_played,
                COUNT(DISTINCT CASE WHEN m.winner_player_id=p.id THEN m.id END) AS wins,
                COUNT(DISTINCT CASE WHEN m.id IS NOT NULL AND m.winner_player_id IS NULL THEN m.id END) AS draws,
                COUNT(DISTINCT CASE WHEN m.winner_player_id IS NOT NULL AND m.winner_player_id<>p.id THEN m.id END) AS losses,
                (SELECT COUNT(*) FROM ${this.table("legs")} lw
                  INNER JOIN ${this.table("matches")} mw ON mw.id=lw.match_id
                  INNER JOIN ${this.table("tournaments")} tw ON tw.id=mw.tournament_id
                  WHERE tw.season_id=? AND lw.status='completed' AND lw.winner_player_id=p.id) AS legs_won,
                (SELECT COUNT(*) FROM ${this.table("legs")} ll
                  INNER JOIN ${this.table("matches")} ml ON ml.id=ll.match_id
                  INNER JOIN ${this.table("tournaments")} tl ON tl.id=ml.tournament_id
                  WHERE tl.season_id=? AND ll.status='completed' AND ll.winner_player_id IS NOT NULL
                    AND ll.winner_player_id<>p.id AND (ml.player_a_id=p.id OR ml.player_b_id=p.id)) AS legs_lost,
                COALESCE((SELECT ROUND(COALESCE(
                    SUM(ms.average * COALESCE(ms.darts_thrown,0)) / NULLIF(SUM(COALESCE(ms.darts_thrown,0)),0),
                    AVG(ms.average)
                  ),2)
                  FROM ${this.table("match_statistics")} ms
                  INNER JOIN ${this.table("matches")} sm ON sm.id=ms.match_id
                  INNER JOIN ${this.table("tournaments")} st ON st.id=sm.tournament_id
                  WHERE st.season_id=? AND sm.status='completed' AND ms.player_id=p.id AND ms.average IS NOT NULL),0) AS three_dart_average,
                e.rating AS elo_rating,e.matches_played AS elo_matches_played
           FROM ${this.table("players")} p
           INNER JOIN ${this.table("tournament_players")} tp ON tp.player_id=p.id AND tp.status<>'withdrawn'
           INNER JOIN ${this.table("tournaments")} t ON t.id=tp.tournament_id AND t.season_id=?
           LEFT JOIN ${this.table("matches")} m ON m.tournament_id=t.id AND m.status='completed'
             AND (m.player_a_id=p.id OR m.player_b_id=p.id)
           LEFT JOIN ${this.table("elo_current_ratings")} e ON e.player_id=p.id AND e.season_id=?
          GROUP BY p.id,p.display_name,p.nickname,e.rating,e.matches_played`,
        [seasonId, seasonId, seasonId, seasonId, seasonId],
      );

      const rankingMethod = String(season.ranking_method ?? "match_points");
      const linearPoints = rankingMethod === "linear" ? await this.linearPoints(db, seasonId) : new Map<string, number>();
      const winPoints = numberValue(season.points_win);
      const drawPoints = numberValue(season.points_draw);
      const lossPoints = numberValue(season.points_loss);

      const standings: Standing[] = rows.map((row) => {
        const playerId = decimalId(row.id);
        if (playerId === null) throw new TypeError("Season standing contains an invalid player id.");
        const wins = integer(row.wins);
        const draws = integer(row.draws);
        const losses = integer(row.losses);
        const legsWon = integer(row.legs_won);
        const legsLost = integer(row.legs_lost);
        return {
          ...row,
          _player_id: playerId,
          id: publicId(playerId),
          display_name: String(row.display_name ?? ""),
          tournaments: integer(row.tournaments),
          matches_played: integer(row.matches_played),
          wins,
          draws,
          losses,
          legs_won: legsWon,
          legs_lost: legsLost,
          elo_matches_played: integer(row.elo_matches_played),
          leg_diff: legsWon - legsLost,
          three_dart_average: round(numberValue(row.three_dart_average), 2),
          points: rankingMethod === "linear"
            ? round(linearPoints.get(playerId) ?? 0, 2)
            : round((wins * winPoints) + (draws * drawPoints) + (losses * lossPoints), 2),
          elo_rating: row.elo_rating === null || row.elo_rating === undefined ? 1000 : numberValue(row.elo_rating, 1000),
          head_to_head_points: 0,
        };
      });

      const ranked = await this.sortWithTieBreak(db, standings, seasonId, rankingMethod);
      const items = ranked.map((row, index) => {
        const result: Record<string, unknown> = { ...row, position: index + 1 };
        delete result._player_id;
        return result;
      });
      return { season, items };
    });
  }

  private async findWithDb(db: SqlExecutor, seasonId: string): Promise<SeasonRow | null> {
    const rows = await db.query<SeasonRow>(
      `SELECT s.*,p.display_name AS champion_name,
              (SELECT COUNT(*) FROM ${this.table("tournaments")} t WHERE t.season_id=s.id) AS tournament_count,
              (SELECT COUNT(*) FROM ${this.table("tournaments")} t WHERE t.season_id=s.id AND t.status='completed') AS completed_tournament_count
         FROM ${this.table("seasons")} s
         LEFT JOIN ${this.table("players")} p ON p.id=s.champion_player_id
        WHERE s.id=? LIMIT 1`,
      [seasonId],
    );
    return rows[0] ?? null;
  }

  private async linearPoints(db: SqlExecutor, seasonId: string): Promise<Map<string, number>> {
    const rows = await db.query<QueryResultRow>(
      `SELECT player_id,SUM(points) AS points
         FROM ${this.table("season_ranking_events")}
        WHERE season_id=? AND ruleset='linear_v1' AND status='applied'
        GROUP BY player_id`,
      [seasonId],
    );
    const points = new Map<string, number>();
    for (const row of rows) {
      const playerId = decimalId(row.player_id);
      if (playerId !== null) points.set(playerId, numberValue(row.points));
    }
    return points;
  }

  private async sortWithTieBreak(
    db: SqlExecutor,
    rows: Standing[],
    seasonId: string,
    method: string,
  ): Promise<Standing[]> {
    const primary = (row: Standing): number => method === "elo" ? row.elo_rating : row.points;
    rows.sort((a, b) => {
      const byPrimary = compareNumberDesc(primary(a), primary(b));
      if (byPrimary !== 0) return byPrimary;
      const byLegs = compareNumberDesc(a.leg_diff, b.leg_diff);
      if (byLegs !== 0) return byLegs;
      const byAverage = compareNumberDesc(a.three_dart_average, b.three_dart_average);
      return byAverage !== 0 ? byAverage : compareName(a.display_name, b.display_name);
    });

    const ranked: Standing[] = [];
    for (let index = 0; index < rows.length;) {
      const first = rows[index];
      if (first === undefined) break;
      const bucket = [first];
      let cursor = index + 1;
      while (cursor < rows.length) {
        const candidate = rows[cursor];
        if (
          candidate === undefined ||
          Math.abs(primary(candidate) - primary(first)) >= 0.0001 ||
          candidate.leg_diff !== first.leg_diff ||
          Math.abs(candidate.three_dart_average - first.three_dart_average) >= 0.0001
        ) break;
        bucket.push(candidate);
        cursor += 1;
      }

      if (bucket.length > 1) {
        const points = await this.headToHeadPoints(db, seasonId, bucket.map((row) => row._player_id));
        for (const row of bucket) row.head_to_head_points = points.get(row._player_id) ?? 0;
        bucket.sort((a, b) => {
          const byHeadToHead = compareNumberDesc(a.head_to_head_points, b.head_to_head_points);
          return byHeadToHead !== 0 ? byHeadToHead : compareName(a.display_name, b.display_name);
        });
      }
      ranked.push(...bucket);
      index = cursor;
    }
    return ranked;
  }

  private async headToHeadPoints(db: SqlExecutor, seasonId: string, playerIds: string[]): Promise<Map<string, number>> {
    const uniqueIds = [...new Set(playerIds.filter((id) => /^[1-9][0-9]*$/.test(id)))];
    if (uniqueIds.length < 2) return new Map();
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = await db.query<QueryResultRow>(
      `SELECT m.player_a_id,m.player_b_id,m.winner_player_id
         FROM ${this.table("matches")} m
         INNER JOIN ${this.table("tournaments")} t ON t.id=m.tournament_id
        WHERE t.season_id=? AND m.status='completed'
          AND m.player_a_id IN (${placeholders}) AND m.player_b_id IN (${placeholders})`,
      [seasonId, ...uniqueIds, ...uniqueIds],
    );
    const points = new Map(uniqueIds.map((id) => [id, 0]));
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
    if (!/^[a-z0-9_]+$/.test(name)) throw new TypeError("Invalid table name.");
    return `\`${this.runtimePrefix}${name}\``;
  }
}

function formatSeason(row: SeasonRow): Record<string, unknown> {
  return {
    ...row,
    id: publicId(decimalId(row.id)),
    club_id: publicId(decimalId(row.club_id)),
    champion_player_id: publicId(decimalId(row.champion_player_id)),
    tournament_count: integer(row.tournament_count),
    completed_tournament_count: integer(row.completed_tournament_count),
    is_active: integer(row.is_active) === 1,
    points_win: numberValue(row.points_win),
    points_draw: numberValue(row.points_draw),
    points_loss: numberValue(row.points_loss),
  };
}

function decimalId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}

function publicId(value: string | null): number | string | null {
  if (value === null) return null;
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

function compareNumberDesc(a: number, b: number): number {
  return b < a ? -1 : b > a ? 1 : 0;
}

function compareName(a: string, b: string): number {
  return a.toLocaleLowerCase("nb-NO").localeCompare(b.toLocaleLowerCase("nb-NO"), "nb-NO");
}
