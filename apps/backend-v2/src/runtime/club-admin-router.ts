import type { IncomingMessage } from "node:http";

import type { IdentityUser, MySqlIdentityAuthRepository } from "../mysql/identity-auth-repository.js";
import type { MySqlClubAdminRepository } from "../mysql/club-admin-repository.js";
import {
  assertMutationAllowed,
  mutationsAllowed,
  RuntimeAccessError,
  type BackendRuntimeConfig,
} from "./config.js";

export interface ClubAdminRouteResult {
  statusCode: number;
  payload: Record<string, unknown>;
}

export class ClubAdminRouter {
  constructor(
    private readonly config: BackendRuntimeConfig,
    private readonly identityRepository: MySqlIdentityAuthRepository,
    private readonly clubs: MySqlClubAdminRepository,
  ) {}

  async handle(method: string, path: string, request: IncomingMessage): Promise<ClubAdminRouteResult | null> {
    if (method === "POST" && path === "/v1/clubs") {
      assertMutationAllowed(this.config);
      const user = await this.requireUser(request);
      this.requireSuperAdmin(user);
      const body = await readJsonObject(request);
      return {
        statusCode: 201,
        payload: { ok: true, club: await this.clubs.create(body) },
      };
    }

    const screenDevices = /^\/v1\/clubs\/([1-9][0-9]*)\/screen-devices$/.exec(path);
    if (screenDevices && (method === "GET" || method === "POST")) {
      const clubId = requiredCapture(screenDevices, 1);
      const user = await this.requireUser(request);
      this.requireAdmin(user, clubId);

      if (method === "GET") {
        return {
          statusCode: 200,
          payload: { ok: true, club_id: clubId, items: await this.clubs.listScreenDevices(clubId) },
        };
      }

      assertMutationAllowed(this.config);
      const body = await readJsonObject(request);
      return {
        statusCode: 201,
        payload: { ok: true, device: await this.clubs.createScreenDevice(clubId, body.label) },
      };
    }

    return null;
  }

  private async requireUser(request: IncomingMessage): Promise<IdentityUser> {
    const token = bearerToken(request);
    if (token === null) {
      throw new RuntimeAccessError(
        401,
        "missing_bearer_token",
        "Authorization header with Bearer token is required.",
      );
    }
    const user = await this.identityRepository.findBySessionToken(token, this.identityTouchAllowed());
    if (user === null) {
      throw new RuntimeAccessError(401, "invalid_session", "Session token is invalid or expired.");
    }
    return user;
  }

  private requireSuperAdmin(user: IdentityUser): void {
    const role = String(user.role ?? "player");
    if (role === "super_admin") return;
    if (role !== "club_admin") {
      throw new RuntimeAccessError(403, "admin_required", "Admin role is required for this endpoint.");
    }
    throw new RuntimeAccessError(
      403,
      "super_admin_required",
      "Super admin role is required for this endpoint.",
    );
  }

  private requireAdmin(user: IdentityUser, clubId: string): void {
    const role = String(user.role ?? "");
    if (role === "super_admin") return;
    if (role !== "club_admin") {
      throw new RuntimeAccessError(403, "admin_required", "Admin role is required for this endpoint.");
    }
    const clubIds = new Set(
      String(user.admin_club_ids ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => /^[1-9][0-9]*$/.test(value)),
    );
    if (!clubIds.has(clubId)) {
      throw new RuntimeAccessError(403, "club_access_denied", "You do not have access to this club.");
    }
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
