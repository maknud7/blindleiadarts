import type { IncomingMessage } from "node:http";

import { DomainValidationError } from "../domain/errors.js";
import type { MySqlIdentityAuthRepository, IdentityUser } from "../mysql/identity-auth-repository.js";
import type { MySqlTournamentAttendanceRepository } from "../mysql/tournament-attendance-repository.js";
import type { MySqlTournamentFlowRepository } from "../mysql/tournament-flow-repository.js";
import {
  assertMutationAllowed,
  mutationsAllowed,
  RuntimeAccessError,
  type BackendRuntimeConfig,
} from "./config.js";

export interface TournamentAttendanceRouteResult {
  statusCode: number;
  payload: Record<string, unknown>;
}

export class TournamentAttendanceRouter {
  constructor(
    private readonly config: BackendRuntimeConfig,
    private readonly identityRepository: MySqlIdentityAuthRepository,
    private readonly attendance: MySqlTournamentAttendanceRepository,
    private readonly tournamentFlow: MySqlTournamentFlowRepository,
  ) {}

  async handle(method: string, path: string, request: IncomingMessage): Promise<TournamentAttendanceRouteResult | null> {
    const statusMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/check-in-status$/.exec(path);
    if (method === "GET" && statusMatch) {
      const user = await this.requireUser(request);
      const playerId = requiredPlayerId(user);
      return ok(await this.attendance.statusForPlayer(requiredCapture(statusMatch, 1), playerId));
    }

    const clubSettingsMatch = /^\/v1\/clubs\/([1-9][0-9]*)\/checkin-settings$/.exec(path);
    if (clubSettingsMatch && (method === "GET" || method === "PUT" || method === "PATCH")) {
      const clubId = requiredCapture(clubSettingsMatch, 1);
      const user = await this.requireUser(request);
      this.requireAdmin(user, clubId);
      if (method === "GET") return ok({ settings: await this.attendance.getClubSettings(clubId) });
      assertMutationAllowed(this.config);
      return ok({
        settings: await this.attendance.updateClubSettings(
          clubId,
          await readJsonObject(request),
          requiredId(user.id, "user_id"),
        ),
      });
    }

    const tournamentSettingsMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/checkin-settings$/.exec(path);
    if (tournamentSettingsMatch && (method === "GET" || method === "PUT" || method === "PATCH")) {
      const tournamentId = requiredCapture(tournamentSettingsMatch, 1);
      const settings = await this.requireTournamentSettings(tournamentId);
      const user = await this.requireUser(request);
      this.requireAdmin(user, requiredId(settings.club_id, "club_id"));
      if (method === "GET") return ok({ settings });
      assertMutationAllowed(this.config);
      return ok({
        settings: await this.attendance.updateTournamentSettings(tournamentId, await readJsonObject(request)),
      });
    }

    const rotateMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/checkin-code\/rotate$/.exec(path);
    if (method === "POST" && rotateMatch) {
      assertMutationAllowed(this.config);
      const tournamentId = requiredCapture(rotateMatch, 1);
      const settings = await this.requireTournamentSettings(tournamentId);
      const user = await this.requireUser(request);
      this.requireAdmin(user, requiredId(settings.club_id, "club_id"));
      return ok({ settings: await this.attendance.rotateTournamentCode(tournamentId) });
    }

    const adminCheckinMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/admin-check-in\/([1-9][0-9]*)$/.exec(path);
    if (adminCheckinMatch && (method === "POST" || method === "DELETE")) {
      assertMutationAllowed(this.config);
      const tournamentId = requiredCapture(adminCheckinMatch, 1);
      const playerId = requiredCapture(adminCheckinMatch, 2);
      const settings = await this.requireTournamentSettings(tournamentId);
      const user = await this.requireUser(request);
      this.requireAdmin(user, requiredId(settings.club_id, "club_id"));
      return ok({
        registration: method === "POST"
          ? await this.attendance.adminCheckIn(tournamentId, playerId)
          : await this.attendance.adminCheckOut(tournamentId, playerId),
      });
    }

    const guestMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/registrations\/guest$/.exec(path);
    if (method === "POST" && guestMatch) {
      assertMutationAllowed(this.config);
      const tournamentId = requiredCapture(guestMatch, 1);
      const settings = await this.requireTournamentSettings(tournamentId);
      const user = await this.requireUser(request);
      this.requireAdmin(user, requiredId(settings.club_id, "club_id"));
      return ok({
        registration: await this.attendance.addGuest(tournamentId, await readJsonObject(request)),
      }, 201);
    }

    const checkInMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/check-in$/.exec(path);
    if (method === "POST" && checkInMatch) {
      assertMutationAllowed(this.config);
      const tournamentId = requiredCapture(checkInMatch, 1);
      const user = await this.requireUser(request);
      const playerId = requiredPlayerId(user);
      const body = await readJsonObject(request);
      return ok({
        registration: await this.attendance.checkInPlayer(tournamentId, playerId, body.code),
      });
    }

    const finishMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/finish-checkin$/.exec(path);
    if (method === "POST" && finishMatch) {
      assertMutationAllowed(this.config);
      const tournamentId = requiredCapture(finishMatch, 1);
      const tournament = await this.requireTournament(tournamentId);
      const user = await this.requireUser(request);
      this.requireAdmin(user, requiredId(tournament.club_id, "club_id"));
      return ok({ attendance: await this.attendance.finishCheckin(tournamentId) });
    }

    const startMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/start$/.exec(path);
    if (method === "POST" && startMatch) {
      assertMutationAllowed(this.config);
      const tournamentId = requiredCapture(startMatch, 1);
      const tournament = await this.requireTournament(tournamentId);
      const user = await this.requireUser(request);
      this.requireAdmin(user, requiredId(tournament.club_id, "club_id"));

      let status = String(tournament.status ?? "");
      if (status === "draft") {
        await this.attendance.finishCheckin(tournamentId);
        status = "ready";
      }
      if (status !== "ready" && status !== "in_progress") {
        throw new DomainValidationError(
          "checkin_must_be_finished",
          "Avslutt innsjekken før turneringen startes.",
          409,
        );
      }

      return ok({ start: await this.tournamentFlow.startTournament(tournamentId) });
    }

    return null;
  }

  private async requireTournament(tournamentId: string): Promise<Record<string, unknown>> {
    const tournament = await this.attendance.findTournament(tournamentId);
    if (tournament === null) {
      throw new DomainValidationError("tournament_not_found", "Turneringen ble ikke funnet.", 404);
    }
    return tournament;
  }

  private async requireTournamentSettings(tournamentId: string): Promise<Record<string, unknown>> {
    const settings = await this.attendance.getTournamentSettings(tournamentId);
    if (settings === null) {
      throw new DomainValidationError("tournament_not_found", "Turneringen ble ikke funnet.", 404);
    }
    return settings;
  }

  private async requireUser(request: IncomingMessage): Promise<IdentityUser> {
    const token = bearerToken(request);
    if (token === null) throw new RuntimeAccessError(401, "authentication_required", "Du må logge inn.");
    const user = await this.identityRepository.findBySessionToken(token, this.identityTouchAllowed());
    if (user === null) throw new RuntimeAccessError(401, "invalid_session", "Økten er utløpt eller ugyldig.");
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

function ok(payload: Record<string, unknown>, statusCode = 200): TournamentAttendanceRouteResult {
  return { statusCode, payload: { ok: true, ...payload } };
}
