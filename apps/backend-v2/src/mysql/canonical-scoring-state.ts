import { asDbId, type DbId } from "../contracts/scoring.js";
import type { CanonicalScoringStatePort, StartScoringState } from "../service/canonical-scoring-service.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

interface StartStateRow extends QueryResultRow {
  readonly id: unknown;
  readonly status: unknown;
  readonly has_open_leg: unknown;
}

interface IdRow extends QueryResultRow {
  readonly id: unknown;
}

interface StatusRow extends QueryResultRow {
  readonly status: unknown;
}

/**
 * Read-side state needed by canonical scoring orchestration.
 *
 * These queries intentionally mirror PHP CanonicalScoringService and
 * PlayoffReconciliationService. They use short non-transactional sessions and
 * never acquire a second connection while one is active.
 */
export class MySqlCanonicalScoringState implements CanonicalScoringStatePort {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
  ) {}

  async startState(kioskId: DbId): Promise<StartScoringState | null> {
    return this.sessions.withConnection(async (sql) => {
      const rows = await sql.query<StartStateRow>(
        `SELECT m.id, m.status,
                EXISTS(
                  SELECT 1 FROM ${this.table("legs")} l
                  WHERE l.match_id=m.id AND l.status IN ("pending","in_progress")
                ) AS has_open_leg
         FROM ${this.table("matches")} m
         WHERE m.kiosk_id=? AND m.status IN ("in_progress","assigned")
         ORDER BY FIELD(m.status,"in_progress","assigned"), m.id ASC
         LIMIT 1`,
        [kioskId],
      );
      const row = rows[0];
      if (!row) return null;
      const status = stringValue(row.status);
      if (status !== "assigned" && status !== "in_progress") {
        throw new TypeError(`Unexpected canonical scoring status: ${status}`);
      }
      return {
        id: dbId(row.id, "matches.id"),
        status,
        has_open_leg: integerValue(row.has_open_leg, "has_open_leg") === 1,
      };
    });
  }

  async targetMatchIdForKiosk(kioskId: DbId, includeCompleted: boolean): Promise<DbId | null> {
    return this.sessions.withConnection(async (sql) => {
      const statusFilter = includeCompleted
        ? '("in_progress","assigned","completed")'
        : '("in_progress","assigned")';
      const rows = await sql.query<IdRow>(
        `SELECT id FROM ${this.table("matches")}
         WHERE kiosk_id=? AND status IN ${statusFilter}
         ORDER BY FIELD(status,"in_progress","assigned","completed"),
                  CASE WHEN status="completed" THEN id END DESC,
                  CASE WHEN status<>"completed" THEN id END ASC
         LIMIT 1`,
        [kioskId],
      );
      return rows[0] ? dbId(rows[0].id, "matches.id") : null;
    });
  }

  async matchIsCompleted(matchId: DbId): Promise<boolean> {
    return this.sessions.withConnection(async (sql) => {
      const rows = await sql.query<StatusRow>(
        `SELECT status FROM ${this.table("matches")} WHERE id=? LIMIT 1`,
        [matchId],
      );
      return stringValue(rows[0]?.status) === "completed";
    });
  }

  private table(name: "matches" | "legs"): string {
    return `\`${this.runtimePrefix}${name}\``;
  }
}

function dbId(value: unknown, field: string): DbId {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be returned from MySQL as a decimal string.`);
  }
  return asDbId(value);
}

function integerValue(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    throw new TypeError(`${field} must be an integer-compatible MySQL value.`);
  }
  return parsed;
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

// Keep the executor import type used so this file cannot quietly grow a direct
// mysql2 dependency without the architecture CI noticing.
type StateSqlExecutor = SqlExecutor;
void (0 as unknown as StateSqlExecutor | undefined);
