import type { IdentityUser } from "./identity-auth-repository.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

interface PlayerRow extends QueryResultRow {
  readonly id?: unknown;
  readonly club_id?: unknown;
  readonly member_id?: unknown;
  readonly display_name?: unknown;
  readonly nickname?: unknown;
  readonly avatar_url?: unknown;
  readonly is_active?: unknown;
  readonly club_name?: unknown;
}

export class MySqlPlayerLiveReadRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
  ) {}

  async memberDashboard(user: IdentityUser): Promise<Record<string, unknown>> {
    return this.sessions.withConnection(async (db) => {
      const playerId = decimalId(user.player_id);
      const dashboardUser = {
        id: publicId(decimalId(user.id)),
        username: user.email ?? "",
        display_name: user.display_name,
        role: user.role,
        player_id: publicId(playerId),
        player_display_name: user.player_display_name,
        club_id: publicId(decimalId(user.player_club_id)),
      };

      if (playerId === null) {
        return { user: dashboardUser, registrations: [], stats: [] };
      }

      const registrations = await db.query<QueryResultRow>(
        `SELECT tp.tournament_id,tp.status,tp.seed,tp.created_at,
                t.name AS tournament_name,t.status AS tournament_status,
                c.id AS club_id,c.name AS club_name
           FROM ${this.table("tournament_players")} tp
           INNER JOIN ${this.table("tournaments")} t ON t.id=tp.tournament_id
           INNER JOIN ${this.table("clubs")} c ON c.id=t.club_id
          WHERE tp.player_id=?
          ORDER BY tp.created_at DESC`,
        [playerId],
      );

      const matchRows = await db.query<QueryResultRow>(
        `SELECT COUNT(*) AS matches_played,
                COUNT(CASE WHEN winner_player_id=? THEN 1 END) AS matches_won
           FROM ${this.table("matches")}
          WHERE player_a_id=? OR player_b_id=?`,
        [playerId, playerId, playerId],
      );
      const legRows = await db.query<QueryResultRow>(
        `SELECT COUNT(*) AS legs_won FROM ${this.table("legs")} WHERE winner_player_id=?`,
        [playerId],
      );
      const visitRows = await db.query<QueryResultRow>(
        `SELECT COUNT(*) AS visits_logged,COALESCE(AVG(score),0) AS average_visit_score
           FROM ${this.table("visits")} WHERE player_id=?`,
        [playerId],
      );
      const rankings = await db.query<QueryResultRow>(
        `SELECT ranking_type,scope_type,points,position,calculated_at
           FROM ${this.table("ranking_snapshots")}
          WHERE player_id=?
          ORDER BY calculated_at DESC,id DESC
          LIMIT 8`,
        [playerId],
      );

      const stats = {
        ...(matchRows[0] ?? {}),
        legs_won: legRows[0]?.legs_won ?? 0,
        visits_logged: visitRows[0]?.visits_logged ?? 0,
        average_visit_score: visitRows[0]?.average_visit_score ?? 0,
        rankings,
      };
      return { user: dashboardUser, registrations, stats };
    });
  }

  async playerProfile(playerId: string): Promise<Record<string, unknown> | null> {
    return this.sessions.withConnection(async (db) => {
      const playerRows = await db.query<PlayerRow>(
        `SELECT p.id,p.club_id,p.member_id,c.name AS club_name,p.display_name,p.nickname,p.avatar_url,p.is_active
           FROM ${this.table("players")} p
           LEFT JOIN ${this.table("clubs")} c ON c.id=p.club_id
          WHERE p.id=? LIMIT 1`,
        [playerId],
      );
      const player = playerRows[0];
      if (player === undefined) return null;

      const aliases = await this.aliasIds(db, player);
      const inList = aliases.join(",");
      const statsRows = await db.query<QueryResultRow>(
        `SELECT
           COUNT(DISTINCT CASE WHEN m.status='completed' THEN m.id END) AS matches_played,
           COUNT(DISTINCT CASE WHEN m.status='completed' AND m.winner_player_id IN (${inList}) THEN m.id END) AS matches_won,
           COUNT(DISTINCT CASE WHEN m.status='completed' AND m.winner_player_id IS NULL THEN m.id END) AS draws,
           (SELECT COUNT(*) FROM ${this.table("legs")} l INNER JOIN ${this.table("matches")} lm ON lm.id=l.match_id WHERE l.winner_player_id IN (${inList})) AS legs_won,
           (SELECT COUNT(*) FROM ${this.table("visits")} v WHERE v.player_id IN (${inList})) AS visits_logged,
           (SELECT COALESCE(ROUND(AVG(CASE WHEN v.is_bust=0 THEN v.score ELSE 0 END),2),0) FROM ${this.table("visits")} v WHERE v.player_id IN (${inList})) AS visit_average,
           (SELECT COALESCE(ROUND(SUM(CASE WHEN v.is_bust=0 THEN v.score ELSE 0 END)*3/NULLIF(SUM(v.darts_used),0),2),0) FROM ${this.table("visits")} v WHERE v.player_id IN (${inList})) AS visit_three_dart_average,
           (SELECT COALESCE(MAX(CASE WHEN v.is_bust=0 THEN v.score ELSE 0 END),0) FROM ${this.table("visits")} v WHERE v.player_id IN (${inList})) AS highest_visit,
           (SELECT COUNT(*) FROM ${this.table("visits")} v WHERE v.player_id IN (${inList}) AND v.score=180 AND v.is_bust=0) AS visits_180,
           (SELECT COUNT(*) FROM ${this.table("visits")} v WHERE v.player_id IN (${inList}) AND v.score>=140 AND v.score<180 AND v.is_bust=0) AS visits_140_plus,
           (SELECT COUNT(*) FROM ${this.table("visits")} v WHERE v.player_id IN (${inList}) AND v.score>=100 AND v.score<140 AND v.is_bust=0) AS visits_100_plus,
           (SELECT COALESCE(MAX(ms.highest_checkout),0) FROM ${this.table("match_statistics")} ms WHERE ms.player_id IN (${inList})) AS highest_checkout,
           (SELECT COALESCE(SUM(ms.checkout_hits),0) FROM ${this.table("match_statistics")} ms WHERE ms.player_id IN (${inList})) AS checkout_hits,
           (SELECT COALESCE(SUM(ms.checkout_attempts),0) FROM ${this.table("match_statistics")} ms WHERE ms.player_id IN (${inList})) AS checkout_attempts,
           (SELECT COALESCE(ROUND(COALESCE(SUM(ms.average*COALESCE(ms.darts_thrown,0))/NULLIF(SUM(COALESCE(ms.darts_thrown,0)),0),AVG(ms.average)),2),0)
              FROM ${this.table("match_statistics")} ms WHERE ms.player_id IN (${inList}) AND ms.average IS NOT NULL) AS recorded_average
         FROM ${this.table("matches")} m
         WHERE m.player_a_id IN (${inList}) OR m.player_b_id IN (${inList})`,
      );
      const rawStats = statsRows[0] ?? {};
      const played = integer(rawStats.matches_played);
      const won = integer(rawStats.matches_won);
      const draws = integer(rawStats.draws);
      const attempts = integer(rawStats.checkout_attempts);
      const hits = integer(rawStats.checkout_hits);
      const visitThreeDart = numberValue(rawStats.visit_three_dart_average);
      const recordedAverage = numberValue(rawStats.recorded_average);
      const stats = {
        ...rawStats,
        matches_played: played,
        matches_won: won,
        draws,
        matches_lost: Math.max(0, played - won - draws),
        win_percentage: played > 0 ? round((won / played) * 100, 1) : 0,
        checkout_percentage: attempts > 0 ? round((hits / attempts) * 100, 1) : null,
        three_dart_average: visitThreeDart > 0 ? visitThreeDart : recordedAverage,
      };

      const eloRows = await db.query<QueryResultRow>(
        `SELECT points,calculated_at FROM ${this.table("ranking_snapshots")}
          WHERE player_id IN (${inList}) AND ranking_type='elo'
          ORDER BY calculated_at DESC,id DESC LIMIT 1`,
      );
      const eloRow = eloRows[0];
      const elo = eloRow
        ? { rating: numberValue(eloRow.points, 1000), source: "ranking_snapshot", calculated_at: eloRow.calculated_at ?? null, baseline_played: null }
        : { rating: 1000, source: "default_1000", calculated_at: null, baseline_played: 0 };

      const recentMatches = await db.query<QueryResultRow>(
        `SELECT m.id,m.tournament_id,t.name AS tournament_name,t.start_at,m.round_label,m.bracket_label,m.status,m.winner_player_id,m.finished_at,
                m.player_a_id,pa.display_name AS player_a_name,m.player_b_id,pb.display_name AS player_b_name,
                (SELECT ms.average FROM ${this.table("match_statistics")} ms WHERE ms.match_id=m.id AND ms.player_id IN (${inList}) ORDER BY ms.id ASC LIMIT 1) AS average,
                (SELECT ms.highest_checkout FROM ${this.table("match_statistics")} ms WHERE ms.match_id=m.id AND ms.player_id IN (${inList}) ORDER BY ms.id ASC LIMIT 1) AS highest_checkout,
                (SELECT ms.score_180 FROM ${this.table("match_statistics")} ms WHERE ms.match_id=m.id AND ms.player_id IN (${inList}) ORDER BY ms.id ASC LIMIT 1) AS score_180
           FROM ${this.table("matches")} m
           INNER JOIN ${this.table("tournaments")} t ON t.id=m.tournament_id
           INNER JOIN ${this.table("players")} pa ON pa.id=m.player_a_id
           INNER JOIN ${this.table("players")} pb ON pb.id=m.player_b_id
          WHERE (m.player_a_id IN (${inList}) OR m.player_b_id IN (${inList})) AND m.status='completed'
          ORDER BY COALESCE(m.finished_at,t.start_at,m.created_at) DESC,m.id DESC LIMIT 12`,
      );
      const aliasSet = new Set(aliases);
      const normalizedMatches = recentMatches.map((row) => {
        const a = decimalId(row.player_a_id);
        const winner = decimalId(row.winner_player_id);
        return {
          ...row,
          opponent_name: a !== null && aliasSet.has(a) ? row.player_b_name : row.player_a_name,
          result: winner === null ? "draw" : aliasSet.has(winner) ? "win" : "loss",
          average: row.average === null || row.average === undefined ? null : numberValue(row.average),
        };
      });
      const eloHistory = await db.query<QueryResultRow>(
        `SELECT rs.id,rs.points AS rating,rs.position,rs.scope_type,rs.tournament_id,t.name AS tournament_name,rs.calculated_at
           FROM ${this.table("ranking_snapshots")} rs
           LEFT JOIN ${this.table("tournaments")} t ON t.id=rs.tournament_id
          WHERE rs.player_id IN (${inList}) AND rs.ranking_type='elo'
          ORDER BY rs.calculated_at DESC,rs.id DESC LIMIT 20`,
      );

      return {
        player: {
          ...player,
          alias_player_ids: aliases.map(publicId),
          has_merged_aliases: aliases.length > 1,
        },
        elo,
        stats,
        recent_matches: normalizedMatches,
        elo_history: eloHistory,
      };
    });
  }

  async playerTournamentElo(playerId: string): Promise<Record<string, unknown> | null> {
    return this.sessions.withConnection(async (db) => {
      const playerRows = await db.query<PlayerRow>(
        `SELECT id,club_id,member_id,display_name FROM ${this.table("players")} WHERE id=? LIMIT 1`,
        [playerId],
      );
      const player = playerRows[0];
      if (player === undefined) return null;
      const aliases = await this.aliasIds(db, player);
      const inList = aliases.join(",");
      const rows = await db.query<QueryResultRow>(
        `SELECT s.tournament_id,s.season_id,s.player_id,s.elo_before,s.elo_after,s.matches_before,s.matches_after,
                s.captured_start_at,s.captured_end_at,t.name AS tournament_name,t.status AS tournament_status,t.start_at,t.end_at
           FROM ${this.table("tournament_elo_snapshots")} s
           INNER JOIN ${this.table("tournaments")} t ON t.id=s.tournament_id
          WHERE s.player_id IN (${inList})
          ORDER BY COALESCE(t.start_at,s.captured_start_at) ASC,t.id ASC,s.player_id ASC`,
      );

      const grouped = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        const tournamentId = decimalId(row.tournament_id);
        if (tournamentId === null) continue;
        const before = numberValue(row.elo_before, 1000);
        const after = nullableNumber(row.elo_after);
        const matchesBefore = integer(row.matches_before);
        const matchesAfter = row.matches_after === null || row.matches_after === undefined ? null : integer(row.matches_after);
        const existing = grouped.get(tournamentId);
        if (existing === undefined) {
          grouped.set(tournamentId, {
            tournament_id: publicId(tournamentId),
            season_id: publicId(decimalId(row.season_id)),
            tournament_name: String(row.tournament_name ?? ""),
            tournament_status: String(row.tournament_status ?? ""),
            start_at: row.start_at ?? row.captured_start_at ?? null,
            end_at: row.end_at ?? row.captured_end_at ?? null,
            rating_before: before,
            rating_after: after,
            matches_before: matchesBefore,
            matches_after: matchesAfter,
            _first_matches: matchesBefore,
            _last_matches: matchesAfter ?? matchesBefore,
          });
          continue;
        }
        if (matchesBefore < integer(existing._first_matches)) {
          existing._first_matches = matchesBefore;
          existing.matches_before = matchesBefore;
          existing.rating_before = before;
        }
        if (matchesAfter !== null && matchesAfter >= integer(existing._last_matches)) {
          existing._last_matches = matchesAfter;
          existing.matches_after = matchesAfter;
          existing.rating_after = after;
        }
      }

      const items = [...grouped.values()].sort((a, b) => {
        const byDate = String(a.start_at ?? "").localeCompare(String(b.start_at ?? ""));
        if (byDate !== 0) return byDate;
        return compareDecimalIds(String(a.tournament_id ?? "0"), String(b.tournament_id ?? "0"));
      }).map((item) => {
        const before = numberValue(item.rating_before, 1000);
        const after = nullableNumber(item.rating_after);
        const matchesBefore = integer(item.matches_before);
        const matchesAfter = item.matches_after === null || item.matches_after === undefined ? null : integer(item.matches_after);
        const result = { ...item };
        delete result._first_matches;
        delete result._last_matches;
        return {
          ...result,
          delta: after === null ? null : after - before,
          tournament_matches: matchesAfter === null ? null : Math.max(0, matchesAfter - matchesBefore),
          completed: after !== null,
        };
      });

      return {
        player_id: publicId(playerId),
        alias_player_ids: aliases.map(publicId),
        items,
      };
    });
  }

  async liveHighlights(tournamentId: string): Promise<Record<string, unknown> | null> {
    return this.sessions.withConnection(async (db) => {
      const tournamentRows = await db.query<QueryResultRow>(
        `SELECT id,name,status FROM ${this.table("tournaments")} WHERE id=? LIMIT 1`,
        [tournamentId],
      );
      const tournament = tournamentRows[0];
      if (tournament === undefined) return null;

      const standingsRaw = await db.query<QueryResultRow>(
        `SELECT p.id AS player_id,p.display_name,
                COUNT(DISTINCT CASE WHEN m.status='completed' THEN m.id END) AS played,
                COUNT(DISTINCT CASE WHEN m.status='completed' AND m.winner_player_id=p.id THEN m.id END) AS wins,
                COUNT(DISTINCT CASE WHEN m.status='completed' AND m.winner_player_id IS NULL THEN m.id END) AS draws,
                COUNT(DISTINCT CASE WHEN m.status='completed' AND m.winner_player_id IS NOT NULL AND m.winner_player_id<>p.id THEN m.id END) AS losses,
                COUNT(DISTINCT CASE WHEN l.winner_player_id=p.id THEN l.id END) AS legs_won,
                COUNT(DISTINCT CASE WHEN l.winner_player_id IS NOT NULL AND l.winner_player_id<>p.id THEN l.id END) AS legs_lost,
                COALESCE((SELECT ROUND(COALESCE(SUM(ms.average*COALESCE(ms.darts_thrown,0))/NULLIF(SUM(COALESCE(ms.darts_thrown,0)),0),AVG(ms.average)),2)
                  FROM ${this.table("match_statistics")} ms INNER JOIN ${this.table("matches")} sm ON sm.id=ms.match_id
                  WHERE sm.tournament_id=? AND sm.status='completed' AND ms.player_id=p.id AND ms.average IS NOT NULL),0) AS three_dart_average
           FROM ${this.table("tournament_players")} tp
           INNER JOIN ${this.table("players")} p ON p.id=tp.player_id
           LEFT JOIN ${this.table("matches")} m ON m.tournament_id=tp.tournament_id AND (m.player_a_id=p.id OR m.player_b_id=p.id)
           LEFT JOIN ${this.table("legs")} l ON l.match_id=m.id
          WHERE tp.tournament_id=? AND tp.status NOT IN ('withdrawn','no_show')
          GROUP BY p.id,p.display_name`,
        [tournamentId, tournamentId],
      );
      const standings = standingsRaw.map((row) => {
        const played = integer(row.played);
        const wins = integer(row.wins);
        const draws = integer(row.draws);
        const legsWon = integer(row.legs_won);
        const legsLost = integer(row.legs_lost);
        return {
          ...row,
          player_id: publicId(decimalId(row.player_id)),
          display_name: String(row.display_name ?? ""),
          played,
          wins,
          draws,
          losses: integer(row.losses),
          legs_won: legsWon,
          legs_lost: legsLost,
          three_dart_average: round(numberValue(row.three_dart_average), 2),
          points: wins * 2 + draws,
          leg_diff: legsWon - legsLost,
        };
      }).filter((row) => row.played > 0).sort((a, b) =>
        b.points - a.points || b.leg_diff - a.leg_diff || b.three_dart_average - a.three_dart_average || a.display_name.localeCompare(b.display_name),
      ).slice(0, 8).map((row, index) => ({ ...row, position: index + 1 }));

      const topVisits = await db.query<QueryResultRow>(
        `SELECT v.id,v.score,v.created_at,p.id AS player_id,p.display_name,m.id AS match_id,m.round_label,m.bracket_label,k.board_number
           FROM ${this.table("visits")} v
           INNER JOIN ${this.table("matches")} m ON m.id=v.match_id
           INNER JOIN ${this.table("players")} p ON p.id=v.player_id
           LEFT JOIN ${this.table("kiosks")} k ON k.id=m.kiosk_id
          WHERE m.tournament_id=? AND v.is_bust=0
          ORDER BY v.score DESC,v.created_at ASC,v.id ASC LIMIT 3`,
        [tournamentId],
      );
      const topCheckouts = await db.query<QueryResultRow>(
        `SELECT p.id AS player_id,p.display_name,MAX(v.score) AS checkout
           FROM ${this.table("visits")} v
           INNER JOIN ${this.table("matches")} m ON m.id=v.match_id
           INNER JOIN ${this.table("players")} p ON p.id=v.player_id
          WHERE m.tournament_id=? AND v.is_bust=0 AND v.remaining_after=0 AND v.score>0
          GROUP BY p.id,p.display_name ORDER BY checkout DESC,p.display_name ASC LIMIT 3`,
        [tournamentId],
      );
      const topAverages = await db.query<QueryResultRow>(
        `SELECT p.id AS player_id,p.display_name,
                ROUND(COALESCE(SUM(ms.average*COALESCE(ms.darts_thrown,0))/NULLIF(SUM(COALESCE(ms.darts_thrown,0)),0),AVG(ms.average)),2) AS three_dart_average,
                SUM(COALESCE(ms.darts_thrown,0)) AS darts_thrown
           FROM ${this.table("match_statistics")} ms
           INNER JOIN ${this.table("matches")} m ON m.id=ms.match_id
           INNER JOIN ${this.table("players")} p ON p.id=ms.player_id
          WHERE m.tournament_id=? AND m.status='completed' AND ms.average IS NOT NULL
          GROUP BY p.id,p.display_name ORDER BY three_dart_average DESC,darts_thrown DESC,p.display_name ASC LIMIT 3`,
        [tournamentId],
      );

      return {
        tournament,
        standings,
        top_visits: topVisits,
        top_checkouts: topCheckouts,
        top_three_dart_averages: topAverages,
        tie_break_order: ["points", "leg_difference", "three_dart_average"],
      };
    });
  }

  private async aliasIds(db: SqlExecutor, player: PlayerRow): Promise<string[]> {
    const id = decimalId(player.id);
    const clubId = decimalId(player.club_id);
    const name = String(player.display_name ?? "").trim();
    const memberId = decimalId(player.member_id);
    if (id === null) throw new TypeError("Player row is missing a valid id.");
    if (clubId === null || name === "") return [id];

    const rows = await db.query<QueryResultRow>(
      `SELECT id,member_id FROM ${this.table("players")}
        WHERE club_id=? AND is_active=1 AND LOWER(TRIM(display_name))=LOWER(TRIM(?))
        ORDER BY id ASC`,
      [clubId, name],
    );
    const ids: string[] = [];
    for (const row of rows) {
      const rowId = decimalId(row.id);
      if (rowId === null) continue;
      const rowMember = decimalId(row.member_id);
      if (memberId !== null) {
        if (rowMember !== null && rowMember !== memberId) continue;
      } else if (rowMember !== null) {
        continue;
      }
      ids.push(rowId);
    }
    if (!ids.includes(id)) ids.push(id);
    return [...new Set(ids)].sort(compareDecimalIds);
  }

  private table(name: string): string {
    if (!/^[a-z0-9_]+$/i.test(name)) throw new TypeError("Invalid table name.");
    return `\`${this.runtimePrefix}${name}\``;
  }
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

function compareDecimalIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a.localeCompare(b);
}

function integer(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
