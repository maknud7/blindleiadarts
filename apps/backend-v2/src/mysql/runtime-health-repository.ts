import type { MySqlSessionProvider, QueryResultRow, TablePrefix } from "./contracts.js";

interface HealthDiagnostic {
  readonly name: string;
  readonly label: string;
  readonly status: "ok" | "warn" | "fail";
  readonly ms: number;
  readonly detail: Record<string, unknown> | null;
}

interface MeasuredResult {
  readonly ok: boolean;
  readonly detail: Record<string, unknown> | null;
}

export interface DeepHealthResult {
  readonly ok: boolean;
  readonly service: "blindleiadarts";
  readonly app_env: string;
  readonly mode: "deep";
  readonly generated_at: string;
  readonly duration_ms: number;
  readonly release: {
    readonly environment: string;
    readonly sha: string;
  };
  readonly checks: {
    readonly database: boolean;
    readonly core_schema: boolean;
    readonly member_registry: boolean;
  };
  readonly member_registry: {
    readonly source: "local_primary_database" | "unavailable";
  };
  readonly diagnostics: readonly HealthDiagnostic[];
}

/**
 * Read-only operational diagnostics used by the admin health tracker.
 *
 * TEST reads runtime state from bd_test_ and shared identity from bd_prod_.
 * No diagnostic may touch hardware or perform a repair/write as a side effect.
 */
export class MySqlRuntimeHealthRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
    private readonly identityPrefix: TablePrefix,
  ) {}

  async ping(): Promise<boolean> {
    try {
      return await this.sessions.withConnection(async (db) => {
        const rows = await db.query<QueryResultRow>("SELECT 1 AS ok");
        return Number(rows[0]?.ok ?? 0) === 1;
      });
    } catch {
      return false;
    }
  }

  async deep(environment: string, releaseSha: string): Promise<DeepHealthResult> {
    const startedAt = Date.now();
    const diagnostics: HealthDiagnostic[] = [];

    const measure = async (
      name: string,
      label: string,
      warnAfterMs: number,
      work: () => Promise<Record<string, unknown> | null>,
    ): Promise<MeasuredResult> => {
      const started = Date.now();
      try {
        const raw = await work();
        const elapsed = Date.now() - started;
        const detail = raw === null ? null : { ...raw };
        let semantic: "ok" | "warn" | null = null;
        if (detail && (detail.__health_status === "ok" || detail.__health_status === "warn")) {
          semantic = detail.__health_status;
          delete detail.__health_status;
        }
        diagnostics.push({
          name,
          label,
          status: semantic ?? (elapsed >= warnAfterMs ? "warn" : "ok"),
          ms: elapsed,
          detail,
        });
        return { ok: true, detail };
      } catch (error) {
        const elapsed = Date.now() - started;
        diagnostics.push({
          name,
          label,
          status: "fail",
          ms: elapsed,
          detail: {
            error: environment === "prod"
              ? "check_failed"
              : error instanceof Error ? error.message : "check_failed",
          },
        });
        return { ok: false, detail: null };
      }
    };

    const database = await measure("database", "Databaseforbindelse", 1000, async () => {
      const rows = await this.sessions.withConnection((db) => db.query<QueryResultRow>("SELECT 1 AS ok"));
      if (Number(rows[0]?.ok ?? 0) !== 1) throw new Error("Database probe failed.");
      return null;
    });

    const core = await measure("core_schema", "Kjerneschema", 500, async () => {
      if (!(await this.tableExists(`${this.runtimePrefix}clubs`))) {
        throw new Error("Core clubs table is missing.");
      }
      return { ready: true };
    });

    const memberRegistry = await measure("member_registry", "Medlemsregister", 750, async () => {
      if (!(await this.tableExists("medlemmer"))) {
        throw new Error("Member registry connection is unavailable.");
      }
      return { source: "local_primary_database" };
    });

    await measure("membership_lookup", "Medlemskap og kontingent", 1500, async () => {
      if (!(await this.tableExists("medlemmer"))) {
        throw new Error("medlemmer table is missing.");
      }
      const members = await this.sessions.withConnection((db) => db.query<QueryResultRow>(
        "SELECT id, medlemsnummer FROM `medlemmer` ORDER BY id ASC LIMIT 1",
      ));
      const member = members[0];
      if (!member) return { sample: false, payments_checked: false };

      const memberNumber = integer(member.medlemsnummer);
      let paymentsChecked = false;
      if (memberNumber > 0 && await this.tableExists("kontingentbetalinger")) {
        await this.sessions.withConnection((db) => db.query<QueryResultRow>(
          "SELECT dato, periode, belop, kilde FROM `kontingentbetalinger` WHERE medlemsnummer=? ORDER BY dato DESC, id DESC LIMIT 24",
          [memberNumber],
        ));
        paymentsChecked = true;
      }
      return { sample: true, payments_checked: paymentsChecked };
    });

    await measure("critical_indexes", "Kritiske databaseindekser", 750, async () => {
      const sessionsTable = `${this.identityPrefix}auth_sessions`;
      const sessionIndex = await this.tableExists(sessionsTable)
        && await this.indexOnColumnExists(sessionsTable, "session_token_hash");
      const paymentTableExists = await this.tableExists("kontingentbetalinger");
      const paymentIndex = !paymentTableExists
        || await this.indexOnColumnExists("kontingentbetalinger", "medlemsnummer");
      if (!sessionIndex || !paymentIndex) throw new Error("A critical lookup index is missing.");
      return {
        auth_session_token: sessionIndex,
        membership_number: paymentIndex,
      };
    });

    await measure("stale_tournament_state", "Gamle turneringer merket aktive", 750, async () => {
      const rows = await this.sessions.withConnection((db) => db.query<QueryResultRow>(
        `SELECT t.id,t.name,t.status,t.start_at
           FROM \`${this.runtimePrefix}tournaments\` t
          WHERE t.status IN ('ready','in_progress')
            AND t.start_at IS NOT NULL
            AND t.start_at < DATE_SUB(NOW(), INTERVAL 18 HOUR)
            AND (t.end_at IS NULL OR t.end_at < NOW())
            AND NOT EXISTS (
              SELECT 1 FROM \`${this.runtimePrefix}matches\` m
               WHERE m.tournament_id=t.id AND m.status IN ('assigned','in_progress')
            )
          ORDER BY t.start_at ASC
          LIMIT 10`,
      ));
      return {
        __health_status: rows.length === 0 ? "ok" : "warn",
        count: rows.length,
        sample: rows[0]?.name ?? null,
        sample_start_at: rows[0]?.start_at ?? null,
      };
    });

    await measure("stale_player_checkin", "Gamle innsjekkinger står fortsatt aktive", 750, async () => {
      const rows = await this.sessions.withConnection((db) => db.query<QueryResultRow>(
        `SELECT tp.player_id,p.display_name,t.id AS tournament_id,t.name AS tournament_name,
                t.status AS tournament_status,t.start_at,tp.status AS registration_status
           FROM \`${this.runtimePrefix}tournament_players\` tp
           INNER JOIN \`${this.runtimePrefix}tournaments\` t ON t.id=tp.tournament_id
           INNER JOIN \`${this.runtimePrefix}players\` p ON p.id=tp.player_id
          WHERE tp.status IN ('checked_in','paused')
            AND (
              t.status IN ('completed','cancelled')
              OR (
                t.start_at IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM \`${this.runtimePrefix}matches\` m0
                   WHERE m0.tournament_id=t.id
                     AND (m0.player_a_id=tp.player_id OR m0.player_b_id=tp.player_id)
                     AND m0.status IN ('assigned','in_progress')
                )
              )
              OR (
                t.start_at IS NOT NULL
                AND t.start_at < DATE_SUB(NOW(), INTERVAL 18 HOUR)
                AND (t.end_at IS NULL OR t.end_at < NOW())
                AND NOT EXISTS (
                  SELECT 1 FROM \`${this.runtimePrefix}matches\` m1
                   WHERE m1.tournament_id=t.id
                     AND (m1.player_a_id=tp.player_id OR m1.player_b_id=tp.player_id)
                     AND m1.status IN ('assigned','in_progress')
                )
              )
            )
          ORDER BY COALESCE(t.start_at,'1000-01-01') ASC,t.id ASC,p.display_name ASC
          LIMIT 10`,
      ));
      return {
        __health_status: rows.length === 0 ? "ok" : "warn",
        count: rows.length,
        sample_player: rows[0]?.display_name ?? null,
        sample_tournament: rows[0]?.tournament_name ?? null,
        sample_start_at: rows[0]?.start_at ?? null,
        sample_tournament_status: rows[0]?.tournament_status ?? null,
        sample_registration_status: rows[0]?.registration_status ?? null,
      };
    });

    let samplePlayerId: string | null = null;
    await measure("player_profile", "Spillerprofil", 1500, async () => {
      const players = await this.sessions.withConnection((db) => db.query<QueryResultRow>(
        `SELECT p.id
           FROM \`${this.runtimePrefix}players\` p
          WHERE p.is_active=1
          ORDER BY EXISTS(
            SELECT 1 FROM \`${this.runtimePrefix}matches\` m
             WHERE m.status='completed' AND (m.player_a_id=p.id OR m.player_b_id=p.id)
          ) DESC,p.id ASC
          LIMIT 1`,
      ));
      samplePlayerId = decimalId(players[0]?.id);
      if (samplePlayerId === null) return { sample: false };
      const counts = await this.sessions.withConnection((db) => db.query<QueryResultRow>(
        `SELECT COUNT(*) AS cnt FROM \`${this.runtimePrefix}matches\`
          WHERE status='completed' AND (player_a_id=? OR player_b_id=?)`,
        [samplePlayerId, samplePlayerId],
      ));
      return { sample: true, matches: integer(counts[0]?.cnt) };
    });

    await measure("player_matches", "Kamphistorikk", 1500, async () => {
      if (samplePlayerId === null) return { sample: false, count: 0 };
      const rows = await this.sessions.withConnection((db) => db.query<QueryResultRow>(
        `SELECT id FROM \`${this.runtimePrefix}matches\`
          WHERE player_a_id=? OR player_b_id=?
          ORDER BY COALESCE(finished_at,starts_at,created_at) DESC,id DESC
          LIMIT 20`,
        [samplePlayerId, samplePlayerId],
      ));
      return { sample: true, count: rows.length };
    });

    await measure("member_dashboard", "Innlogget Min side-dashboard", 1500, async () => {
      const users = await this.sessions.withConnection((db) => db.query<QueryResultRow>(
        `SELECT id,player_id FROM \`${this.identityPrefix}user_accounts\`
          WHERE is_active=1 AND account_status='active'
          ORDER BY CASE WHEN player_id IS NULL THEN 1 ELSE 0 END ASC,id ASC
          LIMIT 1`,
      ));
      const user = users[0];
      if (!user) return { sample: false };
      const playerId = decimalId(user.player_id);
      let registrations = 0;
      if (playerId !== null) {
        const rows = await this.sessions.withConnection((db) => db.query<QueryResultRow>(
          `SELECT COUNT(*) AS cnt FROM \`${this.runtimePrefix}tournament_players\` WHERE player_id=?`,
          [playerId],
        ));
        registrations = integer(rows[0]?.cnt);
      }
      return { sample: true, available: true, registrations };
    });

    const hasFailure = diagnostics.some((item) => item.status === "fail");
    const memberSource = memberRegistry.ok ? "local_primary_database" : "unavailable";
    return {
      ok: database.ok && core.ok && memberRegistry.ok && !hasFailure,
      service: "blindleiadarts",
      app_env: environment,
      mode: "deep",
      generated_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      release: { environment, sha: releaseSha },
      checks: {
        database: database.ok,
        core_schema: core.ok,
        member_registry: memberRegistry.ok,
      },
      member_registry: { source: memberSource },
      diagnostics,
    };
  }

  private async tableExists(table: string): Promise<boolean> {
    const rows = await this.sessions.withConnection((db) => db.query<QueryResultRow>(
      "SELECT COUNT(*) AS cnt FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?",
      [table],
    ));
    return integer(rows[0]?.cnt) === 1;
  }

  private async indexOnColumnExists(table: string, column: string): Promise<boolean> {
    const rows = await this.sessions.withConnection((db) => db.query<QueryResultRow>(
      "SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?",
      [table, column],
    ));
    return integer(rows[0]?.cnt) > 0;
  }
}

function integer(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function decimalId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}
