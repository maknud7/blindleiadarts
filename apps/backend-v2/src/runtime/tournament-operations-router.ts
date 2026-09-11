import type { IncomingMessage } from "node:http";

import { DomainValidationError } from "../domain/errors.js";
import type { IdentityUser, MySqlIdentityAuthRepository } from "../mysql/identity-auth-repository.js";
import type { MySqlTournamentOperationsRepository } from "../mysql/tournament-operations-repository.js";
import type { MySqlTournamentPlayoffRepository } from "../mysql/tournament-playoff-repository.js";
import {
  assertMutationAllowed,
  mutationsAllowed,
  RuntimeAccessError,
  type BackendRuntimeConfig,
} from "./config.js";
import type { TournamentRealtimePublisher } from "./tournament-realtime-publisher.js";

export interface TournamentOperationsRouteResult {
  statusCode: number;
  payload: Record<string, unknown>;
}

export class TournamentOperationsRouter {
  constructor(
    private readonly config: BackendRuntimeConfig,
    private readonly identityRepository: MySqlIdentityAuthRepository,
    private readonly operations: MySqlTournamentOperationsRepository,
    private readonly playoffs: MySqlTournamentPlayoffRepository,
    private readonly realtime: TournamentRealtimePublisher,
  ) {}

  async handle(method: string, path: string, request: IncomingMessage): Promise<TournamentOperationsRouteResult | null> {
    const operationsMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/operations$/.exec(path);
    if (operationsMatch) {
      const tournamentId = requiredCapture(operationsMatch, 1);
      const tournament = await this.requireTournament(tournamentId);
      await this.requireAdmin(request, requiredId(tournament.club_id, "club_id"));
      if (method === "GET") return ok(await this.operations.snapshot(tournamentId));
      return null;
    }

    const settingsMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/operations\/settings$/.exec(path);
    if ((method === "PUT" || method === "PATCH") && settingsMatch) {
      assertMutationAllowed(this.config);
      const tournamentId = requiredCapture(settingsMatch, 1);
      const tournament = await this.requireTournament(tournamentId);
      const clubId = requiredId(tournament.club_id, "club_id");
      await this.requireAdmin(request, clubId);
      const body = await readJsonObject(request);
      const snapshot = await this.operations.updateAutoAssignEnabled(tournamentId, body.auto_assign_enabled);
      await this.realtime.publishClubRefresh(clubId, "tournament_operations_settings");
      return ok(snapshot);
    }

    const boardsMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/operations\/boards$/.exec(path);
    if (boardsMatch && ["GET", "PUT", "PATCH"].includes(method)) {
      const tournamentId = requiredCapture(boardsMatch, 1);
      const tournament = await this.requireTournament(tournamentId);
      const clubId = requiredId(tournament.club_id, "club_id");
      await this.requireAdmin(request, clubId);
      if (method === "GET") return ok(await this.operations.listBoardSelection(tournamentId));
      assertMutationAllowed(this.config);
      const body = await readJsonObject(request);
      const selection = await this.operations.replaceBoardSelection(tournamentId, body.kiosk_ids);
      await this.realtime.publishClubRefresh(clubId, "tournament_board_selection");
      return ok(selection);
    }

    const reconcileMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/operations\/reconcile$/.exec(path);
    if (method === "POST" && reconcileMatch) {
      assertMutationAllowed(this.config);
      const tournamentId = requiredCapture(reconcileMatch, 1);
      const tournament = await this.requireTournament(tournamentId);
      const clubId = requiredId(tournament.club_id, "club_id");
      await this.requireAdmin(request, clubId);
      const snapshot = await this.operations.reconcileTournament(tournamentId);
      await this.realtime.publishClubRefresh(clubId, "tournament_operations_reconcile");
      return ok(snapshot);
    }

    const moveMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/operations\/matches\/([1-9][0-9]*)\/move$/.exec(path);
    if (method === "POST" && moveMatch) {
      assertMutationAllowed(this.config);
      const tournamentId = requiredCapture(moveMatch, 1);
      const matchId = requiredCapture(moveMatch, 2);
      const tournament = await this.requireTournament(tournamentId);
      const clubId = requiredId(tournament.club_id, "club_id");
      await this.requireAdmin(request, clubId);
      const body = await readJsonObject(request);
      const move = await this.operations.moveMatch(
        tournamentId,
        matchId,
        body.kiosk_id,
        body.confirm_in_progress === true,
      );
      const snapshot = await this.operations.snapshot(tournamentId);
      snapshot.move = move;
      await this.realtime.publishClubRefresh(clubId, "tournament_match_move");
      return ok(snapshot);
    }

    const playoffMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/playoffs$/.exec(path);
    if (method === "GET" && playoffMatch) {
      const tournamentId = requiredCapture(playoffMatch, 1);
      const tournament = await this.requireTournament(tournamentId);
      return ok({ bracket: await this.playoffs.getBracket(tournamentId), tournament });
    }

    const playoffGenerate = /^\/v1\/tournaments\/([1-9][0-9]*)\/playoffs\/generate$/.exec(path);
    if (method === "POST" && playoffGenerate) {
      assertMutationAllowed(this.config);
      const tournamentId = requiredCapture(playoffGenerate, 1);
      const tournament = await this.requireTournament(tournamentId);
      const clubId = requiredId(tournament.club_id, "club_id");
      await this.requireAdmin(request, clubId);
      const body = await readJsonObject(request);
      const bracket = await this.playoffs.generateFromGroups(tournamentId, body.qualifiers_per_group, body.best_of_legs);
      await this.realtime.publishClubRefresh(clubId, "tournament_playoff_generate");
      return ok({ bracket }, 201);
    }

    const playoffReconcile = /^\/v1\/tournaments\/([1-9][0-9]*)\/playoffs\/reconcile$/.exec(path);
    if (method === "POST" && playoffReconcile) {
      assertMutationAllowed(this.config);
      const tournamentId = requiredCapture(playoffReconcile, 1);
      const tournament = await this.requireTournament(tournamentId);
      const clubId = requiredId(tournament.club_id, "club_id");
      await this.requireAdmin(request, clubId);
      const bracket = await this.playoffs.reconcileTournament(tournamentId);
      await this.realtime.publishClubRefresh(clubId, "tournament_playoff_reconcile");
      return ok({ bracket });
    }

    return null;
  }

  private async requireTournament(tournamentId: string): Promise<Record<string, unknown>> {
    const tournament = await this.operations.findTournament(tournamentId);
    if (tournament === null) throw new DomainValidationError("tournament_not_found", "Tournament was not found.", 404);
    return tournament;
  }

  private async requireAdmin(request: IncomingMessage, clubId: string): Promise<IdentityUser> {
    const token = bearerToken(request);
    if (token === null) throw new RuntimeAccessError(401, "authentication_required", "Authentication is required.");
    const user = await this.identityRepository.findBySessionToken(token, this.identityTouchAllowed());
    if (user === null) throw new RuntimeAccessError(401, "invalid_session", "Session is invalid or expired.");
    const role = String(user.role ?? "");
    if (role === "super_admin") return user;
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
    return user;
  }

  private identityTouchAllowed(): boolean {
    return (
      (this.config.environment === "prod" && this.config.prefixes.identity === "bd_prod_" && mutationsAllowed(this.config)) ||
      (this.config.environment === "test" && this.config.prefixes.identity === "bd_test_" && mutationsAllowed(this.config))
    );
  }
}

function requiredCapture(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new RuntimeAccessError(400, "invalid_route", "Route parameter is missing.");
  return value;
}

function requiredId(value: unknown, name: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new DomainValidationError("invalid_id", `${name} must be a positive decimal id.`);
  }
  return normalized;
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

function ok(payload: Record<string, unknown>, statusCode = 200): TournamentOperationsRouteResult {
  return { statusCode, payload: { ok: true, ...payload } };
}
