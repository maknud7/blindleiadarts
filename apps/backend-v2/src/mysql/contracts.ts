import type { DbId } from "../contracts/scoring.js";

export type TablePrefix = string & { readonly __brand: "TablePrefix" };

export interface TablePrefixes {
  runtime: TablePrefix;
  identity: TablePrefix;
  hardware: TablePrefix;
}

export interface QueryResultRow {
  readonly [column: string]: unknown;
}

export interface SqlExecutor {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<readonly T[]>;

  execute(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ affectedRows: number; insertId?: DbId }>;
}

/**
 * Owns admission to one of the deliberately scarce hosted MySQL connections.
 * Implementations must not assume a conventional large Node pool is available.
 */
export interface MySqlSessionProvider {
  withConnection<T>(work: (connection: SqlExecutor) => Promise<T>): Promise<T>;
  withTransaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T>;
}

export interface MySqlConnectionBudget {
  /** Explicit; there is intentionally no backend-v2 default pool size. */
  maxConcurrentConnections: number;
  acquireTimeoutMs: number;
  slotStart?: number;
}

export function asTablePrefix(value: string): TablePrefix {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new TypeError("Invalid database table prefix.");
  }
  return value as TablePrefix;
}

export function validateConnectionBudget(budget: MySqlConnectionBudget): MySqlConnectionBudget {
  if (!Number.isInteger(budget.maxConcurrentConnections) || budget.maxConcurrentConnections <= 0) {
    throw new TypeError("MySQL maxConcurrentConnections must be a positive integer.");
  }
  if (!Number.isInteger(budget.acquireTimeoutMs) || budget.acquireTimeoutMs <= 0) {
    throw new TypeError("MySQL acquireTimeoutMs must be a positive integer.");
  }
  if (budget.slotStart !== undefined && (!Number.isInteger(budget.slotStart) || budget.slotStart < 0)) {
    throw new TypeError("MySQL slotStart must be a non-negative integer.");
  }
  return budget;
}
