import type { IncomingMessage } from "node:http";

import { DomainValidationError } from "../domain/errors.js";
import type { MySqlAccountProfileRepository } from "../mysql/account-profile-repository.js";
import type { MySqlIdentityAuthRepository, IdentityUser } from "../mysql/identity-auth-repository.js";
import type { MySqlMembershipEligibilityRepository } from "../mysql/membership-eligibility-repository.js";
import type { MySqlTournamentRuntimeRepository } from "../mysql/tournament-runtime-repository.js";
import {
  assertMutationAllowed,
  mutationsAllowed,
  RuntimeAccessError,
  type BackendRuntimeConfig,
} from "./config.js";

export interface TournamentRouteResult {
  statusCode: number;
  payload: Record<string, unknown>;
}

export class TournamentRuntimeRouter {
  constructor(
    private readonly config: BackendRuntimeConfig,
    private readonly identityRepository: MySqlIdentityAuthRepository,
    private readonly accountProfiles: MySqlAccountProfileRepository,
    private readonly membership: MySqlMembershipEligibilityRepository,
    private readonly tournaments: MySqlTournamentRuntimeRepository,
  ) {}

  async handle(method: string, path: string, request: IncomingMessage): Promise<TournamentRouteResult | null> {
    const listMatch = /^\/v1\/clubs\/([1-9][0-9]*)\/registration-tournaments$/.exec(path);
    if (method === "GET" && listMatch) {
      return ok({
        club_id: publicId(listMatch[1]),
        items: await this.tournaments.listRegistrationTournamentsByClubId(listMatch[1]),
      });
    }

    const groupsMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/groups$/.exec(path);
    if (method === "GET" && groupsMatch) {
      return ok(await this.tournaments.getGroups(groupsMatch[1]));
    }

    const settingsMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/registration-settings$/.exec(path);
    if ((method === "PUT" || method === "PATCH") && settingsMatch) {
      assertMutationAllowed(this.config);
      const tournament = await this.requireTournament(settingsMatch[1]);
      const user = await this.requireUser(request);
      this.requireAdmin(user, requiredId(tournament.club_id, "club_id"));
      const body = await readJsonObject(request);
      return ok({ tournament: await this.tournaments.updateRegistrationSettings(settingsMatch[1], body) });
    }

    const selfRegistrationMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/register$/.exec(path);
    if (method === "POST" && selfRegistrationMatch) {
      assertMutationAllowed(this.config);
      const user = await this.requireUser(request);
      const playerId = requiredPlayerId(user);
      const eligibility = await this.membership.forPlayer(playerId);
      eligibility.payment_options = await this.accountProfiles.publicPaymentOptions(
        eligibility.club_id,
        eligibility.member_id,
      );
      if (eligibility.can_register !== true) {
        throw new DomainValidationError(
          "membership_payment_required",
          typeof eligibility.message === "string"
            ? eligibility.message
            : "Kontingenten må ordnes før du kan melde deg på nye turneringer.",
          403,
        );
      }
      const registration = await this.tournaments.registerPlayer(selfRegistrationMatch[1], playerId, "player");
      return ok({ registration, eligibility }, 201);
    }

    if (method === "DELETE" && selfRegistrationMatch) {
      assertMutationAllowed(this.config);
      const user = await this.requireUser(request);
      const playerId = requiredPlayerId(user);
      return ok({ registration: await this.tournaments.withdrawPlayer(selfRegistrationMatch[1], playerId) });
    }

    const checkInMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/check-in$/.exec(path);
    if (method === "POST" && checkInMatch) {
      assertMutationAllowed(this.config);
      const user = await this.requireUser(request);
      const playerId = requiredPlayerId(user);
      return ok({ registration: await this.tournaments.checkInPlayer(checkInMatch[1], playerId) });
    }

    const adminRegistrationsMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/registrations$/.exec(path);
    if (method === "POST" && adminRegistrationsMatch) {
      assertMutationAllowed(this.config);
      const tournament = await this.requireTournament(adminRegistrationsMatch[1]);
      const user = await this.requireUser(request);
      this.requireAdmin(user, requiredId(tournament.club_id, "club_id"));
      const body = await readJsonObject(request);
      const playerId = requiredId(body.player_id, "player_id");
      return ok(
        { registration: await this.tournaments.registerPlayer(adminRegistrationsMatch[1], playerId, "admin") },
        201,
      );
    }

    const adminWithdrawMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/registrations\/([1-9][0-9]*)$/.exec(path);
    if (method === "DELETE" && adminWithdrawMatch) {
      assertMutationAllowed(this.config);
      const tournament = await this.requireTournament(adminWithdrawMatch[1]);
      const user = await this.requireUser(request);
      this.requireAdmin(user, requiredId(tournament.club_id, "club_id"));
      return ok({
        registration: await this.tournaments.withdrawPlayer(adminWithdrawMatch[1], adminWithdrawMatch[2]),
      });
    }

    return null;
  }

  private async requireTournament(tournamentId: string): Promise<Record<string, unknown>> {
    const tournament = await this.tournaments.findTournament(tournamentId);
    if (tournament === null) {
      throw new DomainValidationError("tournament_not_found", "Tournament was not found.", 404);
    }
    return tournament;
  }

  private async requireUser(request: IncomingMessage): Promise<IdentityUser> {
    const token = bearerToken(request);
    if (token === null) throw new RuntimeAccessError(401, "authentication_required", "Authentication is required.");
    const user = await this.identityRepository.findBySessionToken(token, this.identityTouchAllowed());
    if (user === null) throw new RuntimeAccessError(401, "invalid_session", "Session is invalid or expired.");
    return user;
  }

  private requireAdmin(user: IdentityUser, clubId: string): void {
    const role = String(user.role ?? "");
    if (role === "super_admin") return;
    if (role !== "club_admin") {
      throw new RuntimeAccessError(403, "admin_required", "Club administrator access is required.");
    }
    const clubIds = new Set(
      String(user.admin_club_ids ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => /^[1-9][0-9]*$/.test(value)),
    );
    if (!clubIds.has(clubId)) {
      throw new RuntimeAccessError(403, "club_access_denied", "You cannot manage this club.");
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
      "This account is not linked to a player profile.",
    );
  }
  return playerId;
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

function publicId(value: string): number | string {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
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

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 65_536) {
      throw new RuntimeAccessError(413, "request_too_large", "Backend v2 request body exceeds 64 KiB.");
    }
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new RuntimeAccessError(400, "invalid_json", "Request body must contain valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RuntimeAccessError(400, "invalid_json_object", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function ok(payload: Record<string, unknown>, statusCode = 200): TournamentRouteResult {
  return { statusCode, payload: { ok: true, ...payload } };
}
