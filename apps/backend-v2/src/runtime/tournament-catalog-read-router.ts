import type { MySqlTournamentCatalogReadRepository } from "../mysql/tournament-catalog-read-repository.js";

export interface TournamentCatalogReadRouteResult {
  statusCode: number;
  payload: Record<string, unknown>;
}

export class TournamentCatalogReadRouter {
  constructor(private readonly catalog: MySqlTournamentCatalogReadRepository) {}

  async handle(method: string, path: string): Promise<TournamentCatalogReadRouteResult | null> {
    if (method !== "GET") return null;

    const clubList = /^\/v1\/clubs\/([1-9][0-9]*)\/tournaments$/.exec(path);
    if (clubList) {
      const clubId = clubList[1]!;
      return ok({ club_id: clubId, items: await this.catalog.listByClubId(clubId) });
    }

    const matches = /^\/v1\/tournaments\/([1-9][0-9]*)\/matches$/.exec(path);
    if (matches) {
      const tournamentId = matches[1]!;
      return ok({ tournament_id: tournamentId, items: await this.catalog.listMatches(tournamentId) });
    }

    const detail = /^\/v1\/tournaments\/([1-9][0-9]*)$/.exec(path);
    if (detail) {
      const tournament = await this.catalog.findDetail(detail[1]!);
      if (tournament === null) {
        return {
          statusCode: 404,
          payload: { ok: false, error: { code: "tournament_not_found", message: "Tournament was not found." } },
        };
      }
      return ok({ tournament });
    }

    return null;
  }
}

function ok(payload: Record<string, unknown>): TournamentCatalogReadRouteResult {
  return { statusCode: 200, payload: { ok: true, ...payload } };
}
