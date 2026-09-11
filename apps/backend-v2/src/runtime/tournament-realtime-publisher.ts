export interface TournamentRealtimeOptions {
  publishUrl: string | null;
  publishSecret: string | null;
  timeoutMs: number;
}

export class TournamentRealtimePublisher {
  constructor(
    private readonly options: TournamentRealtimeOptions,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  ) {}

  async publishClubRefresh(clubId: string, reason: string): Promise<void> {
    const publishUrl = this.options.publishUrl?.trim() ?? "";
    const publishSecret = this.options.publishSecret?.trim() ?? "";
    if (publishUrl === "" || publishSecret === "") return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.fetchImpl(publishUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          secret: publishSecret,
          channels: [`club:${clubId}`],
          event: "snapshot",
          payload: { refresh: true, reason, club_id: clubId },
        }),
        signal: controller.signal,
      });
      await response.arrayBuffer();
    } catch (error) {
      console.warn("backend-v2 tournament realtime publish failed", {
        club_id: clubId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
