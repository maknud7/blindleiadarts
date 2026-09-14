import type { MySqlSessionProvider, QueryResultRow, TablePrefix } from "./contracts.js";

export interface ActivityEventInput extends Record<string, unknown> {}

export class MySqlActivityRuntimeRepository {
  private readonly clubSlugCache = new Map<string, string | null>();

  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
    private readonly identityPrefix: TablePrefix,
  ) {}

  async recordBatch(
    events: ActivityEventInput[],
    userAccountId: string | null,
    authSessionId: string | null,
  ): Promise<number> {
    if (events.length === 0) return 0;
    return this.sessions.withConnection(async (db) => {
      let count = 0;
      for (const event of events.slice(0, 50)) {
        const occurredAt = dateTimeOrNull(event.occurred_at);
        let clubId = positiveIdOrNull(event.club_id);
        if (clubId === null) {
          const clubSlug = nullableText(event.club_slug, 120);
          if (clubSlug !== null) clubId = await this.resolveClubIdBySlug(db, clubSlug);
        }
        const tournamentId = positiveIdOrNull(event.tournament_id);
        const surface = shortText(event.surface ?? "unknown", 32, "unknown");
        const eventName = shortText(event.event_name ?? "event", 64, "event");
        const path = shortText(event.path ?? "/", 255, "/");
        const pageTitle = nullableText(event.page_title, 180);
        const deviceClass = nullableText(event.device_class, 16);
        const referrerHost = nullableText(event.referrer_host, 190);
        const metadata = sanitizeMetadata(event.metadata);
        const metadataJson = Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
        await db.execute(
          `INSERT INTO ${this.table("activity_events")}
            (occurred_at,user_account_id,auth_session_id,club_id,tournament_id,surface,event_name,path,page_title,device_class,referrer_host,metadata_json)
           VALUES (COALESCE(?,NOW()),?,?,?,?,?,?,?,?,?,?,?)`,
          [
            occurredAt,
            userAccountId,
            authSessionId,
            clubId,
            tournamentId,
            surface,
            eventName,
            path,
            pageTitle,
            deviceClass,
            referrerHost,
            metadataJson,
          ],
        );
        count += 1;
      }
      return count;
    });
  }

  async summaryByClub(clubIdInput: unknown, daysInput = 30): Promise<Record<string, unknown>> {
    const clubId = requiredId(clubIdInput, "club_id");
    const days = clampDays(daysInput);
    return this.sessions.withConnection(async (db) => {
      const totals = (await db.query<QueryResultRow>(
        `SELECT COUNT(*) AS events,
                SUM(event_name='page_view') AS page_views,
                COUNT(DISTINCT CASE WHEN user_account_id IS NOT NULL THEN user_account_id END) AS logged_in_users
           FROM ${this.table("activity_events")}
          WHERE club_id=? AND occurred_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)`,
        [clubId],
      ))[0] ?? {};
      const surfaces = await db.query<QueryResultRow>(
        `SELECT surface,COUNT(*) AS events,SUM(event_name='page_view') AS page_views
           FROM ${this.table("activity_events")}
          WHERE club_id=? AND occurred_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
          GROUP BY surface ORDER BY events DESC,surface`,
        [clubId],
      );
      const paths = await db.query<QueryResultRow>(
        `SELECT path,COUNT(*) AS page_views
           FROM ${this.table("activity_events")}
          WHERE club_id=? AND event_name='page_view' AND occurred_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
          GROUP BY path ORDER BY page_views DESC,path LIMIT 20`,
        [clubId],
      );
      const recent = await db.query<QueryResultRow>(
        `SELECT ae.id,ae.occurred_at,ae.user_account_id,ae.auth_session_id,ae.surface,ae.event_name,ae.path,ae.tournament_id,ae.metadata_json,
                ua.display_name,ua.email
           FROM ${this.table("activity_events")} ae
           LEFT JOIN ${this.identityTable("user_accounts")} ua ON ua.id=ae.user_account_id
          WHERE ae.club_id=?
          ORDER BY ae.occurred_at DESC,ae.id DESC LIMIT 100`,
        [clubId],
      );
      return normalizeSummary(days, totals, surfaces, paths, recent, []);
    });
  }

  async summaryAll(daysInput = 30): Promise<Record<string, unknown>> {
    const days = clampDays(daysInput);
    return this.sessions.withConnection(async (db) => {
      const totals = (await db.query<QueryResultRow>(
        `SELECT COUNT(*) AS events,
                SUM(event_name='page_view') AS page_views,
                COUNT(DISTINCT CASE WHEN user_account_id IS NOT NULL THEN user_account_id END) AS logged_in_users
           FROM ${this.table("activity_events")}
          WHERE occurred_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)`,
      ))[0] ?? {};
      const surfaces = await db.query<QueryResultRow>(
        `SELECT surface,COUNT(*) AS events,SUM(event_name='page_view') AS page_views
           FROM ${this.table("activity_events")}
          WHERE occurred_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
          GROUP BY surface ORDER BY events DESC,surface`,
      );
      const paths = await db.query<QueryResultRow>(
        `SELECT path,COUNT(*) AS page_views
           FROM ${this.table("activity_events")}
          WHERE event_name='page_view' AND occurred_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
          GROUP BY path ORDER BY page_views DESC,path LIMIT 30`,
      );
      const recent = await db.query<QueryResultRow>(
        `SELECT ae.id,ae.occurred_at,ae.user_account_id,ae.auth_session_id,ae.club_id,ae.surface,ae.event_name,ae.path,ae.tournament_id,ae.metadata_json,
                ua.display_name,ua.email,c.name AS club_name
           FROM ${this.table("activity_events")} ae
           LEFT JOIN ${this.identityTable("user_accounts")} ua ON ua.id=ae.user_account_id
           LEFT JOIN ${this.table("clubs")} c ON c.id=ae.club_id
          ORDER BY ae.occurred_at DESC,ae.id DESC LIMIT 150`,
      );
      const clubs = await db.query<QueryResultRow>(
        `SELECT ae.club_id,c.name AS club_name,COUNT(*) AS events,SUM(ae.event_name='page_view') AS page_views
           FROM ${this.table("activity_events")} ae
           LEFT JOIN ${this.table("clubs")} c ON c.id=ae.club_id
          WHERE ae.occurred_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
          GROUP BY ae.club_id,c.name ORDER BY events DESC`,
      );
      return normalizeSummary(days, totals, surfaces, paths, recent, clubs);
    });
  }

  private async resolveClubIdBySlug(db: { query<T extends QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<T[]> }, slugInput: string): Promise<string | null> {
    const slug = slugInput.trim().toLocaleLowerCase("nb-NO");
    if (slug === "") return null;
    if (this.clubSlugCache.has(slug)) return this.clubSlugCache.get(slug) ?? null;
    const rows = await db.query<QueryResultRow>(`SELECT id FROM ${this.table("clubs")} WHERE slug=? LIMIT 1`, [slug]);
    const id = positiveIdOrNull(rows[0]?.id);
    this.clubSlugCache.set(slug, id);
    return id;
  }

  private table(name: string): string {
    if (!/^[a-z0-9_]+$/.test(name)) throw new TypeError("Invalid activity table name.");
    return `\`${this.runtimePrefix}${name}\``;
  }

  private identityTable(name: string): string {
    if (!/^[a-z0-9_]+$/.test(name)) throw new TypeError("Invalid identity table name.");
    return `\`${this.identityPrefix}${name}\``;
  }
}

function normalizeSummary(
  days: number,
  totals: QueryResultRow,
  surfaces: QueryResultRow[],
  paths: QueryResultRow[],
  recent: QueryResultRow[],
  clubs: QueryResultRow[],
): Record<string, unknown> {
  return {
    days,
    totals: {
      events: integer(totals.events),
      page_views: integer(totals.page_views),
      logged_in_users: integer(totals.logged_in_users),
    },
    surfaces: surfaces.map((row) => ({ ...row, events: integer(row.events), page_views: integer(row.page_views) })),
    top_paths: paths.map((row) => ({ ...row, page_views: integer(row.page_views) })),
    recent: recent.map((row) => ({
      ...row,
      id: publicId(row.id),
      user_account_id: publicId(row.user_account_id),
      auth_session_id: publicId(row.auth_session_id),
      ...(Object.prototype.hasOwnProperty.call(row, "club_id") ? { club_id: publicId(row.club_id) } : {}),
      tournament_id: publicId(row.tournament_id),
      metadata: parseMetadata(row.metadata_json),
      metadata_json: undefined,
    })),
    clubs: clubs.map((row) => ({
      ...row,
      club_id: publicId(row.club_id),
      events: integer(row.events),
      page_views: integer(row.page_views),
    })),
  };
}

function parseMetadata(value: unknown): Record<string, unknown> {
  const raw = String(value ?? "").trim();
  if (raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function sanitizeMetadata(value: unknown): Record<string, boolean | number | string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const allowed = [
    "element_id","element_tag","action","href_path","portal_view","status","source",
    "endpoint","method","http_status","error_code","error_message","elapsed_ms","timeout","phase","module",
    "source_file","line","column","stack","resource_type","severity","fingerprint",
  ];
  const clean: Record<string, boolean | number | string> = {};
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const item = input[key];
    if (typeof item === "boolean" || typeof item === "number") clean[key] = item;
    else if (typeof item === "string") clean[key] = item.slice(0, key === "stack" ? 1400 : 300);
  }
  return clean;
}

function clampDays(value: unknown): number {
  const parsed = Math.trunc(Number(value ?? 30));
  return Math.max(1, Math.min(365, Number.isFinite(parsed) ? parsed : 30));
}

function dateTimeOrNull(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 19).replace("T", " ");
}

function shortText(value: unknown, maxLength: number, fallback: string): string {
  const normalized = String(value ?? "").trim() || fallback;
  return [...normalized].slice(0, maxLength).join("");
}

function nullableText(value: unknown, maxLength: number): string | null {
  const normalized = String(value ?? "").trim();
  return normalized === "" ? null : [...normalized].slice(0, maxLength).join("");
}

function positiveIdOrNull(value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const normalized = String(value).trim();
  if (/^[1-9][0-9]*$/.test(normalized)) return normalized;
  const parsed = Math.trunc(Number(normalized));
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : null;
}

function requiredId(value: unknown, name: string): string {
  const id = positiveIdOrNull(value);
  if (id === null) throw new TypeError(`${name} must be a positive decimal id.`);
  return id;
}

function publicId(value: unknown): number | string | null {
  const id = positiveIdOrNull(value);
  if (id === null) return null;
  const parsed = Number(id);
  return Number.isSafeInteger(parsed) ? parsed : id;
}

function integer(value: unknown): number {
  const parsed = Math.trunc(Number(value ?? 0));
  return Number.isFinite(parsed) ? parsed : 0;
}
