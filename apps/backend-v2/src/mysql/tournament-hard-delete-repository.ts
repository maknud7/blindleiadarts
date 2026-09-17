import { asDbId } from "../contracts/scoring.js";
import { DomainValidationError } from "../domain/errors.js";
import { MySqlCanonicalEloLedger } from "./canonical-elo-ledger.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

interface OwnershipEdge {
  readonly childTable: string;
  readonly childColumn: string;
  readonly parentTable: string;
  readonly parentColumn: string;
}

interface InformationSchemaColumnRow extends QueryResultRow {
  readonly TABLE_NAME?: unknown;
  readonly COLUMN_NAME?: unknown;
}

interface InformationSchemaEdgeRow extends QueryResultRow {
  readonly child_table?: unknown;
  readonly child_column?: unknown;
  readonly parent_table?: unknown;
  readonly parent_column?: unknown;
}

/**
 * Permanent tournament deletion with the same structural ownership semantics as
 * the PHP TournamentAdminMutationRepository. The whole operation, including
 * canonical ELO rollback/replay, runs inside one outer runtime transaction.
 */
export class MySqlTournamentHardDeleteRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly prefix: TablePrefix,
  ) {}

  async hardDeleteTournament(tournamentIdInput: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");

    return this.sessions.withTransaction(async (db) => {
      const tournament = await db.query<QueryResultRow>(
        `SELECT id FROM ${this.table("tournaments")} WHERE id=? LIMIT 1 FOR UPDATE`,
        [tournamentId],
      );
      if (tournament.length === 0) {
        throw new DomainValidationError("tournament_not_found", "Tournament was not found.", 404);
      }

      const matchRows = await db.query<QueryResultRow>(
        `SELECT id FROM ${this.table("matches")} WHERE tournament_id=? ORDER BY id ASC`,
        [tournamentId],
      );
      const matchIds = matchRows.map((row) => requiredId(row.id, "match_id"));

      // MySqlCanonicalEloLedger normally owns its own short transaction. Bind it
      // to the already-open hard-delete transaction so ELO rollback/replay and
      // structural deletion commit or roll back as one canonical mutation.
      const elo = new MySqlCanonicalEloLedger(new BoundSessionProvider(db), this.prefix);
      for (const matchId of matchIds) {
        await elo.revertMatch(asDbId(matchId));
      }

      const columnsByTable = await this.columnsByTable(db);
      const groupIds = await this.idsForTournamentTable(db, columnsByTable, "tournament_groups", tournamentId);
      let deletedRows = await this.deletePolymorphicReferences(
        db,
        columnsByTable,
        tournamentId,
        matchIds,
        groupIds,
      );

      const rootTable = `${this.prefix}tournaments`;
      const edges = await this.ownershipEdges(db, rootTable);
      const paths = this.ownershipPaths(rootTable, edges)
        .sort((left, right) => right.length - left.length);

      for (const path of paths) {
        deletedRows += await this.deleteOwnershipPath(db, path, tournamentId);
      }

      const root = await db.execute(
        `DELETE FROM ${quoteIdentifier(rootTable)} WHERE id=?`,
        [tournamentId],
      );
      deletedRows += root.affectedRows;

      const remaining = await db.query<QueryResultRow>(
        `SELECT 1 AS found FROM ${quoteIdentifier(rootTable)} WHERE id=? LIMIT 1`,
        [tournamentId],
      );
      if (remaining.length > 0) {
        throw new Error("Tournament hard delete did not remove the canonical tournament row.");
      }

      return {
        tournament_id: tournamentId,
        matches: matchIds.length,
        deleted_rows: deletedRows,
      };
    });
  }

  private async idsForTournamentTable(
    db: SqlExecutor,
    columnsByTable: ReadonlyMap<string, ReadonlySet<string>>,
    suffix: string,
    tournamentId: string,
  ): Promise<string[]> {
    const table = `${this.prefix}${suffix}`;
    const columns = columnsByTable.get(table);
    if (!columns?.has("tournament_id") || !columns.has("id")) return [];

    const rows = await db.query<QueryResultRow>(
      `SELECT id FROM ${quoteIdentifier(table)} WHERE tournament_id=?`,
      [tournamentId],
    );
    return rows.map((row) => requiredId(row.id, `${suffix}.id`));
  }

  private async deletePolymorphicReferences(
    db: SqlExecutor,
    columnsByTable: ReadonlyMap<string, ReadonlySet<string>>,
    tournamentId: string,
    matchIds: readonly string[],
    groupIds: readonly string[],
  ): Promise<number> {
    const pairs = [
      { type: "internal_entity_type", id: "internal_id" },
      { type: "entity_type", id: "entity_id" },
      { type: "subject_type", id: "subject_id" },
    ] as const;
    const entities = [
      { types: ["tournament", "tournaments"] as const, ids: [tournamentId] },
      { types: ["match", "matches", "tournament_match"] as const, ids: matchIds },
      { types: ["tournament_group"] as const, ids: groupIds },
    ] as const;

    let deleted = 0;
    for (const [table, columns] of columnsByTable) {
      for (const pair of pairs) {
        if (!columns.has(pair.type) || !columns.has(pair.id)) continue;
        for (const entity of entities) {
          if (entity.ids.length === 0) continue;
          const typePlaceholders = entity.types.map(() => "?").join(",");
          for (const id of entity.ids) {
            const result = await db.execute(
              `DELETE FROM ${quoteIdentifier(table)}\n` +
                ` WHERE LOWER(${quoteIdentifier(pair.type)}) IN (${typePlaceholders})` +
                ` AND ${quoteIdentifier(pair.id)}=?`,
              [...entity.types, id],
            );
            deleted += result.affectedRows;
          }
        }
      }
    }
    return deleted;
  }

  private async ownershipEdges(
    db: SqlExecutor,
    rootTable: string,
  ): Promise<Map<string, OwnershipEdge[]>> {
    const edges = new Map<string, OwnershipEdge[]>();
    const seen = new Set<string>();

    const fkRows = await db.query<InformationSchemaEdgeRow>(
      `SELECT TABLE_NAME AS child_table, COLUMN_NAME AS child_column,\n` +
        `       REFERENCED_TABLE_NAME AS parent_table, REFERENCED_COLUMN_NAME AS parent_column\n` +
        `  FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE\n` +
        ` WHERE TABLE_SCHEMA=DATABASE()\n` +
        `   AND REFERENCED_TABLE_SCHEMA=DATABASE()\n` +
        `   AND REFERENCED_TABLE_NAME IS NOT NULL`,
    );
    for (const row of fkRows) {
      const edge = normalizeEdge(row);
      if (!this.isApplicationTable(edge.childTable) || !this.isApplicationTable(edge.parentTable)) continue;
      this.addEdge(edges, seen, edge);
    }

    const tournamentRows = await db.query<InformationSchemaColumnRow>(
      `SELECT c.TABLE_NAME\n` +
        `  FROM INFORMATION_SCHEMA.COLUMNS c\n` +
        `  INNER JOIN INFORMATION_SCHEMA.TABLES t\n` +
        `    ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME\n` +
        ` WHERE c.TABLE_SCHEMA=DATABASE()\n` +
        `   AND c.COLUMN_NAME='tournament_id'\n` +
        `   AND t.TABLE_TYPE='BASE TABLE'`,
    );
    for (const row of tournamentRows) {
      const childTable = nonEmptyString(row.TABLE_NAME, "TABLE_NAME");
      if (childTable === rootTable || !this.isApplicationTable(childTable)) continue;
      this.addEdge(edges, seen, {
        childTable,
        childColumn: "tournament_id",
        parentTable: rootTable,
        parentColumn: "id",
      });
    }

    return edges;
  }

  private addEdge(
    edges: Map<string, OwnershipEdge[]>,
    seen: Set<string>,
    edge: OwnershipEdge,
  ): void {
    const key = [edge.childTable, edge.childColumn, edge.parentTable, edge.parentColumn].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    const current = edges.get(edge.parentTable) ?? [];
    current.push(edge);
    edges.set(edge.parentTable, current);
  }

  private ownershipPaths(
    rootTable: string,
    edges: ReadonlyMap<string, readonly OwnershipEdge[]>,
  ): OwnershipEdge[][] {
    const paths: OwnershipEdge[][] = [];

    const walk = (parent: string, path: readonly OwnershipEdge[], seenTables: ReadonlySet<string>): void => {
      for (const edge of edges.get(parent) ?? []) {
        if (seenTables.has(edge.childTable)) continue;
        const nextPath = [...path, edge];
        paths.push(nextPath);
        walk(edge.childTable, nextPath, new Set([...seenTables, edge.childTable]));
      }
    };

    walk(rootTable, [], new Set([rootTable]));
    return paths;
  }

  private async deleteOwnershipPath(
    db: SqlExecutor,
    path: readonly OwnershipEdge[],
    tournamentId: string,
  ): Promise<number> {
    if (path.length === 0) return 0;
    const last = path[path.length - 1]!;
    let sql = `DELETE target FROM ${quoteIdentifier(last.childTable)} target`;
    let currentAlias = "target";

    for (let index = path.length - 1; index >= 0; index -= 1) {
      const edge = path[index]!;
      const parentAlias = `p${index}`;
      sql += ` INNER JOIN ${quoteIdentifier(edge.parentTable)} ${parentAlias}` +
        ` ON ${currentAlias}.${quoteIdentifier(edge.childColumn)}` +
        `=${parentAlias}.${quoteIdentifier(edge.parentColumn)}`;
      currentAlias = parentAlias;
    }

    sql += ` WHERE ${currentAlias}.id=?`;
    const result = await db.execute(sql, [tournamentId]);
    return result.affectedRows;
  }

  private async columnsByTable(db: SqlExecutor): Promise<Map<string, Set<string>>> {
    const rows = await db.query<InformationSchemaColumnRow>(
      `SELECT c.TABLE_NAME, c.COLUMN_NAME\n` +
        `  FROM INFORMATION_SCHEMA.COLUMNS c\n` +
        `  INNER JOIN INFORMATION_SCHEMA.TABLES t\n` +
        `    ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME\n` +
        ` WHERE c.TABLE_SCHEMA=DATABASE()\n` +
        `   AND t.TABLE_TYPE='BASE TABLE'`,
    );
    const columns = new Map<string, Set<string>>();
    for (const row of rows) {
      const table = nonEmptyString(row.TABLE_NAME, "TABLE_NAME");
      if (!this.isApplicationTable(table)) continue;
      const column = nonEmptyString(row.COLUMN_NAME, "COLUMN_NAME");
      const tableColumns = columns.get(table) ?? new Set<string>();
      tableColumns.add(column);
      columns.set(table, tableColumns);
    }
    return columns;
  }

  private isApplicationTable(table: string): boolean {
    return table.startsWith(String(this.prefix));
  }

  private table(suffix: string): string {
    return quoteIdentifier(`${this.prefix}${suffix}`);
  }
}

/**
 * Transaction facade used only while the caller already owns BEGIN/COMMIT.
 * Nested withTransaction calls deliberately reuse the same SqlExecutor instead
 * of opening or committing another database transaction.
 */
class BoundSessionProvider implements MySqlSessionProvider {
  constructor(private readonly db: SqlExecutor) {}

  async withConnection<T>(work: (connection: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this.db);
  }

  async withTransaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this.db);
  }
}

function normalizeEdge(row: InformationSchemaEdgeRow): OwnershipEdge {
  return {
    childTable: nonEmptyString(row.child_table, "child_table"),
    childColumn: nonEmptyString(row.child_column, "child_column"),
    parentTable: nonEmptyString(row.parent_table, "parent_table"),
    parentColumn: nonEmptyString(row.parent_column, "parent_column"),
  };
}

function requiredId(value: unknown, name: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new DomainValidationError("invalid_id", `${name} must be a positive decimal id.`);
  }
  return normalized;
}

function nonEmptyString(value: unknown, name: string): string {
  const normalized = String(value ?? "").trim();
  if (normalized === "") throw new Error(`${name} must be a non-empty string.`);
  return normalized;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z0-9_$]+$/.test(identifier)) {
    throw new Error("Unsafe database identifier encountered.");
  }
  return `\`${identifier}\``;
}
