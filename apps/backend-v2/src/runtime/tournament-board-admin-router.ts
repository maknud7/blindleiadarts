import type { IncomingMessage } from "node:http";

import { DomainValidationError } from "../domain/errors.js";
import type { IdentityUser, MySqlIdentityAuthRepository } from "../mysql/identity-auth-repository.js";
import type { MySqlTournamentBoardAdminRepository } from "../mysql/tournament-board-admin-repository.js";
import { assertMutationAllowed, mutationsAllowed, RuntimeAccessError, type BackendRuntimeConfig } from "./config.js";
import type { TournamentRealtimePublisher } from "./tournament-realtime-publisher.js";

export interface TournamentBoardAdminRouteResult {
  statusCode: number;
  payload: Record<string, unknown>;
}

export class TournamentBoardAdminRouter {
  constructor(
    private readonly config: BackendRuntimeConfig,
    private readonly identityRepository: MySqlIdentityAuthRepository,
    private readonly repository: MySqlTournamentBoardAdminRepository,
    private readonly realtime: TournamentRealtimePublisher,
  ) {}

  async handle(method: string, path: string, request: IncomingMessage): Promise<TournamentBoardAdminRouteResult | null> {
    const boardAssignments = /^\/v1\/tournaments\/([1-9][0-9]*)\/board-assignments$/.exec(path);
    if (boardAssignments && (method === "GET" || method === "PUT")) {
      const tournamentId = requiredCapture(boardAssignments, 1);
      const tournament = await this.requireTournament(tournamentId);
      const clubId = requiredId(tournament.club_id, "club_id");
      await this.requireAdmin(request, clubId);
      if (method === "GET") return ok(await this.repository.boardAssignmentOverview(tournamentId));
      assertMutationAllowed(this.config);
      const body = await readJsonObject(request);
      const overview = await this.repository.replaceBoardAssignments(tournamentId, body.kiosk_ids);
      await this.realtime.publishClubRefresh(clubId, "tournament_board_assignments");
      return ok(overview);
    }

    const createMatch = /^\/v1\/tournaments\/([1-9][0-9]*)\/matches$/.exec(path);
    if (method === "POST" && createMatch) {
      assertMutationAllowed(this.config);
      const tournamentId = requiredCapture(createMatch, 1);
      const tournament = await this.requireTournament(tournamentId);
      const clubId = requiredId(tournament.club_id, "club_id");
      await this.requireAdmin(request, clubId);
      const body = await readJsonObject(request);
      const playerAId = optionalId(body.player_a_id);
      const playerBId = optionalId(body.player_b_id);
      if (playerAId === null || playerBId === null || playerAId === playerBId) {
        throw new DomainValidationError("invalid_match_players", "Two distinct players are required to create a match.", 422);
      }
      const match = await this.repository.createMatch(tournamentId, body);
      await this.realtime.publishClubRefresh(clubId, "tournament_match_created");
      return ok({ match }, 201);
    }

    const autoAssign = /^\/v1\/tournaments\/([1-9][0-9]*)\/auto-assign$/.exec(path);
    if (method === "POST" && autoAssign) {
      assertMutationAllowed(this.config);
      const tournamentId = requiredCapture(autoAssign, 1);
      const tournament = await this.requireTournament(tournamentId);
      const clubId = requiredId(tournament.club_id, "club_id");
      await this.requireAdmin(request, clubId);
      const result = await this.repository.autoAssignPendingMatches(tournamentId);
      await this.realtime.publishClubRefresh(clubId, "tournament_auto_assign");
      return ok(result);
    }

    const assignKiosk = /^\/v1\/matches\/([1-9][0-9]*)\/assign-kiosk$/.exec(path);
    if (method === "POST" && assignKiosk) {
      assertMutationAllowed(this.config);
      const matchId = requiredCapture(assignKiosk, 1);
      const context = await this.repository.findMatchContext(matchId);
      if (context === null) throw new DomainValidationError("match_not_found", "Match was not found.", 404);
      const clubId = requiredId(context.club_id, "club_id");
      await this.requireAdmin(request, clubId);
      const body = await readJsonObject(request);
      const kioskId = optionalId(body.kiosk_id);
      if (kioskId === null) throw new DomainValidationError("kiosk_required", "kiosk_id is required.", 422);
      const match = await this.repository.assignMatchToKiosk(matchId, kioskId);
      await this.realtime.publishClubRefresh(clubId, "tournament_match_assign_kiosk");
      return ok({ match });
    }

    return null;
  }

  private async requireTournament(tournamentId: string): Promise<Record<string, unknown>> {
    const tournament = await this.repository.findTournament(tournamentId);
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
    if (role !== "club_admin") throw new RuntimeAccessError(403, "admin_required", "Club administrator access is required.");
    const clubIds = new Set(String(user.admin_club_ids ?? "").split(",").map((value) => value.trim()).filter((value) => /^[1-9][0-9]*$/.test(value)));
    if (!clubIds.has(clubId)) throw new RuntimeAccessError(403, "club_access_denied", "You cannot manage this club.");
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
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new DomainValidationError("invalid_id", `${name} must be a positive decimal id.`);
  return normalized;
}

function optionalId(value: unknown): string | null {
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
  return Array.isArray(value) ? value[0] : value;
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 65_536) throw new RuntimeAccessError(413, "request_too_large", "Backend v2 request body exceeds 64 KiB.");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new RuntimeAccessError(400, "invalid_json", "Request body must contain valid JSON."); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RuntimeAccessError(400, "invalid_json_object", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function ok(payload: Record<string, unknown>, statusCode = 200): TournamentBoardAdminRouteResult {
  return { statusCode, payload: { ok: true, ...payload } };
}
