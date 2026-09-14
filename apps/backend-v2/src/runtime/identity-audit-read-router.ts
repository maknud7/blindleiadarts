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
    if (method !== "GET") return null;
    if (path !== "/v1/player-identities/history" && path !== "/v1/player-identities/health") return null;

    await this.requireSuperAdmin(request);
    if (path === "/v1/player-identities/history") {
      const url = new URL(request.url ?? path, "http://backend-v2.internal");
      return ok({ items: await this.audit.mergeHistory(url.searchParams.get("limit") ?? 150) });
    }
    return ok(await this.audit.health());
  }

  private async requireSuperAdmin(request: IncomingMessage): Promise<IdentityUser> {
    const token = bearerToken(request);
    if (token === null) {
      throw new RuntimeAccessError(401, "authentication_required", "Innlogging kreves.");
    }
    // This surface is strictly read-only. TEST shares bd_prod_ identity, so it
    // must never refresh last_used_at/expires_at while reading audit data.
    const user = await this.identity.findBySessionToken(token, false);
    if (user === null) {
      throw new RuntimeAccessError(401, "invalid_session", "Innloggingen er utløpt eller ugyldig.");
    }
    if (String(user.role ?? "") !== "super_admin") {
      throw new RuntimeAccessError(403, "super_admin_required", "Superadmin-tilgang kreves.");
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

function ok(payload: Record<string, unknown>): IdentityAuditReadRouteResult {
  return { statusCode: 200, payload: { ok: true, ...payload } };
}
