export interface ScoliaRealtimePublisherOptions {
  readonly publishUrl: string | null;
  readonly publishSecret: string | null;
  readonly timeoutMs?: number;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class ScoliaRealtimePublisher {
  private readonly publishUrl: string | null;
  private readonly publishSecret: string | null;
  private readonly timeoutMs: number;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    options: ScoliaRealtimePublisherOptions,
    private readonly fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  ) {
    this.publishUrl = nonEmpty(options.publishUrl);
    this.publishSecret = nonEmpty(options.publishSecret);
    this.timeoutMs = Math.min(1_000, options.timeoutMs ?? 750);
  }

  publishInput(kioskCodeInput: unknown, payload: Record<string, unknown>): Promise<void> {
    const kioskCode = String(kioskCodeInput ?? "").trim();
    if (!kioskCode || this.publishUrl === null || this.publishSecret === null) return Promise.resolve();

    const previous = this.tails.get(kioskCode) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.publish(kioskCode, payload))
      .catch((error) => {
        console.warn("scolia realtime publish failed", {
          kiosk_code: kioskCode,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.tails.get(kioskCode) === next) this.tails.delete(kioskCode);
      });
    this.tails.set(kioskCode, next);
    return next;
  }

  private async publish(kioskCode: string, payload: Record<string, unknown>): Promise<void> {
    if (this.publishUrl === null || this.publishSecret === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.publishUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          secret: this.publishSecret,
          channels: [`kiosk:${kioskCode}`],
          event: "scolia_input",
          payload,
        }),
        signal: controller.signal,
      });
      await response.arrayBuffer();
      if (!response.ok) throw new Error(`Realtime relay returned HTTP ${response.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function nonEmpty(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}
