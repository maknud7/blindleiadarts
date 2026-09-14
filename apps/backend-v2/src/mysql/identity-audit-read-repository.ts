import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

export class MySqlIdentityAuditReadRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
    private readonly identityPrefix: TablePrefix,
  ) {}

  async mergeHistory(limitInput: unknown = 150): Promise<Record<string, unknown>[]> {
    const limit = clampLimit(limitInput, 150, 500);
    return this.sessions.withConnection(async (db) => {
      const merges = `${this.runtimePrefix}player_identity_merges`;
      if (!(await this.tableExists(db, merges))) return [];

      const users = `${this.identityPrefix}user_accounts`;
      const hasUsers = await this.tableExists(db, users);
      const userJoin = hasUsers ? `LEFT JOIN ${this.identityTable("user_accounts")} ua ON ua.id=m.merged_by_user_account_id` : "";
      const userSelect = hasUsers
        ? "ua.display_name AS merged_by_name, ua.email AS merged_by_email,"
        : "NULL AS merged_by_name, NULL AS merged_by_email,";

      const rows = await db.query<QueryResultRow>(
        `SELECT
           m.id,m.club_id,m.source_player_id,m.target_player_id,
           m.source_display_name,m.target_display_name,m.merged_by_user_account_id,
           m.reason,m.summary_json,m.created_at,
           c.name AS club_name,
           sp.member_id AS source_member_id,
           tp.member_id AS target_member_id,
           ${userSelect}
           sp.merged_at AS source_merged_at
         FROM ${this.table("player_identity_merges")} m
         LEFT JOIN ${this.table("clubs")} c ON c.id=m.club_id
         LEFT JOIN ${this.table("players")} sp ON sp.id=m.source_player_id
         LEFT JOIN ${this.table("players")} tp ON tp.id=m.target_player_id
         ${userJoin}
         ORDER BY m.created_at DESC,m.id DESC
         LIMIT ${limit}`,
      );

      return rows.map((row) => {
        const summary = parseObject(row.summary_json);
        const moved = isRecord(summary.moved) ? summary.moved : {};
        const movedRelations = Object.values(moved).reduce<number>((sum, value) => sum + integer(value), 0);
        return {
          ...row,
          id: publicId(row.id),
          club_id: publicId(row.club_id),
          source_player_id: publicId(row.source_player_id),
          target_player_id: publicId(row.target_player_id),
          merged_by_user_account_id: publicId(row.merged_by_user_account_id),
          source_member_id: publicId(row.source_member_id),
          target_member_id: publicId(row.target_member_id),
          summary,
          moved_relations: movedRelations,
          identity_scope: row.source_member_id !== null && row.source_member_id !== undefined || row.target_member_id !== null && row.target_member_id !== undefined
            ? "player_member"
            : "player",
          summary_json: undefined,
        };
      }).map(stripUndefined);
    });
  }

  async health(): Promise<Record<string, unknown>> {
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT p.club_id,c.name AS club_name,LOWER(TRIM(p.display_name)) AS normalized_name,
                MIN(p.display_name) AS display_name,COUNT(*) AS player_ids,
                GROUP_CONCAT(p.id ORDER BY p.id SEPARATOR ',') AS ids
           FROM ${this.table("players")} p
           LEFT JOIN ${this.table("clubs")} c ON c.id=p.club_id
          WHERE p.merged_into_player_id IS NULL
          GROUP BY p.club_id,c.name,LOWER(TRIM(p.display_name))
         HAVING COUNT(*) > 1
          ORDER BY c.name,display_name`,
      );

      const duplicates = rows.map((row) => ({
        ...row,
        club_id: publicId(row.club_id),
        player_ids: integer(row.player_ids),
        ids: String(row.ids ?? "")
          .split(",")
          .map((value) => decimalId(value))
          .filter((value): value is string => value !== null)
          .map(publicId),
      }));

      const merges = `${this.runtimePrefix}player_identity_merges`;
      let mergeCount = 0;
      if (await this.tableExists(db, merges)) {
        const countRows = await db.query<QueryResultRow>(`SELECT COUNT(*) AS c FROM ${this.table("player_identity_merges")}`);
        mergeCount = integer(countRows[0]?.c);
      }

      return {
        ok: duplicates.length === 0,
        duplicate_groups: duplicates.length,
        duplicate_player_ids: duplicates.reduce((sum, row) => sum + integer(row.player_ids), 0),
        merge_count: mergeCount,
        duplicates,
      };
    });
  }

  private async tableExists(db: SqlExecutor, tableName: string): Promise<boolean> {
    const rows = await db.query<QueryResultRow>(
      "SELECT 1 AS present FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1",
      [tableName],
    );
    return rows.length > 0;
  }

  private table(name: string): string {
    if (!/^[a-z0-9_]+$/.test(name)) throw new TypeError("Invalid identity-audit table name.");
    return `\`${this.runtimePrefix}${name}\``;
  }

  private identityTable(name: string): string {
    if (!/^[a-z0-9_]+$/.test(name)) throw new TypeError("Invalid identity-audit identity table name.");
    return `\`${this.identityPrefix}${name}\``;
  }
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Math.trunc(Number(value ?? fallback));
  return Math.max(1, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
}

function decimalId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}

function publicId(value: unknown): number | string | null {
  const id = decimalId(value);
  if (id === null) return null;
  const parsed = Number(id);
  return Number.isSafeInteger(parsed) ? parsed : id;
}

function integer(value: unknown): number {
  const parsed = Math.trunc(Number(value ?? 0));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined || value === "") return {};
  if (isRecord(value)) return value;
  try {
    const parsed: unknown = JSON.parse(String(value));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
