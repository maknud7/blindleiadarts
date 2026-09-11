import type { IncomingMessage } from "node:http";

import type { IdentityUser, MySqlIdentityAuthRepository } from "../mysql/identity-auth-repository.js";
import type { MySqlTournamentOperationsRepository } from "../mysql/tournament-operations-repository.js";
import {
  assertMutationAllowed,
  mutationsAllowed,
  RuntimeAccessError,
  type BackendRuntimeConfig,
} from "./config.js";

export interface TournamentOperationsRouteResult {
  statusCode: number;
  payload: Record<string, unknown>;
}

export class TournamentOperationsRouter {
  constructor(
    private readonly config: BackendRuntimeConfig,
    private readonly identityRepository: MySqlIdentityAuthRepository,
    private readonly operations: MySqlTournamentOperationsRepository,
  ) {}

  async handle(method: string, path: string, request: IncomingMessage): Promise<TournamentOperationsRouteResult | null> {
    const match = /^\/v1\/tournaments\/([1-9][0-9]*)\/operations\/(boards|settings)$/.exec(path);
    if (!match) return null;

    const tournamentId = requiredCapture(match, 1);
    const action = requiredCapture(match, 2);
    const tournament = await this.operations.findTournament(tournamentId);
    if (tournament === null) {
      throw new RuntimeAccessError(404, "tournament_not_found", "Tournament was not found.");
    }
    const clubId = requiredId(tournament.club_id, "club_id");
    const user = await this.requireUser(request);
    this.requireAdmin(user, clubId);

    if (method === "GET" && action === "boards") {
      return ok(await this.operations.boardSelection(tournamentId));
    }

    if ((method === "PUT" || method === "PATCH") && action === "boards") {
      assertMutationAllowed(this.config);
      const body = await readJsonObject(request);
      return ok(await this.operations.replaceBoardSelection(tournamentId, body.kiosk_ids));
    }

    if ((method === "PUT" || method === "PATCH") && action === "settings") {
      assertMutationAllowed(this.config);
      const body = await readJsonObject(request);
      return ok(await this.operations.updateAutoAssignEnabled(tournamentId, body.auto_assign_enabled));
    }

    return {
      statusCode: 405,
      payload: { ok: false, error: { code: "method_not_allowed", message: "Method is not supported for this operations route." } },
    };
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
    if (role !== "club_admin") throw new RuntimeAccessError(403, "admin_required", "Club administrator access is required.");
    const allowed = new Set(
      String(user.admin_club_ids ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => /^[1-9][0-9]*$/.test(value)),
    );
    if (!allowed.has(clubId)) throw new RuntimeAccessError(403, "club_access_denied", "You cannot manage this club.");
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
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new RuntimeAccessError(400, "invalid_id", `${name} must be a positive decimal id.`);
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
