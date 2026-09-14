import type { IncomingMessage } from "node:http";

import { DomainValidationError } from "../domain/errors.js";
import type { MySqlIdentityAuthRepository, IdentityUser } from "../mysql/identity-auth-repository.js";
import type { MySqlSeasonAdminRepository } from "../mysql/season-admin-repository.js";
import {
  assertMutationAllowed,
  mutationsAllowed,
  RuntimeAccessError,
  type BackendRuntimeConfig,
} from "./config.js";
import { PaymentSettingsRouter } from "./payment-settings-router.js";

export interface SeasonAdminRouteResult {
  statusCode: number;
  payload: Record<string, unknown>;
}

export class SeasonAdminRouter {
  private paymentSettings: PaymentSettingsRouter | null = null;

  constructor(
    private readonly config: BackendRuntimeConfig,
    private readonly identityRepository: MySqlIdentityAuthRepository,
    private readonly seasons: MySqlSeasonAdminRepository,
  ) {}

  async handle(method: string, path: string, request: IncomingMessage): Promise<SeasonAdminRouteResult | null> {
    if (isPaymentSettingsRoute(method, path)) {
      if (this.paymentSettings === null) {
        this.paymentSettings = new PaymentSettingsRouter(
          this.config,
          this.identityRepository,
          this.identityRepository.paymentSettingsRepository(),
        );
      }
      return this.paymentSettings.handle(method, path, request);
    }

    const createMatch = /^\/v1\/clubs\/([1-9][0-9]*)\/seasons$/.exec(path);
    if (method === "POST" && createMatch) {
      assertMutationAllowed(this.config);
      const clubId = requiredCapture(createMatch, 1);
      const user = await this.requireUser(request);
      this.requireAdmin(user, clubId);
      const body = await readJsonObject(request);
      return ok({ season: await this.seasons.create(clubId, body) }, 201);
    }

    const seasonMatch = /^\/v1\/seasons\/([1-9][0-9]*)$/.exec(path);
    if ((method === "PUT" || method === "PATCH") && seasonMatch) {
      assertMutationAllowed(this.config);
      const seasonId = requiredCapture(seasonMatch, 1);
      const season = await this.requireSeason(seasonId);
      const user = await this.requireUser(request);
      this.requireAdmin(user, requiredId(season.club_id, "club_id"));
      const body = await readJsonObject(request);
      return ok({ season: await this.seasons.update(seasonId, body) });
    }

    const actionMatch = /^\/v1\/seasons\/([1-9][0-9]*)\/(activate|complete)$/.exec(path);
    if (method === "POST" && actionMatch) {
      assertMutationAllowed(this.config);
      const seasonId = requiredCapture(actionMatch, 1);
      const action = requiredCapture(actionMatch, 2);
      const season = await this.requireSeason(seasonId);
      const user = await this.requireUser(request);
      this.requireAdmin(user, requiredId(season.club_id, "club_id"));
      return ok({
        season: action === "activate"
          ? await this.seasons.activate(seasonId)
          : await this.seasons.complete(seasonId),
      });
    }

    return null;
  }

  private async requireSeason(seasonId: string): Promise<Record<string, unknown>> {
    const season = await this.seasons.find(seasonId);
    if (season === null) {
      throw new DomainValidationError("season_not_found", "Sesongen ble ikke funnet.", 404);
    }
    return season;
  }

  private async requireUser(request: IncomingMessage): Promise<IdentityUser> {
    const token = bearerToken(request);
    if (token === null) throw new RuntimeAccessError(401, "authentication_required", "Innlogging kreves.");
    const user = await this.identityRepository.findBySessionToken(token, this.identityTouchAllowed());
    if (user === null) throw new RuntimeAccessError(401, "invalid_session", "Sesjonen er ugyldig eller utløpt.");
    return user;
  }

  private requireAdmin(user: IdentityUser, clubId: string): void {
    const role = String(user.role ?? "");
    if (role === "super_admin") return;
    if (role !== "club_admin") {
      throw new RuntimeAccessError(403, "admin_required", "Klubbadministrator kreves.");
    }
    const clubIds = new Set(
      String(user.admin_club_ids ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => /^[1-9][0-9]*$/.test(value)),
    );
    if (!clubIds.has(clubId)) {
      throw new RuntimeAccessError(403, "club_access_denied", "Du har ikke tilgang til denne klubben.");
    }
  }

  private identityTouchAllowed(): boolean {
    return (
      (this.config.environment === "prod" && this.config.prefixes.identity === "bd_prod_" && mutationsAllowed(this.config)) ||
      (this.config.environment === "test" && this.config.prefixes.identity === "bd_test_" && mutationsAllowed(this.config))
    );
  }
}

function isPaymentSettingsRoute(method: string, path: string): boolean {
  return ["GET", "PUT", "PATCH"].includes(method)
    && /^\/v1\/clubs\/[1-9][0-9]*\/payment-settings$/.test(path);
}

function requiredCapture(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new RuntimeAccessError(400, "invalid_route", "Route parameter is missing.");
  return value;
}

function requiredId(value: unknown, name: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new DomainValidationError("invalid_id", `${name} must be a positive decimal id.`, 400);
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

function ok(payload: Record<string, unknown>, statusCode = 200): SeasonAdminRouteResult {
  return { statusCode, payload: { ok: true, ...payload } };
}
