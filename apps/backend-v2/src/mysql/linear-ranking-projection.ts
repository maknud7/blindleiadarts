import type { DbId } from "../contracts/scoring.js";
import { asDbId } from "../contracts/scoring.js";
import type { CanonicalRankingPort } from "../service/canonical-scoring-service.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

interface TournamentRow extends QueryResultRow {
  readonly tournament_id?: unknown;
  readonly season_id?: unknown;
  readonly status?: unknown;
  readonly ranking_method?: unknown;
}

interface PlayoffRow extends QueryResultRow {
  readonly id?: unknown;
  readonly bracket_size?: unknown;
  readonly champion_player_id?: unknown;
}

interface ProgressRow extends QueryResultRow {
  readonly player_id?: unknown;
  readonly round_number?: unknown;
  readonly round_label?: unknown;
  readonly player_a_id?: unknown;
  readonly player_b_id?: unknown;
  readonly winner_player_id?: unknown;
}

interface RankingState {
  points: number;
  stageLabel: string;
  stageNumber: number;
  metadata: Record<string, string | number>;
}

/** Tournament-placement ranking used by seasons with ranking_method=linear. */
export class MySqlLinearRankingProjection implements CanonicalRankingPort {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
  ) {}

  async reconcileLinearRanking(matchId: DbId | null): Promise<void> {
    if (matchId === null) return;

    await this.sessions.withTransaction(async (sql) => {
      const tournament = await this.tournamentForMatch(sql, matchId);
      if (tournament === null) return;
      const tournamentId = dbId(tournament.tournament_id, "matches.tournament_id");
      const seasonId = nullableDbId(tournament.season_id, "tournaments.season_id");
      if (seasonId === null || dbString(tournament.ranking_method) !== "linear") return;

      if (dbString(tournament.status) !== "completed") {
        await this.revertTournament(sql, tournamentId);
        return;
      }

      const participants = await this.participants(sql, tournamentId);
      if (participants.length === 0) return;

      const entrants = participants.length;
      const maximum = maximumLinearPoints(entrants);
      const rows = new Map<DbId, RankingState>();
      for (const playerId of participants) {
        rows.set(playerId, {
          points: 1,
          stageLabel: "Deltaker",
          stageNumber: 0,
          metadata: { calculation: "field_size_and_stage" },
        });
      }

      const playoff = await this.playoff(sql, tournamentId);
      if (playoff !== null) {
        const playoffId = dbId(playoff.id, "tournament_playoffs.id");
        const bracketSize = Math.max(2, dbInt(playoff.bracket_size, "tournament_playoffs.bracket_size"));
        const roundCount = Math.max(1, Math.round(Math.log2(bracketSize)));
        const firstPlayoffPoints = Math.max(1, maximum - roundCount);
        const championId = nullableDbId(playoff.champion_player_id, "tournament_playoffs.champion_player_id");
        const progress = await this.playoffProgress(sql, playoffId);

        for (const [playerId, reached] of progress) {
          const row = rows.get(playerId);
          if (row === undefined) continue;
          const round = Math.max(1, reached.round);
          const points = championId === playerId
            ? maximum
            : Math.min(maximum - 1, firstPlayoffPoints + round - 1);
          rows.set(playerId, {
            points: Math.max(1, points),
            stageLabel: reached.label || "Sluttspill",
            stageNumber: round,
            metadata: {
              calculation: "field_size_and_stage",
              bracket_size: bracketSize,
              playoff_rounds: roundCount,
            },
          });
        }
      } else {
        const wins = await this.completedWins(sql, tournamentId);
        for (const [playerId, winCount] of wins) {
          const row = rows.get(playerId);
          if (row === undefined) continue;
          rows.set(playerId, {
            ...row,
            points: Math.min(maximum, 1 + winCount),
            stageLabel: "Sluttplassering",
            stageNumber: winCount,
            metadata: { calculation: "completed_match_wins_fallback" },
          });
        }
      }

      for (const [playerId, row] of rows) {
        await sql.execute(
          `INSERT INTO ${this.table("season_ranking_events")}
           (season_id,tournament_id,player_id,entrants,stage_label,stage_number,points,ruleset,source,source_reference,status,metadata_json,applied_at,reverted_at)
           VALUES (?,?,?,?,?,?,?,"linear_v1","local",NULL,"applied",?,CURRENT_TIMESTAMP(6),NULL)
           ON DUPLICATE KEY UPDATE
             season_id=VALUES(season_id),entrants=VALUES(entrants),stage_label=VALUES(stage_label),stage_number=VALUES(stage_number),
             points=VALUES(points),source="local",source_reference=NULL,status="applied",metadata_json=VALUES(metadata_json),
             applied_at=CURRENT_TIMESTAMP(6),reverted_at=NULL`,
          [
            seasonId,
            tournamentId,
            playerId,
            entrants,
            row.stageLabel,
            row.stageNumber,
            row.points,
            JSON.stringify(row.metadata),
          ],
        );
      }

      const playerIds = [...rows.keys()];
      if (playerIds.length > 0) {
        const placeholders = playerIds.map(() => "?").join(",");
        await sql.execute(
          `UPDATE ${this.table("season_ranking_events")}
           SET status="reverted",reverted_at=CURRENT_TIMESTAMP(6)
           WHERE tournament_id=? AND ruleset="linear_v1"
             AND player_id NOT IN (${placeholders}) AND status="applied"`,
          [tournamentId, ...playerIds],
        );
      }
    });
  }

  private async tournamentForMatch(sql: SqlExecutor, matchId: DbId): Promise<TournamentRow | null> {
    const rows = await sql.query<TournamentRow>(
      `SELECT m.tournament_id,t.season_id,t.status,s.ranking_method
       FROM ${this.table("matches")} m
       INNER JOIN ${this.table("tournaments")} t ON t.id=m.tournament_id
       LEFT JOIN ${this.table("seasons")} s ON s.id=t.season_id
       WHERE m.id=? LIMIT 1 FOR UPDATE`,
      [matchId],
    );
    return rows[0] ?? null;
  }

  private async revertTournament(sql: SqlExecutor, tournamentId: DbId): Promise<void> {
    await sql.execute(
      `UPDATE ${this.table("season_ranking_events")}
       SET status="reverted",reverted_at=CURRENT_TIMESTAMP(6)
       WHERE tournament_id=? AND ruleset="linear_v1" AND status="applied"`,
      [tournamentId],
    );
  }

  private async participants(sql: SqlExecutor, tournamentId: DbId): Promise<readonly DbId[]> {
    const rows = await sql.query<QueryResultRow>(
      `SELECT DISTINCT player_id FROM (
         SELECT player_a_id AS player_id FROM ${this.table("matches")} WHERE tournament_id=? AND status<>"cancelled"
         UNION
         SELECT player_b_id AS player_id FROM ${this.table("matches")} WHERE tournament_id=? AND status<>"cancelled"
       ) x WHERE player_id IS NOT NULL ORDER BY player_id`,
      [tournamentId, tournamentId],
    );
    return rows.map((row) => dbId(row.player_id, "matches.player_id"));
  }

  private async playoff(sql: SqlExecutor, tournamentId: DbId): Promise<PlayoffRow | null> {
    const rows = await sql.query<PlayoffRow>(
      `SELECT id,bracket_size,champion_player_id
       FROM ${this.table("tournament_playoffs")} WHERE tournament_id=? LIMIT 1`,
      [tournamentId],
    );
    return rows[0] ?? null;
  }

  private async playoffProgress(
    sql: SqlExecutor,
    playoffId: DbId,
  ): Promise<ReadonlyMap<DbId, { readonly round: number; readonly label: string }>> {
    const entries = await sql.query<QueryResultRow>(
      `SELECT player_id FROM ${this.table("tournament_playoff_entries")}
       WHERE playoff_id=? ORDER BY seed_number ASC`,
      [playoffId],
    );
    const nodes = await sql.query<ProgressRow>(
      `SELECT round_number,round_label,player_a_id,player_b_id,winner_player_id
       FROM ${this.table("tournament_playoff_nodes")}
       WHERE playoff_id=? ORDER BY round_number ASC,position ASC`,
      [playoffId],
    );

    const progress = new Map<DbId, { round: number; label: string }>();
    for (const entry of entries) {
      const playerId = dbId(entry.player_id, "tournament_playoff_entries.player_id");
      let round = 1;
      let label = "Sluttspill";
      for (const node of nodes) {
        const involved = [node.player_a_id, node.player_b_id, node.winner_player_id]
          .some((value) => value !== null && value !== undefined && dbId(value, "tournament_playoff_nodes.player_id") === playerId);
        if (!involved) continue;
        const candidateRound = dbInt(node.round_number, "tournament_playoff_nodes.round_number");
        if (candidateRound >= round) {
          round = candidateRound;
          label = dbString(node.round_label) || "Sluttspill";
        }
      }
      progress.set(playerId, { round, label });
    }
    return progress;
  }

  private async completedWins(sql: SqlExecutor, tournamentId: DbId): Promise<ReadonlyMap<DbId, number>> {
    const rows = await sql.query<QueryResultRow>(
      `SELECT winner_player_id,COUNT(*) AS wins FROM ${this.table("matches")}
       WHERE tournament_id=? AND status="completed" AND winner_player_id IS NOT NULL
       GROUP BY winner_player_id`,
      [tournamentId],
    );
    const result = new Map<DbId, number>();
    for (const row of rows) {
      result.set(
        dbId(row.winner_player_id, "matches.winner_player_id"),
        dbInt(row.wins, "matches.wins"),
      );
    }
    return result;
  }

  private table(name: string): string {
    return `\`${this.runtimePrefix}${name}\``;
  }
}

export function maximumLinearPoints(entrants: number): number {
  if (!Number.isInteger(entrants) || entrants < 0) {
    throw new Error("entrants must be a non-negative integer");
  }
  if (entrants <= 1) return 1;
  return 1 + Math.ceil(Math.log2(entrants));
}

function dbId(value: unknown, field: string): DbId {
  if (typeof value !== "string") {
    throw new Error(`${field} must be returned from MySQL as a decimal string`);
  }
  return asDbId(value);
}

function nullableDbId(value: unknown, field: string): DbId | null {
  if (value === null || value === undefined) return null;
  return dbId(value, field);
}

function dbInt(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`${field} must be a safe integer`);
}

function dbString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}
