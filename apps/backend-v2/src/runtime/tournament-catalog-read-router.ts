import type { MySqlTournamentCatalogReadRepository } from "../mysql/tournament-catalog-read-repository.js";

export interface TournamentCatalogReadRouteResult {
  statusCode: number;
  payload: Record<string, unknown>;
}

export class TournamentCatalogReadRouter {
  constructor(private readonly catalog: MySqlTournamentCatalogReadRepository) {}

  async handle(method: string, path: string): Promise<TournamentCatalogReadRouteResult | null> {
    if (method !== "GET") return null;

    const clubDashboard = /^\/v1\/clubs\/([1-9][0-9]*)\/dashboard$/.exec(path);
    if (clubDashboard) {
      const dashboard = await this.catalog.getClubDashboard(clubDashboard[1]!);
      if (dashboard === null) {
        return {
          statusCode: 404,
          payload: { ok: false, error: { code: "club_not_found", message: "Club was not found." } },
        };
      }
      return ok(dashboard);
    }

    const clubPlayers = /^\/v1\/clubs\/([1-9][0-9]*)\/players$/.exec(path);
    if (clubPlayers) {
      const clubId = clubPlayers[1]!;
      return ok({ club_id: clubId, items: await this.catalog.listClubPlayers(clubId) });
    }

    const clubElo = /^\/v1\/clubs\/([1-9][0-9]*)\/elo$/.exec(path);
    if (clubElo) {
      const clubId = clubElo[1]!;
      return ok({ club_id: clubId, items: await this.catalog.listClubElo(clubId) });
    }

    const clubList = /^\/v1\/clubs\/([1-9][0-9]*)\/tournaments$/.exec(path);
    if (clubList) {
      const clubId = clubList[1]!;
      return ok({ club_id: clubId, items: await this.catalog.listByClubId(clubId) });
    }

    const eloSettings = /^\/v1\/tournaments\/([1-9][0-9]*)\/elo-settings$/.exec(path);
    if (eloSettings) {
      const tournament = await this.catalog.getTournamentEloSetting(eloSettings[1]!);
      if (tournament === null) {
        return {
          statusCode: 404,
          payload: { ok: false, error: { code: "tournament_not_found", message: "Tournament was not found." } },
        };
      }
      return ok({ tournament });
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