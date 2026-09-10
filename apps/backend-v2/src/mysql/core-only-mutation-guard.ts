import type { DbId } from "../contracts/scoring.js";
import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, TablePrefix } from "./contracts.js";

export type CoreOnlyMutation = "start" | "visit" | "undo";

interface EligibilityRow extends QueryResultRow {
  readonly tournament_slug: unknown;
  readonly season_id: unknown;
  readonly tournament_group_id: unknown;
  readonly planned_tournament_format: unknown;
  readonly planned_auto_create_playoff: unknown;
  readonly is_playoff: unknown;
}

/**
 * Temporary fail-closed gate for the period where canonical scoring storage is
 * migrated but its post-mutation side effects are not yet implemented in Node.
 *
 * test-write is intentionally limited to fixtures created by the backend-v2 E2E
 * harness. This prevents a developer from pointing the internal endpoint at an
 * ordinary TEST tournament and producing correct visits but stale ELO/playoff/
 * projection/realtime state.
 */
export class MySqlCoreOnlyMutationGuard {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
  ) {}

  async assertAllowed(kioskId: DbId, mutation: CoreOnlyMutation): Promise<void> {
    await this.sessions.withConnection(async (sql) => {
      const statuses = mutation === "undo"
        ? '("in_progress","assigned","completed")'
        : '("in_progress","assigned")';
      const rows = await sql.query<EligibilityRow>(
        `SELECT t.slug AS tournament_slug,
                t.season_id,
                m.tournament_group_id,
                t.planned_tournament_format,
                t.planned_auto_create_playoff,
                EXISTS(
                  SELECT 1 FROM ${this.table("tournament_playoff_nodes")} pn
                  WHERE pn.match_id=m.id
                ) AS is_playoff
         FROM ${this.table("matches")} m
         INNER JOIN ${this.table("tournaments")} t ON t.id=m.tournament_id
         WHERE m.kiosk_id=? AND m.status IN ${statuses}
         ORDER BY FIELD(m.status,"in_progress","assigned","completed"),
                  CASE WHEN m.status="completed" THEN m.id END DESC,
                  CASE WHEN m.status<>"completed" THEN m.id END ASC
         LIMIT 1`,
        [kioskId],
      );
      const row = rows[0];
      if (!row) return;

      const slug = stringValue(row.tournament_slug);
      const isE2eFixture = slug.startsWith("backend-v2-e2e-tournament-");
      const hasSeason = row.season_id !== null && row.season_id !== undefined;
      const isPlayoff = integerValue(row.is_playoff, "is_playoff") === 1;
      const mayAutoCreatePlayoff =
        row.tournament_group_id !== null &&
        row.tournament_group_id !== undefined &&
        stringValue(row.planned_tournament_format) === "groups_playoff" &&
        integerValue(row.planned_auto_create_playoff ?? 0, "planned_auto_create_playoff") === 1;

      if (!isE2eFixture || hasSeason || isPlayoff || mayAutoCreatePlayoff) {
        throw new DomainValidationError(
          "backend_v2_side_effects_not_ready",
          "Backend v2 scoring writes are limited to isolated E2E fixtures until canonical side effects are migrated.",
          409,
        );
      }
    });
  }

  private table(name: "matches" | "tournaments" | "tournament_playoff_nodes"): string {
    return `\`${this.runtimePrefix}${name}\``;
  }
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function integerValue(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    throw new TypeError(`${field} must be an integer-compatible MySQL value.`);
  }
  return parsed;
}
