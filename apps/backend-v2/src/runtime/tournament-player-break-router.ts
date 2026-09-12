import type { IncomingMessage } from "node:http";

import { DomainValidationError } from "../domain/errors.js";
import type { IdentityUser, MySqlIdentityAuthRepository } from "../mysql/identity-auth-repository.js";
import type { MySqlTournamentAttendanceRepository } from "../mysql/tournament-attendance-repository.js";
import { PLAYER_BREAK_MINUTES, type MySqlTournamentPlayerBreakRepository } from "../mysql/tournament-player-break-repository.js";
import {
  assertMutationAllowed,
  mutationsAllowed,
  RuntimeAccessError,
  type BackendRuntimeConfig,
} from "./config.js";

export interface TournamentPlayerBreakRouteResult {
  statusCode: number;
  payload: Record<string, unknown>;
}

export class TournamentPlayerBreakRouter {
  constructor(
    private readonly config: BackendRuntimeConfig,
    private readonly identityRepository: MySqlIdentityAuthRepository,
    private readonly breaks: MySqlTournamentPlayerBreakRepository,
    private readonly attendance: MySqlTournamentAttendanceRepository,
  ) {}

  async handle(method: string, path: string, request: IncomingMessage): Promise<TournamentPlayerBreakRouteResult | null> {
    const breakMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/me\/break$/.exec(path);
    if (breakMatch && (method === "GET" || method === "POST")) {
      const user = await this.requireUser(request);
      const playerId = requiredPlayerId(user);
      assertMutationAllowed(this.config);
      const tournamentId = requiredCapture(breakMatch, 1);
      if (method === "GET") {
        return ok({
          break: await this.breaks.getStatus(tournamentId, playerId),
          break_minutes: PLAYER_BREAK_MINUTES,
        });
      }
      return ok({ break: await this.breaks.requestBreak(tournamentId, playerId) }, 201);
    }

    if (method === "GET" && path === "/v1/me/break-context") {
      const user = await this.requireUser(request);
      const playerId = requiredPlayerId(user);
      assertMutationAllowed(this.config);
      return ok({
        context: await this.breaks.findContext(playerId),
        break_minutes: PLAYER_BREAK_MINUTES,
      });
    }

    const operationsMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/operations(?:\/reconcile)?$/.exec(path);
    const needsNormalization =
      operationsMatch !== null &&
      (method === "GET" || (method === "POST" && path.endsWith("/reconcile")));
    if (needsNormalization && operationsMatch !== null) {
      const tournamentId = requiredCapture(operationsMatch, 1);
      const tournament = await this.attendance.findTournament(tournamentId);
      if (tournament === null) {
        throw new DomainValidationError("tournament_not_found", "Turneringen ble ikke funnet.", 404);
      }
      const user = await this.requireUser(request);
      this.requireAdmin(user, requiredId(tournament.club_id, "club_id"));
      assertMutationAllowed(this.config);
      await this.breaks.normalizeTournament(tournamentId);
      return null;
    }

    return null;
  }

  private async requireUser(request: IncomingMessage): Promise<IdentityUser> {
    const token = bearerToken(request);
    if (token === null) {
      throw new RuntimeAccessError(401, "authentication_required", "Du må være logget inn for å bruke spillerpause.");
    }
    const user = await this.identityRepository.findBySessionToken(token, this.identityTouchAllowed());
    if (user === null) {
      throw new RuntimeAccessError(401, "invalid_session", "Innloggingen er utløpt eller ugyldig.");
    }
    return user;
  }

  private requireAdmin(user: IdentityUser, clubId: string): void {
    const role = String(user.role ?? "");
    if (role === "super_admin") return;
    if (role !== "club_admin") {
      throw new RuntimeAccessError(403, "admin_required", "Admin-tilgang kreves.");
    }
    const clubIds = new Set(
      String(user.admin_club_ids ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => /^[1-9][0-9]*$/.test(value)),
    );
    if (!clubIds.has(clubId)) {
      throw new RuntimeAccessError(403, "club_access_denied", "Du kan ikke administrere denne klubben.");
    }
  }

  private identityTouchAllowed(): boolean {
    return (
      (this.config.environment === "prod" && this.config.prefixes.identity === "bd_prod_" && mutationsAllowed(this.config)) ||
      (this.config.environment === "test" && this.config.prefixes.identity === "bd_test_" && mutationsAllowed(this.config))
    );
  }
}

function requiredPlayerId(user: IdentityUser): string {
  const playerId = decimalId(user.player_id);
  if (playerId === null) {
    throw new DomainValidationError(
      "player_profile_missing",
      "Kontoen er ikke koblet til en spillerprofil.",
      422,
    );
  }
  return playerId;
}

function requiredCapture(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new RuntimeAccessError(400, "invalid_route", "Route parameter is missing.");
  return value;
}

function requiredId(value: unknown, name: string): string {
  const id = decimalId(value);
  if (id === null) throw new DomainValidationError("invalid_id", `${name} must be a positive decimal id.`, 400);
  return id;
}

function decimalId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = header(request, "authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const token = match?.[1]?.trim() ?? "";
  return token === "" ? null : token;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function ok(payload: Record<string, unknown>, statusCode = 200): TournamentPlayerBreakRouteResult {
  return { statusCode, payload: { ok: true, ...payload } };
}
