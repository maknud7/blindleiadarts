import { DomainValidationError } from "../domain/errors.js";
import type { MySqlClubPlayerReadRepository } from "../mysql/club-player-read-repository.js";
import { RuntimeAccessError } from "./config.js";

export interface ClubPlayerReadRouteResult {
  statusCode: number;
  payload: Record<string, unknown>;
}

export class ClubPlayerReadRouter {
  constructor(private readonly reads: MySqlClubPlayerReadRepository) {}

  async handle(method: string, path: string): Promise<ClubPlayerReadRouteResult | null> {
    if (method !== "GET") return null;

    if (path === "/v1/clubs") {
      return ok({ items: await this.reads.listClubs() });
    }

    const directoryMatch = /^\/v1\/clubs\/([1-9][0-9]*)\/player-directory$/.exec(path);
    if (directoryMatch) {
      const clubId = requiredCapture(directoryMatch, 1);
      return ok({ club_id: publicId(clubId), items: await this.reads.listPlayerDirectory(clubId) });
    }

    const eloMatch = /^\/v1\/clubs\/([1-9][0-9]*)\/elo$/.exec(path);
    if (eloMatch) {
      const clubId = requiredCapture(eloMatch, 1);
      return ok({ club_id: publicId(clubId), items: await this.reads.listEloTable(clubId) });
    }

    const matchesMatch = /^\/v1\/players\/([1-9][0-9]*)\/matches$/.exec(path);
    if (matchesMatch) {
      const playerId = requiredCapture(matchesMatch, 1);
      const items = await this.reads.listPlayerMatches(playerId, 200);
      if (items === null) {
        throw new DomainValidationError("player_not_found", "Player was not found.", 404);
      }
      return ok({ player_id: publicId(playerId), items });
    }

    return null;
  }
}

function requiredCapture(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new RuntimeAccessError(400, "invalid_route", "Route parameter is missing.");
  return value;
}

function publicId(value: string): number | string {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

function ok(payload: Record<string, unknown>): ClubPlayerReadRouteResult {
  return { statusCode: 200, payload: { ok: true, ...payload } };
}
