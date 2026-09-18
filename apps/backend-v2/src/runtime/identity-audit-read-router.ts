import type { IncomingMessage } from "node:http";

import type { MySqlIdentityAuditReadRepository } from "../mysql/identity-audit-read-repository.js";
import type { MySqlIdentityAuthRepository, IdentityUser } from "../mysql/identity-auth-repository.js";
import { RuntimeAccessError } from "./config.js";

export interface IdentityAuditReadRouteResult {
  statusCode: number;
  payload: Record<string, unknown>;
}

export class IdentityAuditReadRouter {
  constructor(
    private readonly identity: MySqlIdentityAuthRepository,
    private readonly audit: MySqlIdentityAuditReadRepository,
  ) {}

  async handle(method: string, path: string, request: IncomingMessage): Promise<IdentityAuditReadRouteResult | null> {
    if (method === "GET" && (path === "/v1/player-identities/history" || path === "/v1/player-identities/health")) {
      await this.requireSuperAdmin(request);
      if (path === "/v1/player-identities/history") {
        const url = new URL(request.url ?? path, "http://backend-v2.internal");
        return ok({ items: await this.audit.mergeHistory(url.searchParams.get("limit") ?? 150) });
      }
      return ok(await this.audit.health());
    }

    const duplicatesMatch = /^\/v1\/clubs\/([1-9][0-9]*)\/player-identities\/duplicates$/.exec(path);
    if (method === "GET" && duplicatesMatch) {
      const clubId = capture(duplicatesMatch, 1);
      await this.requireManager(request, clubId);
      return ok({ items: await this.audit.duplicateCandidates(clubId) });
    }

    const mergeMatch = /^\/v1\/clubs\/([1-9][0-9]*)\/player-identities\/merge$/.exec(path);
    if (method === "POST" && mergeMatch) {
      throw new RuntimeAccessError(
        403,
        "player_identity_merge_prod_only",
        "Sammenslåing av spilleridentitet er deaktivert i TEST og må utføres i PROD.",
      );
    }

    const previewMatch = /^\/v1\/clubs\/([1-9][0-9]*)\/player-identities\/preview$/.exec(path);
    if (method === "POST" && previewMatch) {
      const clubId = capture(previewMatch, 1);
      await this.requireManager(request, clubId);
      const body = await readJsonObject(request);
      return ok(await this.audit.preview(clubId, body.source_player_id, body.target_player_id));
    }

    return null;
  }

  private async requireSuperAdmin(request: IncomingMessage): Promise<IdentityUser> {
    const user = await this.requireUser(request);
    if (String(user.role ?? "") !== "super_admin") {
      throw new RuntimeAccessError(403, "super_admin_required", "Superadmin-tilgang kreves.");
    }
    return user;
  }

  private async requireManager(request: IncomingMessage, clubId: string): Promise<IdentityUser> {
    const user = await this.requireUser(request);
    if (String(user.role ?? "") === "super_admin") return user;
    if (String(user.role ?? "") !== "club_admin") {
      throw new RuntimeAccessError(403, "club_access_denied", "Du har ikke tilgang til spilleridentitet for denne klubben.");
    }
    const clubIds = new Set(
      String(user.admin_club_ids ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => /^[1-9][0-9]*$/.test(value)),
    );
    if (!clubIds.has(clubId)) {
      throw new RuntimeAccessError(403, "club_access_denied", "Du har ikke tilgang til spilleridentitet for denne klubben.");
    }
    return user;
  }

  private async requireUser(request: IncomingMessage): Promise<IdentityUser> {
    const token = bearerToken(request);
    if (token === null) {
      throw new RuntimeAccessError(401, "authentication_required", "Innlogging kreves.");
    }
    // This whole surface is strictly read-only. TEST shares bd_prod_ identity,
    // so diagnostics must never refresh last_used_at/expires_at.
    const user = await this.identity.findBySessionToken(token, false);
    if (user === null) {
      throw new RuntimeAccessError(401, "invalid_session", "Innloggingen er utløpt eller ugyldig.");
    }
    return user;
  }
}

function bearerToken(request: IncomingMessage): string | null {
  const raw = request.headers.authorization;
  const authorization = Array.isArray(raw) ? raw[0] : raw;
  const match = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? "");
  const token = match?.[1]?.trim() ?? "";
  return token === "" ? null : token;
}

function capture(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new RuntimeAccessError(400, "invalid_route", "Route parameter is missing.");
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
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    return parsed as Record<string, unknown>;
  } catch {
    throw new RuntimeAccessError(400, "invalid_json_object", "Request body must be a JSON object.");
  }
}

function ok(payload: Record<string, unknown>): IdentityAuditReadRouteResult {
  return { statusCode: 200, payload: { ok: true, ...payload } };
}
