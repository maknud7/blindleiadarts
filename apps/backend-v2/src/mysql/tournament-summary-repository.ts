import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, TablePrefix } from "./contracts.js";

interface SummaryRow extends QueryResultRow {
  readonly id?: unknown;
  readonly tournament_id?: unknown;
  readonly title?: unknown;
  readonly body_text?: unknown;
  readonly status?: unknown;
  readonly published_at?: unknown;
  readonly created_at?: unknown;
  readonly updated_at?: unknown;
  readonly club_id?: unknown;
  readonly tournament_name?: unknown;
  readonly start_at?: unknown;
}

export class MySqlTournamentSummaryRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly prefix: TablePrefix,
  ) {}

  async getTournamentSummary(tournamentIdInput: unknown, includeDraft: boolean): Promise<Record<string, unknown> | null> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<SummaryRow>(
        `SELECT s.id,s.tournament_id,s.title,s.body_text,s.status,s.published_at,s.created_at,s.updated_at,
                t.club_id,t.name AS tournament_name,t.start_at
           FROM \`${this.prefix}tournament_summaries\` s
           INNER JOIN \`${this.prefix}tournaments\` t ON t.id=s.tournament_id
          WHERE s.tournament_id=? ${includeDraft ? "" : "AND s.status='published'"}
          LIMIT 1`,
        [tournamentId],
      );
      return rows[0] ? publicSummary(rows[0]) : null;
    });
  }

  async saveTournamentSummary(
    tournamentIdInput: unknown,
    payload: Record<string, unknown>,
    userIdInput: unknown,
  ): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    const userId = requiredId(userIdInput, "user_account_id");
    const title = String(payload.title ?? "").trim();
    const body = String(payload.body_text ?? "").trim();
    const status = String(payload.status ?? "draft").trim().toLowerCase();

    if (title === "" || body === "") {
      throw new DomainValidationError("summary_content_required", "Summary title and text are required.", 422);
    }
    if (status !== "draft" && status !== "published") {
      throw new DomainValidationError("invalid_summary_status", "Summary status must be draft or published.", 422);
    }

    await this.sessions.withTransaction(async (db) => {
      const tournamentRows = await db.query<QueryResultRow>(
        `SELECT id FROM \`${this.prefix}tournaments\` WHERE id=? LIMIT 1 FOR UPDATE`,
        [tournamentId],
      );
      if (!tournamentRows[0]) {
        throw new DomainValidationError("tournament_not_found", "Tournament was not found.", 404);
      }

      const publishedAt = status === "published" ? mysqlDateTime(new Date()) : null;
      await db.execute(
        `INSERT INTO \`${this.prefix}tournament_summaries\`
          (tournament_id,title,body_text,status,published_at,created_by_user_account_id,updated_by_user_account_id)
         VALUES (?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           title=VALUES(title),
           body_text=VALUES(body_text),
           status=VALUES(status),
           published_at=CASE
             WHEN VALUES(status)='published' THEN COALESCE(published_at,VALUES(published_at))
             ELSE NULL
           END,
           updated_by_user_account_id=VALUES(updated_by_user_account_id),
           updated_at=NOW()`,
        [tournamentId, title, body, status, publishedAt, userId, userId],
      );
    });

    return (await this.getTournamentSummary(tournamentId, true)) ?? {};
  }
}

function publicSummary(row: SummaryRow): Record<string, unknown> {
  return {
    ...row,
    id: publicId(row.id),
    tournament_id: publicId(row.tournament_id),
    club_id: publicId(row.club_id),
  };
}

function requiredId(value: unknown, name: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new DomainValidationError("invalid_id", `${name} must be a positive decimal id.`, 400);
  }
  return normalized;
}

function publicId(value: unknown): number | string | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) return normalized;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : normalized;
}

function mysqlDateTime(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}
