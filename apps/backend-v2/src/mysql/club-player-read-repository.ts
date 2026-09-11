import { eloBaselineFor } from "../data/mandagsserien-elo-2026-08-24.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

interface PlayerRow extends QueryResultRow {
  readonly id?: unknown;
  readonly club_id?: unknown;
  readonly member_id?: unknown;
  readonly display_name?: unknown;
}

export class MySqlClubPlayerReadRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
  ) {}

  async listClubs(): Promise<Record<string, unknown>[]> {
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT c.id,c.name,c.slug,c.logo_url,c.kiosk_pairing_code,
                COUNT(DISTINCT p.id) AS player_count,
                COUNT(DISTINCT k.id) AS kiosk_count,
                COUNT(DISTINCT CASE WHEN t.status IN ('draft','ready','in_progress') THEN t.id END) AS active_tournament_count
           FROM ${this.table("clubs")} c
           LEFT JOIN ${this.table("players")} p ON p.club_id=c.id AND p.is_active=1
           LEFT JOIN ${this.table("kiosks")} k ON k.club_id=c.id AND k.is_active=1
           LEFT JOIN ${this.table("tournaments")} t ON t.club_id=c.id
          GROUP BY c.id,c.name,c.slug,c.logo_url,c.kiosk_pairing_code
          ORDER BY c.name ASC`,
      );
      return rows.map((row) => ({
        ...row,
        id: publicId(decimalId(row.id)),
        player_count: integer(row.player_count),
        kiosk_count: integer(row.kiosk_count),
        active_tournament_count: integer(row.active_tournament_count),
      }));
    });
  }

  async listPlayerDirectory(clubId: string): Promise<Record<string, unknown>[]> {
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT p.id,p.member_id,p.display_name,p.nickname,p.avatar_url,p.is_active,
                COUNT(DISTINCT CASE WHEN m.status='completed' THEN m.id END) AS matches_played,
                COUNT(DISTINCT CASE WHEN m.status='completed' AND m.winner_player_id=p.id THEN m.id END) AS matches_won,
                COALESCE((SELECT SUM(ms.score_180) FROM ${this.table("match_statistics")} ms WHERE ms.player_id=p.id),0) AS score_180,
                COALESCE((SELECT MAX(ms.highest_checkout) FROM ${this.table("match_statistics")} ms WHERE ms.player_id=p.id),0) AS highest_checkout,
                COALESCE((SELECT SUM(COALESCE(ms.darts_thrown,0)) FROM ${this.table("match_statistics")} ms WHERE ms.player_id=p.id),0) AS recorded_darts,
                COALESCE((SELECT ROUND(COALESCE(
                  SUM(ms.average*COALESCE(ms.darts_thrown,0))/NULLIF(SUM(COALESCE(ms.darts_thrown,0)),0),
                  AVG(ms.average)
                ),2) FROM ${this.table("match_statistics")} ms WHERE ms.player_id=p.id AND ms.average IS NOT NULL),0) AS recorded_average,
                (SELECT rs.points FROM ${this.table("ranking_snapshots")} rs
                  WHERE rs.player_id=p.id AND rs.ranking_type='elo'
                  ORDER BY rs.calculated_at DESC,rs.id DESC LIMIT 1) AS elo_rating,
                (SELECT rs.calculated_at FROM ${this.table("ranking_snapshots")} rs
                  WHERE rs.player_id=p.id AND rs.ranking_type='elo'
                  ORDER BY rs.calculated_at DESC,rs.id DESC LIMIT 1) AS elo_calculated_at
           FROM ${this.table("players")} p
           LEFT JOIN ${this.table("matches")} m ON (m.player_a_id=p.id OR m.player_b_id=p.id)
          WHERE p.club_id=? AND p.is_active=1
          GROUP BY p.id,p.member_id,p.display_name,p.nickname,p.avatar_url,p.is_active
          ORDER BY p.display_name ASC,p.id ASC`,
        [clubId],
      );

      const normalized = rows.map((row) => this.normalizeDirectoryRow(row));
      return this.collapseDuplicatePlayerRows(normalized);
    });
  }

  async listEloTable(clubId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.listPlayerDirectory(clubId);
    rows.sort((a, b) => {
      const rating = numberValue(b.elo_rating, 1000) - numberValue(a.elo_rating, 1000);
      if (rating !== 0) return rating;
      return String(a.display_name ?? "").localeCompare(String(b.display_name ?? ""), "nb-NO", { sensitivity: "base" });
    });
    return rows.map((row, index) => ({ ...row, position: index + 1 }));
  }

  async listPlayerMatches(playerId: string, limit = 200): Promise<Record<string, unknown>[] | null> {
    return this.sessions.withConnection(async (db) => {
      const players = await db.query<PlayerRow>(
        `SELECT id,club_id,member_id,display_name FROM ${this.table("players")} WHERE id=? LIMIT 1`,
        [playerId],
      );
      const player = players[0];
      if (player === undefined) return null;
      const aliases = await this.aliasIds(db, player);
      const inList = aliases.join(",");
      const safeLimit = Math.max(1, Math.min(250, Math.trunc(limit)));
      const rows = await db.query<QueryResultRow>(
        `SELECT m.id,m.tournament_id,t.name AS tournament_name,t.start_at,
                m.round_label,m.bracket_label,m.status,m.winner_player_id,m.finished_at,
                m.player_a_id,pa.display_name AS player_a_name,
                m.player_b_id,pb.display_name AS player_b_name,
                (SELECT ms.average FROM ${this.table("match_statistics")} ms WHERE ms.match_id=m.id AND ms.player_id IN (${inList}) ORDER BY ms.id ASC LIMIT 1) AS average,
                (SELECT ms.highest_checkout FROM ${this.table("match_statistics")} ms WHERE ms.match_id=m.id AND ms.player_id IN (${inList}) ORDER BY ms.id ASC LIMIT 1) AS highest_checkout,
                (SELECT ms.score_180 FROM ${this.table("match_statistics")} ms WHERE ms.match_id=m.id AND ms.player_id IN (${inList}) ORDER BY ms.id ASC LIMIT 1) AS score_180
           FROM ${this.table("matches")} m
           INNER JOIN ${this.table("tournaments")} t ON t.id=m.tournament_id
           INNER JOIN ${this.table("players")} pa ON pa.id=m.player_a_id
           INNER JOIN ${this.table("players")} pb ON pb.id=m.player_b_id
          WHERE (m.player_a_id IN (${inList}) OR m.player_b_id IN (${inList})) AND m.status='completed'
          ORDER BY COALESCE(m.finished_at,t.start_at,m.created_at) DESC,m.id DESC
          LIMIT ${safeLimit}`,
      );
      const aliasSet = new Set(aliases);
      return rows.map((row) => {
        const a = decimalId(row.player_a_id);
        const winner = decimalId(row.winner_player_id);
        return {
          ...row,
          id: publicId(decimalId(row.id)),
          tournament_id: publicId(decimalId(row.tournament_id)),
          winner_player_id: publicId(winner),
          player_a_id: publicId(a),
          player_b_id: publicId(decimalId(row.player_b_id)),
          opponent_name: a !== null && aliasSet.has(a) ? row.player_b_name : row.player_a_name,
          result: winner === null ? "draw" : aliasSet.has(winner) ? "win" : "loss",
          average: row.average === null || row.average === undefined ? null : numberValue(row.average),
        };
      });
    });
  }

  private normalizeDirectoryRow(row: QueryResultRow): Record<string, unknown> {
    const played = integer(row.matches_played);
    const won = integer(row.matches_won);
    const baseline = eloBaselineFor(row.display_name);
    const hasSnapshot = row.elo_rating !== null && row.elo_rating !== undefined;
    const rating = hasSnapshot ? numberValue(row.elo_rating, 1000) : (baseline?.rating ?? 1000);
    return {
      ...row,
      id: publicId(decimalId(row.id)),
      member_id: publicId(decimalId(row.member_id)),
      is_active: integer(row.is_active),
      matches_played: played,
      matches_won: won,
      matches_lost: Math.max(0, played - won),
      win_percentage: played > 0 ? round((won / played) * 100, 1) : 0,
      score_180: integer(row.score_180),
      highest_checkout: integer(row.highest_checkout),
      recorded_darts: integer(row.recorded_darts),
      recorded_average: numberValue(row.recorded_average),
      three_dart_average: numberValue(row.recorded_average),
      elo_rating: rating,
      elo_source: hasSnapshot ? "ranking_snapshot" : baseline ? "mandagsserien_2026_08_24" : "default_1000",
      baseline_played: hasSnapshot ? null : (baseline?.played ?? 0),
    };
  }

  private collapseDuplicatePlayerRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      const key = String(row.display_name ?? "").trim().toLocaleLowerCase("nb-NO");
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }

    const result: Record<string, unknown>[] = [];
    for (const group of groups.values()) {
      if (group.length === 1) {
        result.push(group[0]!);
        continue;
      }
      const memberIds = [...new Set(group.map((row) => decimalId(row.member_id)).filter((value): value is string => value !== null))];
      if (memberIds.length > 1) {
        result.push(...group);
        continue;
      }
      group.sort((a, b) => {
        const member = (decimalId(b.member_id) === null ? 0 : 1) - (decimalId(a.member_id) === null ? 0 : 1);
        if (member !== 0) return member;
        const matches = integer(b.matches_played) - integer(a.matches_played);
        if (matches !== 0) return matches;
        return compareDecimalIds(decimalId(a.id) ?? "0", decimalId(b.id) ?? "0");
      });
      const primary = group[0]!;
      const played = group.reduce((sum, row) => sum + integer(row.matches_played), 0);
      const won = group.reduce((sum, row) => sum + integer(row.matches_won), 0);
      const recordedDarts = group.reduce((sum, row) => sum + integer(row.recorded_darts), 0);
      let recordedAverage = 0;
      if (recordedDarts > 0) {
        const weighted = group.reduce((sum, row) => sum + numberValue(row.recorded_average) * integer(row.recorded_darts), 0);
        recordedAverage = round(weighted / recordedDarts, 2);
      } else {
        const averages = group.map((row) => numberValue(row.recorded_average)).filter((value) => value > 0);
        recordedAverage = averages.length > 0 ? round(averages.reduce((sum, value) => sum + value, 0) / averages.length, 2) : 0;
      }

      const snapshotRows = group.filter((row) => row.elo_source === "ranking_snapshot")
        .sort((a, b) => String(b.elo_calculated_at ?? "").localeCompare(String(a.elo_calculated_at ?? "")));
      const merged: Record<string, unknown> = {
        ...primary,
        duplicate_player_ids: group.map((row) => publicId(decimalId(row.id))),
        matches_played: played,
        matches_won: won,
        matches_lost: Math.max(0, played - won),
        win_percentage: played > 0 ? round((won / played) * 100, 1) : 0,
        score_180: group.reduce((sum, row) => sum + integer(row.score_180), 0),
        highest_checkout: Math.max(...group.map((row) => integer(row.highest_checkout))),
        recorded_darts: recordedDarts,
        recorded_average: recordedAverage,
        three_dart_average: recordedAverage,
        baseline_played: Math.max(...group.map((row) => integer(row.baseline_played))),
      };
      if (snapshotRows.length > 0) {
        merged.elo_rating = numberValue(snapshotRows[0]!.elo_rating, 1000);
        merged.elo_source = "ranking_snapshot";
        merged.elo_calculated_at = snapshotRows[0]!.elo_calculated_at ?? null;
      }
      result.push(merged);
    }

    return result.sort((a, b) => String(a.display_name ?? "").localeCompare(String(b.display_name ?? ""), "nb-NO", { sensitivity: "base" }));
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

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
