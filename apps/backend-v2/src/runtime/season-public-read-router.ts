import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSeasonPublicReadRepository } from "../mysql/season-public-read-repository.js";

export interface SeasonPublicReadRouteResult {
  statusCode: number;
  payload: Record<string, unknown>;
}

export class SeasonPublicReadRouter {
  constructor(private readonly seasons: MySqlSeasonPublicReadRepository) {}

  async handle(method: string, path: string): Promise<SeasonPublicReadRouteResult | null> {
    if (method !== "GET") return null;

    if (path === "/v1/clubs") {
      return ok({ items: await this.seasons.listClubs() });
    }

    const directoryMatch = /^\/v1\/clubs\/([1-9][0-9]*)\/player-directory$/.exec(path);
    if (directoryMatch) {
      const clubId = requiredCapture(directoryMatch, 1);
      return ok({ club_id: publicId(clubId), items: await this.seasons.listPlayerDirectory(clubId) });
    }

    const eloMatch = /^\/v1\/clubs\/([1-9][0-9]*)\/elo$/.exec(path);
    if (eloMatch) {
      const clubId = requiredCapture(eloMatch, 1);
      return ok({ club_id: publicId(clubId), items: await this.seasons.listEloTable(clubId) });
    }

    const matchesMatch = /^\/v1\/players\/([1-9][0-9]*)\/matches$/.exec(path);
    if (matchesMatch) {
      const playerId = requiredCapture(matchesMatch, 1);
      const items = await this.seasons.listPlayerMatches(playerId, 200);
      if (items === null) {
        throw new DomainValidationError("player_not_found", "Player was not found.", 404);
      }
      return ok({ player_id: publicId(playerId), items });
    }

    const listMatch = /^\/v1\/clubs\/([1-9][0-9]*)\/seasons$/.exec(path);
    if (listMatch) {
      const clubId = requiredCapture(listMatch, 1);
      return ok({ club_id: publicId(clubId), items: await this.seasons.listByClub(clubId) });
    }

    const seasonMatch = /^\/v1\/seasons\/([1-9][0-9]*)$/.exec(path);
    if (seasonMatch) {
      const seasonId = requiredCapture(seasonMatch, 1);
      const season = await this.seasons.find(seasonId);
      if (season === null) throw seasonNotFound();
      return ok({ season });
    }

    const standingsMatch = /^\/v1\/seasons\/([1-9][0-9]*)\/standings$/.exec(path);
    if (standingsMatch) {
      const seasonId = requiredCapture(standingsMatch, 1);
      const result = await this.seasons.standings(seasonId);
      if (result === null) throw seasonNotFound();
      return ok(result);
    }

    return null;
  }
}

function seasonNotFound(): DomainValidationError {
  return new DomainValidationError("season_not_found", "Sesongen ble ikke funnet.", 404);
}

function requiredCapture(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new TypeError("Route parameter is missing.");
  return value;
}

function publicId(value: string): number | string {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

function ok(payload: Record<string, unknown>): SeasonPublicReadRouteResult {
  return { statusCode: 200, payload: { ok: true, ...payload } };
}
