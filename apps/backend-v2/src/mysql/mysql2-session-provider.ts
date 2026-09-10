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

export interface MySql2SessionOptions {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  connectTimeoutMs: number;
  budget: MySqlConnectionBudget;
  writable: boolean;
}

/**
 * Small, explicit connection provider for the hosted MySQL account.
 *
 * This is deliberately not a mysql2 pool. Each admitted unit of work opens one
 * physical connection, uses it serially, closes it, then releases the local
 * admission slot. PHP can therefore coexist while backend-v2 is introduced.
 */
export class MySql2SessionProvider implements MySqlSessionProvider {
  private readonly admission: ConnectionAdmission;

  constructor(private readonly options: MySql2SessionOptions) {
    this.admission = new ConnectionAdmission(
      options.budget.maxConcurrentConnections,
      options.budget.acquireTimeoutMs,
    );
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
          // Preserve the original mutation error. The connection is closed below.
        }
        throw error;
      }
    });
  }

  private async withPhysicalConnection<T>(work: (connection: PromiseConnection) => Promise<T>): Promise<T> {
    const release = await this.admission.acquire();
    let connection: PromiseConnection | null = null;
    try {
      connection = await createConnection({
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
      return await work(connection);
    } finally {
      if (connection !== null) {
        try {
          await connection.end();
        } catch {
          connection.destroy();
        }
      }
      release();
    }
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
    // mysql2 accepts a mutable values array. Keep readonly/unknown at our domain
    // boundary and adapt only at this driver edge.
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

function isReadStatement(sql: string): boolean {
  const normalized = sql.trimStart().toUpperCase();
  return normalized.startsWith("SELECT ") || normalized.startsWith("SHOW ") || normalized.startsWith("EXPLAIN ");
}

function isMultiStatement(sql: string): boolean {
  const trimmed = sql.trim();
  const withoutTrailingSemicolon = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
  return withoutTrailingSemicolon.includes(";");
}
