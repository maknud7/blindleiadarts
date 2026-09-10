import {
  createConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";

import { asDbId } from "../contracts/scoring.js";
import type {
  MySqlConnectionBudget,
  MySqlSessionProvider,
  QueryResultRow,
  SqlExecutor,
} from "./contracts.js";

type PromiseConnection = Awaited<ReturnType<typeof createConnection>>;
export type MySqlConnectionReuse = "per-work" | "idle-reuse";

export interface MySql2SessionOptions {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  connectTimeoutMs: number;
  budget: MySqlConnectionBudget;
  writable: boolean;
  connectionReuse?: MySqlConnectionReuse;
  idleConnectionTimeoutMs?: number;
}

/**
 * Small, explicit connection provider for the hosted MySQL account.
 *
 * This is deliberately not a mysql2 pool. In normal runtime mode backend-v2
 * serializes all work through one admitted slot and reuses that one physical
 * connection for a short idle window. That mirrors PHP's request-scoped reuse
 * much more closely than opening a new TCP/MySQL handshake for every repository
 * method, while still returning the hosted DB slot when backend-v2 is idle.
 *
 * `per-work` remains available for one-off tools/fixtures. `idle-reuse` requires
 * a one-connection budget by design; raising concurrency must be an explicit
 * architecture change rather than silently becoming a pool.
 */
export class MySql2SessionProvider implements MySqlSessionProvider {
  private readonly admission: ConnectionAdmission;
  private readonly reuse: MySqlConnectionReuse;
  private readonly idleConnectionTimeoutMs: number;
  private reusableConnection: PromiseConnection | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: MySql2SessionOptions) {
    this.admission = new ConnectionAdmission(
      options.budget.maxConcurrentConnections,
      options.budget.acquireTimeoutMs,
    );
    this.reuse = options.connectionReuse ?? "per-work";
    this.idleConnectionTimeoutMs = options.idleConnectionTimeoutMs ?? 15_000;

    if (this.reuse === "idle-reuse" && options.budget.maxConcurrentConnections !== 1) {
      throw new TypeError("idle-reuse requires exactly one backend-v2 MySQL connection slot.");
    }
    if (!Number.isSafeInteger(this.idleConnectionTimeoutMs) || this.idleConnectionTimeoutMs < 250) {
      throw new TypeError("idleConnectionTimeoutMs must be a safe integer of at least 250 ms.");
    }
  }

  async withConnection<T>(work: (connection: SqlExecutor) => Promise<T>): Promise<T> {
    return this.withPhysicalConnection(async (connection) => {
      const executor = new MySql2Executor(connection, this.options.writable);
      return work(executor);
    });
  }

  async withTransaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    if (!this.options.writable) {
      throw new Error("Backend v2 MySQL provider is read-only; transactions with writes are disabled.");
    }

    return this.withPhysicalConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const result = await work(new MySql2Executor(connection, true));
        await connection.commit();
        return result;
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          // Preserve the original mutation error. A broken connection is invalidated below.
        }
        throw error;
      }
    });
  }

  /** Close any reused physical connection, normally during graceful shutdown. */
  async close(): Promise<void> {
    this.clearIdleTimer();
    const connection = this.reusableConnection;
    this.reusableConnection = null;
    if (connection !== null) {
      await closeConnection(connection);
    }
  }

  private async withPhysicalConnection<T>(work: (connection: PromiseConnection) => Promise<T>): Promise<T> {
    const release = await this.admission.acquire();
    let connection: PromiseConnection | null = null;
    try {
      this.clearIdleTimer();
      connection = await this.connectionForWork();
      return await work(connection);
    } catch (error) {
      if (connection !== null && isConnectionFailure(error)) {
        await this.invalidateReusableConnection(connection);
      }
      // Never auto-retry a unit of work: after a network error a mutation may
      // have reached MySQL even if the client did not receive its result.
      throw error;
    } finally {
      if (connection !== null) {
        if (this.reuse === "per-work") {
          await closeConnection(connection);
        } else if (this.reusableConnection === connection) {
          this.scheduleIdleClose(connection);
        }
      }
      release();
    }
  }

  private async connectionForWork(): Promise<PromiseConnection> {
    if (this.reuse === "idle-reuse" && this.reusableConnection !== null) {
      return this.reusableConnection;
    }

    const connection = await createConnection({
      host: this.options.host,
      port: this.options.port,
      database: this.options.database,
      user: this.options.username,
      password: this.options.password,
      charset: "utf8mb4",
      connectTimeout: this.options.connectTimeoutMs,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      rowsAsArray: false,
    });

    if (this.reuse === "idle-reuse") {
      this.reusableConnection = connection;
    }
    return connection;
  }

  private scheduleIdleClose(connection: PromiseConnection): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.reusableConnection !== connection) return;
      this.reusableConnection = null;
      void closeConnection(connection);
    }, this.idleConnectionTimeoutMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async invalidateReusableConnection(connection: PromiseConnection): Promise<void> {
    if (this.reusableConnection === connection) {
      this.reusableConnection = null;
      this.clearIdleTimer();
    }
    await closeConnection(connection);
  }
}

class MySql2Executor implements SqlExecutor {
  constructor(
    private readonly connection: PromiseConnection,
    private readonly writable: boolean,
  ) {}

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<readonly T[]> {
    if (!isReadStatement(sql)) {
      throw new Error("SqlExecutor.query only permits SELECT/SHOW/EXPLAIN statements.");
    }
    const values = Array.from(params) as any[];
    const [rows] = await this.connection.execute<RowDataPacket[]>(sql, values);
    if (!Array.isArray(rows)) {
      throw new Error("MySQL query did not return row data.");
    }
    return rows as unknown as readonly T[];
  }

  async execute(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ affectedRows: number; insertId?: ReturnType<typeof asDbId> }> {
    if (!this.writable) {
      throw new Error("Backend v2 MySQL executor is read-only.");
    }
    if (isMultiStatement(sql)) {
      throw new Error("Backend v2 MySQL executor does not permit multiple statements.");
    }

    const values = Array.from(params) as any[];
    const [result] = await this.connection.execute<ResultSetHeader>(sql, values);
    const response: { affectedRows: number; insertId?: ReturnType<typeof asDbId> } = {
      affectedRows: result.affectedRows,
    };

    const rawInsertId = result.insertId as unknown;
    if (typeof rawInsertId === "number" && rawInsertId > 0) {
      if (!Number.isSafeInteger(rawInsertId)) {
        throw new Error("MySQL insertId exceeded JavaScript safe integer precision.");
      }
      response.insertId = asDbId(String(rawInsertId));
    } else if (typeof rawInsertId === "string" && rawInsertId !== "" && rawInsertId !== "0") {
      response.insertId = asDbId(rawInsertId);
    }
    return response;
  }
}

class ConnectionAdmission {
  private active = 0;
  private readonly waiting: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(
    private readonly limit: number,
    private readonly timeoutMs: number,
  ) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return this.releaseFactory();
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new Error(`Backend v2 database connection capacity remained busy for ${this.timeoutMs} ms.`));
        }, this.timeoutMs),
      };
      this.waiting.push(waiter);
    });
  }

  private releaseFactory(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(this.releaseFactory());
        return;
      }
      this.active -= 1;
    };
  }
}

async function closeConnection(connection: PromiseConnection): Promise<void> {
  try {
    await connection.end();
  } catch {
    connection.destroy();
  }
}

function isConnectionFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  return [
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "EPIPE",
    "PROTOCOL_CONNECTION_LOST",
  ].includes(code);
}

function isReadStatement(sql: string): boolean {
  const normalized = sql.trimStart().toUpperCase();
  return normalized.startsWith("SELECT ") || normalized.startsWith("SHOW ") || normalized.startsWith("EXPLAIN ");
}

function isMultiStatement(sql: string): boolean {
  const trimmed = sql.trim();
  const withoutTrailingSemicolon = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
  return withoutTrailingSemicolon.includes(";");
}
