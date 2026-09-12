import type { IncomingMessage } from "node:http";

import { DomainValidationError } from "../domain/errors.js";
import type { MySqlIdentityAuthRepository, IdentityUser } from "../mysql/identity-auth-repository.js";
import type { MySqlPlayerLiveReadRepository } from "../mysql/player-live-read-repository.js";
import { RuntimeAccessError, type BackendRuntimeConfig } from "./config.js";

export interface PlayerLiveReadRouteResult {
  statusCode: number;
  payload: Record<string, unknown>;
}

export class PlayerLiveReadRouter {
  constructor(
    private readonly config: BackendRuntimeConfig,
    private readonly identity: MySqlIdentityAuthRepository,
    private readonly reads: MySqlPlayerLiveReadRepository,
  ) {}

  async handle(method: string, path: string, request: IncomingMessage): Promise<PlayerLiveReadRouteResult | null> {
    if (method !== "GET") return null;

    if (path === "/v1/realtime/config") {
      const websocketUrl = this.config.realtime.websocketUrl ?? "";
      return ok({
        enabled: websocketUrl !== "",
        transport: websocketUrl !== "" ? "websocket" : "sse",
        websocket_url: websocketUrl,
      });
    }

    if (path === "/v1/me/dashboard") {
      const user = await this.requireUser(request);
      return ok({
        user: formatPublicUser(user),
        dashboard: await this.reads.memberDashboard(user),
      });
    }

    const profileMatch = /^\/v1\/players\/([1-9][0-9]*)\/profile$/.exec(path);
    if (profileMatch) {
      const profile = await this.reads.playerProfile(requiredCapture(profileMatch, 1));
      if (profile === null) {
        throw new DomainValidationError("player_not_found", "Player was not found.", 404);
      }
      return ok(profile);
    }

    const tournamentEloMatch = /^\/v1\/players\/([1-9][0-9]*)\/elo-tournaments$/.exec(path);
    if (tournamentEloMatch) {
      const history = await this.reads.playerTournamentElo(requiredCapture(tournamentEloMatch, 1));
      if (history === null) {
        throw new DomainValidationError("player_not_found", "Player was not found.", 404);
      }
      return ok(history);
    }

    const highlightsMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/live-highlights$/.exec(path);
    if (highlightsMatch) {
      const highlights = await this.reads.liveHighlights(requiredCapture(highlightsMatch, 1));
      if (highlights === null) {
        throw new DomainValidationError("tournament_not_found", "Tournament was not found.", 404);
      }
      return ok(highlights);
    }

    return null;
  }

  private async requireUser(request: IncomingMessage): Promise<IdentityUser> {
    const token = bearerToken(request);
    if (token === null) {
      throw new RuntimeAccessError(401, "authentication_required", "Authentication is required.");
    }
    // Player/public/live is a GET-only surface. Never refresh/touch the canonical
    // identity session from this router, even when the backend is in prod-canary.
    const user = await this.identity.findBySessionToken(token, false);
    if (user === null) {
      throw new RuntimeAccessError(401, "invalid_session", "Session is invalid or expired.");
    }
    return user;
  }
}

function requiredCapture(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new RuntimeAccessError(400, "invalid_route", "Route parameter is missing.");
  return value;
}

function bearerToken(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  const authorization = Array.isArray(value) ? value[0] : value;
  const match = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? "");
  const token = match?.[1]?.trim() ?? "";
  return token === "" ? null : token;
}

function formatPublicUser(user: IdentityUser): Record<string, unknown> {
  return {
    id: publicId(user.id),
    email: user.email,
    username: user.email,
    display_name: user.display_name,
    role: user.role,
    is_active: Number(user.is_active ?? 0),
    account_status: user.account_status,
    contact_phone: user.contact_phone,
    player: user.player_id === null ? null : {
      id: publicId(user.player_id),
      display_name: user.player_display_name,
      club_id: publicId(user.player_club_id),
      member_id: publicId(user.member_id),
    },
    admin_club_ids: user.admin_club_ids,
    global_roles: user.global_roles,
  };
}

function publicId(value: unknown): number | string | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) return normalized;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : normalized;
}

function ok(payload: Record<string, unknown>): PlayerLiveReadRouteResult {
  return { statusCode: 200, payload: { ok: true, ...payload } };
}
