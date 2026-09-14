import type { IncomingMessage } from "node:http";

import type { IdentityUser, MySqlIdentityAuthRepository } from "../mysql/identity-auth-repository.js";
import type { MySqlPaymentSettingsRepository } from "../mysql/payment-settings-repository.js";
import {
  assertMutationAllowed,
  mutationsAllowed,
  RuntimeAccessError,
  type BackendRuntimeConfig,
} from "./config.js";

export interface PaymentSettingsRouteResult {
  statusCode: number;
  payload: Record<string, unknown>;
}

export class PaymentSettingsRouter {
  constructor(
    private readonly config: BackendRuntimeConfig,
    private readonly identity: MySqlIdentityAuthRepository,
    private readonly payments: MySqlPaymentSettingsRepository,
  ) {}

  async handle(method: string, path: string, request: IncomingMessage): Promise<PaymentSettingsRouteResult | null> {
    const match = /^\/v1\/clubs\/([1-9][0-9]*)\/payment-settings$/.exec(path);
    if (match === null || !["GET", "PUT", "PATCH"].includes(method)) return null;

    if (method !== "GET") assertMutationAllowed(this.config);

    const clubId = requiredCapture(match, 1);
    const user = await this.requireUser(request);
    this.requireAdmin(user, clubId);

    if (method === "GET") {
      return ok({ settings: await this.payments.adminSettings(clubId) });
    }

    const body = await readJsonObject(request);
    return ok({
      settings: await this.payments.saveAdminSettings(clubId, body),
      message: "Betalingsinnstillingene er lagret.",
    });
  }

  private async requireUser(request: IncomingMessage): Promise<IdentityUser> {
    const token = bearerToken(request);
    if (token === null) throw new RuntimeAccessError(401, "authentication_required", "Innlogging kreves.");
    const user = await this.identity.findBySessionToken(token, this.identityTouchAllowed());
    if (user === null) throw new RuntimeAccessError(401, "invalid_session", "Innloggingen er utløpt eller ugyldig.");
    return user;
  }

  private requireAdmin(user: IdentityUser, clubId: string): void {
    const role = String(user.role ?? "");
    if (role === "super_admin") return;
    if (role !== "club_admin") {
      throw new RuntimeAccessError(403, "admin_required", "Administratortilgang kreves.");
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

function requiredCapture(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new RuntimeAccessError(400, "invalid_route", "Route parameter is missing.");
  return value;
}

function bearerToken(request: IncomingMessage): string | null {
  const raw = request.headers.authorization;
  const authorization = Array.isArray(raw) ? raw[0] : raw;
  const match = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? "");
  const token = match?.[1]?.trim() ?? "";
  return token === "" ? null : token;
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

function ok(payload: Record<string, unknown>): PaymentSettingsRouteResult {
  return { statusCode: 200, payload: { ok: true, ...payload } };
}
