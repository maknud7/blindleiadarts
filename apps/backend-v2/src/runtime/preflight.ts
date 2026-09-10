import type { MySqlSessionProvider, QueryResultRow, TablePrefix } from "../mysql/contracts.js";

interface VersionRow extends QueryResultRow {
  readonly version: unknown;
}

export interface BackendPreflightResult {
  ok: true;
  mysql_version: string;
  runtime_prefix: string;
  checked_tables: readonly string[];
}

/**
 * Read-only schema compatibility probe used in TEST and PROD preflight.
 * It intentionally validates only tables/columns needed by the first canonical
 * scoring slice and never locks rows or performs a write.
 */
export class BackendScoringPreflight {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
  ) {}

  async run(): Promise<BackendPreflightResult> {
    return this.sessions.withConnection(async (sql) => {
      const versionRows = await sql.query<VersionRow>("SELECT VERSION() AS version");
      const mysqlVersion = String(versionRows[0]?.version ?? "unknown");

      const checks = [
        {
          table: "matches",
          columns: "id, kiosk_id, status, legs_to_win, player_a_id, player_b_id, winner_player_id, starts_at, finished_at",
        },
        {
          table: "legs",
          columns: "id, match_id, leg_number, starting_player_id, status, start_score, winner_player_id, finished_at",
        },
        {
          table: "visits",
          columns: "id, match_id, leg_id, player_id, visit_number, score, darts_used, input_mode, darts_json, is_bust, remaining_after, request_key",
        },
        {
          table: "match_statistics",
          columns: "match_id, player_id, legs_won, average, darts_thrown, checkout_hits, checkout_attempts, highest_checkout, score_100_plus, score_140_plus, score_180",
        },
      ] as const;

      for (const check of checks) {
        await sql.query(
          `SELECT ${check.columns} FROM ${this.table(check.table)} LIMIT 0`,
        );
      }

      return {
        ok: true,
        mysql_version: mysqlVersion,
        runtime_prefix: this.runtimePrefix,
        checked_tables: checks.map((check) => `${this.runtimePrefix}${check.table}`),
      };
    });
  }

  private table(suffix: string): string {
    return `\`${this.runtimePrefix}${suffix}\``;
  }
}
