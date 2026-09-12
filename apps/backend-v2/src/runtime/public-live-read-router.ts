import type { IncomingMessage } from "node:http";

import type { MySqlPublicLiveReadRepository } from "../mysql/public-live-read-repository.js";

export interface PublicLiveRouteResult {
  readonly statusCode: number;
  readonly payload: Record<string, unknown>;
}

export class PublicLiveReadRouter {
  constructor(private readonly reads: MySqlPublicLiveReadRepository) {}

  async handle(
    method: string,
    publicPath: string,
    request: IncomingMessage,
  ): Promise<PublicLiveRouteResult | null> {
    if (method !== "GET") return null;

    const clubLive = /^\/v1\/public\/clubs\/([^/]+)\/live$/.exec(publicPath);
    if (clubLive) {
      const clubSlug = decodeURIComponent(clubLive[1] ?? "");
      const live = await this.reads.liveByClubSlug(clubSlug);
      return live === null
        ? {
            statusCode: 404,
            payload: {
              ok: false,
              error: {
                code: "live_tournament_not_found",
                message: "No current tournament was found for this club.",
              },
            },
          }
        : { statusCode: 200, payload: { ok: true, ...live } };
    }

    const tournamentLive = /^\/v1\/public\/tournaments\/([1-9][0-9]*)\/live$/.exec(publicPath);
    if (tournamentLive) {
      const live = await this.reads.liveByTournamentId(tournamentLive[1]);
      return live === null
        ? {
            statusCode: 404,
            payload: {
              ok: false,
              error: { code: "tournament_not_found", message: "Tournament was not found." },
            },
          }
        : { statusCode: 200, payload: { ok: true, ...live } };
    }

    if (publicPath === "/v1/public/check-in-display") {
      const url = new URL(request.url ?? "/", "http://backend-v2.internal");
      const display = await this.reads.publicCheckinDisplay({
        screenToken: url.searchParams.get("screen_token"),
        clubSlug: url.searchParams.get("club_slug"),
      });
      return { statusCode: 200, payload: { ok: true, ...display } };
    }

    return null;
  }
}
