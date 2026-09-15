import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

interface ForeignKeyReference {
  table: string;
  column: string;
}

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

  async duplicateCandidates(clubIdInput: unknown): Promise<Record<string, unknown>[]> {
    const clubId = requiredId(clubIdInput, "club_id");
    return this.sessions.withConnection(async (db) => {
      const eloTable = `${this.runtimePrefix}elo_current_ratings`;
      const hasElo = await this.tableExists(db, eloTable);
      const eloJoin = hasElo
        ? `LEFT JOIN (SELECT player_id,COUNT(*) AS elo_seasons,MAX(rating) AS top_elo FROM ${this.table("elo_current_ratings")} GROUP BY player_id) er ON er.player_id=p.id`
        : "";
      const eloSelect = hasElo
        ? "COALESCE(er.elo_seasons,0) AS elo_seasons,er.top_elo AS top_elo,"
        : "0 AS elo_seasons,NULL AS top_elo,";

      const rows = await db.query<QueryResultRow>(
        `SELECT
           p.id,p.club_id,p.display_name,p.first_name,p.last_name,p.nickname,p.avatar_url,
           p.member_id,p.member_link_source,p.is_active,
           ${eloSelect}
           COALESCE(mc.match_count,0) AS match_count,
           COALESCE(vc.visit_count,0) AS visit_count,
           COALESCE(tc.tournament_count,0) AS tournament_count
         FROM ${this.table("players")} p
         INNER JOIN (
           SELECT club_id,LOWER(TRIM(display_name)) AS normalized_name
             FROM ${this.table("players")}
            WHERE club_id=? AND merged_into_player_id IS NULL
            GROUP BY club_id,LOWER(TRIM(display_name))
           HAVING COUNT(*) > 1
         ) dup ON dup.club_id=p.club_id AND dup.normalized_name=LOWER(TRIM(p.display_name))
         LEFT JOIN (
           SELECT player_id,COUNT(*) AS match_count FROM (
             SELECT player_a_id AS player_id FROM ${this.table("matches")}
             UNION ALL SELECT player_b_id AS player_id FROM ${this.table("matches")}
           ) x GROUP BY player_id
         ) mc ON mc.player_id=p.id
         LEFT JOIN (SELECT player_id,COUNT(*) AS visit_count FROM ${this.table("visits")} GROUP BY player_id) vc ON vc.player_id=p.id
         LEFT JOIN (SELECT player_id,COUNT(*) AS tournament_count FROM ${this.table("tournament_players")} GROUP BY player_id) tc ON tc.player_id=p.id
         ${eloJoin}
        WHERE p.club_id=? AND p.merged_into_player_id IS NULL
        ORDER BY LOWER(p.display_name),
                 (p.member_id IS NOT NULL) DESC,
                 p.is_active DESC,
                 COALESCE(mc.match_count,0) DESC,
                 p.id`,
        [clubId, clubId],
      );

      const accountIds = await this.accountPlayerIdsWith(db, rows.map((row) => requiredId(row.id, "player_id")));
      return rows.map((row) => {
        const id = requiredId(row.id, "player_id");
        const memberId = publicId(row.member_id);
        const active = integer(row.is_active);
        const matchCount = integer(row.match_count);
        const visitCount = integer(row.visit_count);
        const hasAccount = accountIds.has(id);
        return {
          ...row,
          id: publicId(id),
          club_id: publicId(row.club_id),
          member_id: memberId,
          is_active: active,
          match_count: matchCount,
          visit_count: visitCount,
          tournament_count: integer(row.tournament_count),
          elo_seasons: integer(row.elo_seasons),
          has_account: hasAccount,
          canonical_score: (hasAccount ? 1_000_000 : 0)
            + (memberId !== null ? 500_000 : 0)
            + (active * 100_000)
            + (matchCount * 100)
            + visitCount,
        };
      });
    });
  }

  async preview(clubIdInput: unknown, sourceIdInput: unknown, targetIdInput: unknown): Promise<Record<string, unknown>> {
    const clubId = requiredId(clubIdInput, "club_id");
    const sourceId = optionalId(sourceIdInput);
    const targetId = optionalId(targetIdInput);
    if (sourceId === null || targetId === null || sourceId === targetId) {
      throw new DomainValidationError("validation_error", "Velg to forskjellige spillere.");
    }

    return this.sessions.withConnection(async (db) => {
      const source = await this.playerWith(db, sourceId);
      const target = await this.playerWith(db, targetId);
      if (source === null || target === null) {
        throw new DomainValidationError("validation_error", "Fant ikke begge spillerne.");
      }
      if (decimalId(source.club_id) !== clubId || decimalId(target.club_id) !== clubId) {
        throw new DomainValidationError("validation_error", "Begge spillerne må tilhøre valgt klubb.");
      }
      if (source.merged_into_player_id !== null || target.merged_into_player_id !== null) {
        throw new DomainValidationError("validation_error", "En av spillerne er allerede slått sammen.");
      }

      const conflicts: Record<string, unknown>[] = [];
      const sourceMember = decimalId(source.member_id);
      const targetMember = decimalId(target.member_id);
      if (sourceMember !== null && targetMember !== null && sourceMember !== targetMember) {
        conflicts.push({
          code: "different_members",
          message: "Spillerne er koblet til to forskjellige medlemmer.",
        });
      }

      await this.appendPairConflictWith(
        db,
        conflicts,
        `${this.runtimePrefix}tournament_players`,
        "tournament_id",
        "player_id",
        sourceId,
        targetId,
        "same_tournament",
        "Begge spiller-ID-ene er registrert i samme turnering.",
      );
      await this.appendPairConflictWith(
        db,
        conflicts,
        `${this.runtimePrefix}elo_current_ratings`,
        "season_id",
        "player_id",
        sourceId,
        targetId,
        "same_elo_season",
        "Begge spiller-ID-ene har gjeldende ELO i samme sesong.",
      );

      const ranking = `${this.runtimePrefix}season_ranking_events`;
      if (await this.tableExists(db, ranking)) {
        const count = await this.scalarCountWith(
          db,
          `SELECT COUNT(*) AS c
             FROM ${this.table("season_ranking_events")} a
             INNER JOIN ${this.table("season_ranking_events")} b
               ON b.tournament_id=a.tournament_id AND b.ruleset=a.ruleset
            WHERE a.player_id=? AND b.player_id=?`,
          sourceId,
          targetId,
        );
        if (count > 0) {
          conflicts.push({
            code: "same_ranking_event",
            message: "Begge spiller-ID-ene har seriepoeng i samme turnering.",
          });
        }
      }

      await this.appendPairConflictWith(
        db,
        conflicts,
        `${this.runtimePrefix}tournament_playoff_entries`,
        "playoff_id",
        "player_id",
        sourceId,
        targetId,
        "same_playoff",
        "Begge spiller-ID-ene finnes i samme sluttspill.",
      );

      // Preserve legacy scope semantics: account conflicts are only considered
      // when identity and runtime are the same prefix. TEST shares bd_prod_
      // identity and must not infer or mutate cross-prefix account links here.
      if (this.identityPrefix === this.runtimePrefix) {
        const users = `${this.runtimePrefix}user_accounts`;
        if (await this.tableExists(db, users)) {
          const rows = await db.query<QueryResultRow>(
            `SELECT COUNT(*) AS c FROM ${this.table("user_accounts")} WHERE player_id IN (?,?)`,
            [sourceId, targetId],
          );
          if (integer(rows[0]?.c) > 1) {
            conflicts.push({
              code: "two_accounts",
              message: "Begge spiller-ID-ene er koblet til hver sin brukerkonto.",
            });
          }
        }
      }

      return {
        source,
        target,
        references: await this.referenceCountsWith(db, sourceId),
        conflicts,
        safe_to_merge: conflicts.length === 0,
      };
    });
  }

  private async playerWith(db: SqlExecutor, playerId: string): Promise<Record<string, unknown> | null> {
    const rows = await db.query<QueryResultRow>(
      `SELECT id,club_id,display_name,first_name,last_name,nickname,avatar_url,member_id,member_link_source,is_active,merged_into_player_id,merged_at
         FROM ${this.table("players")} WHERE id=? LIMIT 1`,
      [playerId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      ...row,
      id: publicId(row.id),
      club_id: publicId(row.club_id),
      member_id: publicId(row.member_id),
      is_active: integer(row.is_active),
      merged_into_player_id: publicId(row.merged_into_player_id),
    };
  }

  private async appendPairConflictWith(
    db: SqlExecutor,
    conflicts: Record<string, unknown>[],
    tableName: string,
    scopeColumn: string,
    playerColumn: string,
    sourceId: string,
    targetId: string,
    code: string,
    message: string,
  ): Promise<void> {
    if (!(await this.tableExists(db, tableName))) return;
    const table = quoteIdentifier(tableName);
    const scope = quoteIdentifier(scopeColumn);
    const player = quoteIdentifier(playerColumn);
    const count = await this.scalarCountWith(
      db,
      `SELECT COUNT(*) AS c FROM ${table} a INNER JOIN ${table} b ON b.${scope}=a.${scope} WHERE a.${player}=? AND b.${player}=?`,
      sourceId,
      targetId,
    );
    if (count > 0) conflicts.push({ code, message });
  }

  private async scalarCountWith(db: SqlExecutor, sql: string, left: string, right: string): Promise<number> {
    const rows = await db.query<QueryResultRow>(sql, [left, right]);
    return integer(rows[0]?.c);
  }

  private async referenceCountsWith(db: SqlExecutor, playerId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const reference of await this.foreignKeyReferencesWith(db)) {
      if (reference.table === `${this.runtimePrefix}players` && reference.column === "merged_into_player_id") continue;
      const rows = await db.query<QueryResultRow>(
        `SELECT COUNT(*) AS c FROM ${quoteIdentifier(reference.table)} WHERE ${quoteIdentifier(reference.column)}=?`,
        [playerId],
      );
      const count = integer(rows[0]?.c);
      if (count > 0) counts[`${reference.table}.${reference.column}`] = count;
    }
    return counts;
  }

  private async foreignKeyReferencesWith(db: SqlExecutor): Promise<ForeignKeyReference[]> {
    const rows = await db.query<QueryResultRow>(
      `SELECT TABLE_NAME,COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA=DATABASE()
          AND REFERENCED_TABLE_SCHEMA=DATABASE()
          AND REFERENCED_TABLE_NAME=?
          AND REFERENCED_COLUMN_NAME='id'
        ORDER BY TABLE_NAME,COLUMN_NAME`,
      [`${this.runtimePrefix}players`],
    );
    return rows.map((row) => ({
      table: validIdentifier(row.TABLE_NAME, "TABLE_NAME"),
      column: validIdentifier(row.COLUMN_NAME, "COLUMN_NAME"),
    }));
  }

  private async accountPlayerIdsWith(db: SqlExecutor, playerIds: string[]): Promise<Set<string>> {
    if (playerIds.length === 0 || this.identityPrefix !== this.runtimePrefix) return new Set<string>();
    const users = `${this.runtimePrefix}user_accounts`;
    if (!(await this.tableExists(db, users))) return new Set<string>();
    const unique = [...new Set(playerIds)];
    const placeholders = unique.map(() => "?").join(",");
    const rows = await db.query<QueryResultRow>(
      `SELECT player_id FROM ${this.table("user_accounts")} WHERE player_id IN (${placeholders})`,
      unique,
    );
    return new Set(rows.map((row) => decimalId(row.player_id)).filter((value): value is string => value !== null));
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

function requiredId(value: unknown, name: string): string {
  const id = decimalId(value);
  if (id === null) throw new DomainValidationError("invalid_id", `${name} must be a positive decimal id.`, 400);
  return id;
}

function optionalId(value: unknown): string | null {
  return decimalId(value);
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

function validIdentifier(value: unknown, name: string): string {
  const normalized = String(value ?? "");
  if (!/^[A-Za-z0-9_]+$/.test(normalized)) throw new TypeError(`Invalid ${name}.`);
  return normalized;
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new TypeError("Invalid SQL identifier.");
  return `\`${value}\``;
}
