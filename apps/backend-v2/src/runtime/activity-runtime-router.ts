import type { IncomingMessage } from "node:http";

import type { MySqlActivityRuntimeRepository, ActivityEventInput } from "../mysql/activity-runtime-repository.js";
import type { MySqlIdentityAuthRepository, IdentityUser } from "../mysql/identity-auth-repository.js";
import {
  assertMutationAllowed,
  mutationsAllowed,
  RuntimeAccessError,
  type BackendRuntimeConfig,
} from "./config.js";

export interface ActivityRuntimeRouteResult {
  statusCode: number;
  payload: Record<string, unknown>;
}

export class ActivityRuntimeRouter {
  constructor(
    private readonly config: BackendRuntimeConfig,
    private readonly identity: MySqlIdentityAuthRepository,
    private readonly activity: MySqlActivityRuntimeRepository,
  ) {}

  async handle(method: string, path: string, request: IncomingMessage): Promise<ActivityRuntimeRouteResult | null> {
    if (method === "POST" && path === "/v1/activity") {
      assertMutationAllowed(this.config);
      const body = await readJsonObject(request);
      const rawEvents = Array.isArray(body.events) ? body.events : [body];
      const events = rawEvents.filter((item): item is ActivityEventInput => item !== null && typeof item === "object" && !Array.isArray(item));
      if (events.length === 0) {
        throw new RuntimeAccessError(422, "activity_events_required", "Ingen aktivitet å registrere.");
      }

      let user: IdentityUser | null = null;
      const token = bearerToken(request);
      if (token !== null) user = await this.identity.findBySessionToken(token, this.identityTouchAllowed());
      const userId = decimalId(user?.id);
      const sessionId = decimalId(user?.session_id);
      const recorded = await this.activity.recordBatch(events, userId, sessionId);
      return ok({ recorded }, 201);
    }

    if (method === "GET" && path === "/v1/activity/session") {
      const user = await this.requireUser(request);
      return ok({
        session: {
          id: publicId(user.session_id),
          expires_at: user.expires_at ?? null,
        },
        user: {
          id: publicId(user.id),
          display_name: user.display_name ?? null,
          role: user.role ?? null,
        },
      });
    }

    const clubSummary = /^\/v1\/clubs\/([1-9][0-9]*)\/activity$/.exec(path);
    if (method === "GET" && clubSummary) {
      await this.requireSuperAdmin(request);
      return ok(await this.activity.summaryByClub(requiredCapture(clubSummary, 1), daysFromRequest(request)));
    }

    if (method === "GET" && path === "/v1/platform/activity") {
      await this.requireSuperAdmin(request);
      return ok(await this.activity.summaryAll(daysFromRequest(request)));
    }

    return null;
  }

  private async requireSuperAdmin(request: IncomingMessage): Promise<IdentityUser> {
    const user = await this.requireUser(request);
    if (String(user.role ?? "") !== "super_admin") {
      throw new RuntimeAccessError(403, "super_admin_required", "Superadmin-tilgang kreves for aktivitetslogger.");
    }
    return user;
  }

  private async requireUser(request: IncomingMessage): Promise<IdentityUser> {
    const token = bearerToken(request);
    if (token === null) throw new RuntimeAccessError(401, "authentication_required", "Innlogging kreves.");
    const user = await this.identity.findBySessionToken(token, this.identityTouchAllowed());
    if (user === null) throw new RuntimeAccessError(401, "invalid_session", "Innloggingen er utløpt eller ugyldig.");
    return user;
  }

  private identityTouchAllowed(): boolean {
    return (
      (this.config.environment === "prod" && this.config.prefixes.identity === "bd_prod_" && mutationsAllowed(this.config)) ||
      (this.config.environment === "test" && this.config.prefixes.identity === "bd_test_" && mutationsAllowed(this.config))
    );
  }
}

function daysFromRequest(request: IncomingMessage): number {
  const url = new URL(request.url ?? "/", "http://backend-v2.internal");
  const raw = url.searchParams.get("days");
  if (raw === null || raw.trim() === "" || !Number.isFinite(Number(raw))) return 30;
  return Math.trunc(Number(raw));
}

function requiredCapture(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new RuntimeAccessError(400, "invalid_route", "Route parameter is missing.");
  return value;
}

function decimalId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}

function publicId(value: unknown): number | string | null {
  const id = decimalId(value);
  if (id === null) return null;
  const parsed = Number(id);
  return Number.isSafeInteger(parsed) ? parsed : id;
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

function ok(payload: Record<string, unknown>, statusCode = 200): ActivityRuntimeRouteResult {
  return { statusCode, payload: { ok: true, ...payload } };
}
