import type { DbId } from "../contracts/scoring.js";
import type { MySqlSessionProvider, QueryResultRow, TablePrefix } from "../mysql/contracts.js";
import type { CanonicalRealtimePort } from "../service/canonical-scoring-service.js";

export interface CanonicalRealtimePublisherOptions {
  readonly publishUrl: string | null;
  readonly publishSecret: string | null;
  readonly timeoutMs?: number;
}

export interface RealtimeWarningLogger {
  warn(message: string, details?: Record<string, unknown>): void;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface KioskRealtimeRow extends QueryResultRow {
  readonly code?: unknown;
  readonly club_id?: unknown;
}

/**
 * Best-effort realtime refresh publisher for canonical scoring.
 *
 * The wire shape mirrors PHP CanonicalScoringService: one kiosk lookup, the
 * `kiosk:<code>` and `club:<id>` channels, a `snapshot` event and the canonical
 * refresh payload. Unlike the legacy implementation, the complete adapter is
 * fail-open after a scoring commit: neither the lookup nor the HTTP relay may
 * turn a successful canonical mutation into a client-visible failure/retry.
 */
export class CanonicalRealtimePublisher implements CanonicalRealtimePort {
  private readonly publishUrl: string | null;
  private readonly publishSecret: string | null;
  private readonly timeoutMs: number;

  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
    options: CanonicalRealtimePublisherOptions,
    private readonly fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
    private readonly logger: RealtimeWarningLogger | null = null,
  ) {
    this.publishUrl = nonEmpty(options.publishUrl);
    this.publishSecret = nonEmpty(options.publishSecret);
    this.timeoutMs = options.timeoutMs ?? 1_500;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 10_000) {
      throw new TypeError("Canonical realtime timeout must be a positive safe integer no greater than 10000 ms.");
    }
  }

  async publishRefresh(input: Parameters<CanonicalRealtimePort["publishRefresh"]>[0]): Promise<void> {
    if (this.publishUrl === null || this.publishSecret === null) return;

    try {
      const channels = await this.channelsForKiosk(input.kiosk_id);
      if (channels.length === 0) return;

      await this.publish(channels, {
        refresh: true,
        reason: input.reason,
        source: input.source,
        kiosk_id: input.kiosk_id,
        match_id: input.match_id,
      });
    } catch (error) {
      // Canonical scoring is already committed when this port runs. Realtime is
      // recoverable by the next snapshot and must never make clients retry a write.
      this.logger?.warn("backend-v2 realtime publish failed", {
        reason: input.reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async channelsForKiosk(kioskId: DbId): Promise<readonly string[]> {
    return this.sessions.withConnection(async (sql) => {
      const rows = await sql.query<KioskRealtimeRow>(
        `SELECT code, club_id FROM \`${this.runtimePrefix}kiosks\` WHERE id=? LIMIT 1`,
        [kioskId],
      );
      const row = rows[0];
      if (!row) return [];

      const channels: string[] = [];
      const code = stringValue(row.code).trim();
      const clubId = positiveDecimalId(row.club_id);
      if (code !== "") channels.push(`kiosk:${code}`);
      if (clubId !== null) channels.push(`club:${clubId}`);
      return channels;
    });
  }

  private async publish(channels: readonly string[], payload: Record<string, unknown>): Promise<void> {
    if (this.publishUrl === null || this.publishSecret === null) return;

    const controller = new AbortController();
    // Do not unref this timer. It is the authoritative upper bound for a relay
    // exchange, including in short-lived workers where no other handle is active.
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.publishUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          secret: this.publishSecret,
          channels,
          event: "snapshot",
          payload,
        }),
        signal: controller.signal,
      });
      // Drain the response so the timeout covers the whole relay exchange and
      // the underlying HTTP connection can be released deterministically.
      await response.arrayBuffer();
    } finally {
      clearTimeout(timer);
    }
  }
}

function nonEmpty(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function positiveDecimalId(value: unknown): string | null {
  const candidate = stringValue(value).trim();
  if (!/^[1-9][0-9]*$/.test(candidate)) return null;
  return candidate;
}
