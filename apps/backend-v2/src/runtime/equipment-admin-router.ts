import type { IncomingMessage } from "node:http";

import { DomainValidationError } from "../domain/errors.js";
import type { MySqlEquipmentAdminRepository } from "../mysql/equipment-admin-repository.js";
import type { IdentityUser, MySqlIdentityAuthRepository } from "../mysql/identity-auth-repository.js";
import type { MySqlScoliaAdminRepository } from "../mysql/scolia-admin-repository.js";
import type { MySqlScoliaDashboardRepository } from "../mysql/scolia-dashboard-repository.js";
import {
  assertMutationAllowed,
  mutationsAllowed,
  RuntimeAccessError,
  type BackendRuntimeConfig,
} from "./config.js";

export interface EquipmentAdminRouteResult {
  statusCode: number;
  payload: Record<string, unknown>;
}

export class EquipmentAdminRouter {
  constructor(
    private readonly config: BackendRuntimeConfig,
    private readonly identityRepository: MySqlIdentityAuthRepository,
    private readonly equipment: MySqlEquipmentAdminRepository,
    private readonly scolia: MySqlScoliaAdminRepository,
    private readonly scoliaDashboard: MySqlScoliaDashboardRepository,
  ) {}

  async handle(method: string, path: string, request: IncomingMessage): Promise<EquipmentAdminRouteResult | null> {
    const equipmentBoards = /^\/v1\/clubs\/([1-9][0-9]*)\/equipment\/boards$/.exec(path);
    if (method === "GET" && equipmentBoards) {
      const clubId = capture(equipmentBoards, 1);
      await this.requireAdmin(request, clubId);
      return ok({ club_id: clubId, items: await this.equipment.listBoards(clubId, true) });
    }

    const kiosks = /^\/v1\/clubs\/([1-9][0-9]*)\/kiosks$/.exec(path);
    if (kiosks && method === "GET") {
      const clubId = capture(kiosks, 1);
      return ok({ club_id: clubId, items: await this.equipment.listBoards(clubId, false) });
    }
    if (kiosks && method === "POST") {
      const clubId = capture(kiosks, 1);
      const admin = await this.requireAdmin(request, clubId);
      assertProductionHardwareMutationAllowed(this.config);
      const body = await readJsonObject(request);
      return ok({ kiosk: await this.equipment.createBoard(clubId, body), updated_by_user_id: decimalId(admin.id) }, 201);
    }

    const kiosk = /^\/v1\/clubs\/([1-9][0-9]*)\/kiosks\/([1-9][0-9]*)$/.exec(path);
    if (kiosk && method === "DELETE") {
      const clubId = capture(kiosk, 1);
      const kioskId = capture(kiosk, 2);
      await this.requireSuperAdmin(request);
      assertProductionHardwareMutationAllowed(this.config);
      const deleted = await this.equipment.deleteBoard(clubId, kioskId);
      if (!deleted) throw new DomainValidationError("board_not_found", "Skiva ble ikke funnet i valgt klubb.", 404);
      return ok({ deleted: true, kind: "board", id: kioskId, ...this.equipment.scope() });
    }
    if (kiosk && (method === "PATCH" || method === "PUT")) {
      const clubId = capture(kiosk, 1);
      const kioskId = capture(kiosk, 2);
      await this.requireAdmin(request, clubId);
      assertProductionHardwareMutationAllowed(this.config);
      const updated = await this.equipment.updateBoard(clubId, kioskId, await readJsonObject(request));
      if (!updated) throw new DomainValidationError("kiosk_not_found", "Kiosk was not found for the selected club.", 404);
      return ok({ kiosk: updated });
    }

    const screens = /^\/v1\/clubs\/([1-9][0-9]*)\/screen-devices$/.exec(path);
    if (screens && method === "GET") {
      const clubId = capture(screens, 1);
      await this.requireAdmin(request, clubId);
      return ok({ club_id: clubId, items: await this.scoliaDashboard.listScreenDevices(clubId) });
    }
    if (screens && method === "POST") {
      const clubId = capture(screens, 1);
      await this.requireAdmin(request, clubId);
      assertMutationAllowed(this.config);
      const body = await readJsonObject(request);
      return ok({ device: await this.scoliaDashboard.createScreenDevice(clubId, body.label) }, 201);
    }

    const screen = /^\/v1\/clubs\/([1-9][0-9]*)\/screen-devices\/([1-9][0-9]*)$/.exec(path);
    if (screen && method === "DELETE") {
      const clubId = capture(screen, 1);
      const screenId = capture(screen, 2);
      await this.requireSuperAdmin(request);
      assertMutationAllowed(this.config);
      const deleted = await this.scoliaDashboard.deleteScreenDevice(clubId, screenId);
      if (!deleted) throw new DomainValidationError("screen_not_found", "Venue-skjermen ble ikke funnet i valgt klubb.", 404);
      return ok({ deleted: true, kind: "screen", id: screenId });
    }

    const resetPairing = /^\/v1\/clubs\/([1-9][0-9]*)\/kiosks\/([1-9][0-9]*)\/reset-pairing$/.exec(path);
    if (method === "POST" && resetPairing) {
      const clubId = capture(resetPairing, 1);
      const kioskId = capture(resetPairing, 2);
      await this.requireAdmin(request, clubId);
      assertMutationAllowed(this.config);
      const updated = await this.equipment.resetPairing(clubId, kioskId);
      if (!updated) throw new DomainValidationError("kiosk_not_found", "Kiosk was not found for the selected club.", 404);
      return ok({ kiosk: updated });
    }

    const pendingPairings = /^\/v1\/clubs\/([1-9][0-9]*)\/kiosk-pairing-requests$/.exec(path);
    if (method === "GET" && pendingPairings) {
      const clubId = capture(pendingPairings, 1);
      await this.requireAdmin(request, clubId);
      const requests = await this.equipment.listPendingPairingRequests(clubId);
      return ok({
        club_id: clubId,
        items: requests.filter((item) => String(item.club_id ?? "") === clubId),
      });
    }

    const approvePairing = /^\/v1\/clubs\/([1-9][0-9]*)\/kiosk-pairing-requests\/([^/]+)\/approve$/.exec(path);
    if (method === "POST" && approvePairing) {
      const clubId = capture(approvePairing, 1);
      const requestCode = decodeURIComponent(capture(approvePairing, 2));
      const admin = await this.requireAdmin(request, clubId);
      assertMutationAllowed(this.config);
      const body = await readJsonObject(request);
      const kioskId = requiredId(body.kiosk_id, "kiosk_id");
      const result = await this.equipment.approvePairingRequest(clubId, requestCode, kioskId, decimalId(admin.id));
      if (!result) throw new DomainValidationError("pairing_request_not_found", "Pairing request or kiosk was not found.", 404);
      return ok(result);
    }

    if (method === "POST" && path === "/v1/kiosk-pairing-requests") {
      assertMutationAllowed(this.config);
      const pairingToken = header(request, "x-kiosk-pairing-token")?.trim() ?? "";
      const body = await readJsonObject(request);
      const requestItem = await this.equipment.createPairingRequest(pairingToken, body.device_name, body.club_id);
      return ok({ request: requestItem }, 201);
    }

    const pairingStatus = /^\/v1\/kiosk-pairing-requests\/([^/]+)$/.exec(path);
    if (method === "GET" && pairingStatus) {
      const pairingToken = header(request, "x-kiosk-pairing-token")?.trim() ?? "";
      const result = await this.equipment.getPairingRequestStatus(decodeURIComponent(capture(pairingStatus, 1)), pairingToken);
      if (!result) throw new DomainValidationError("pairing_request_not_found", "Pairing request was not found.", 404);
      return ok(result);
    }

    const scoliaDashboard = /^\/v1\/clubs\/([1-9][0-9]*)\/scolia$/.exec(path);
    if (method === "GET" && scoliaDashboard) {
      const clubId = capture(scoliaDashboard, 1);
      await this.requireAdmin(request, clubId);
      // Deliberately sequential. Domeneshop gives backend-v2 a tiny connection budget,
      // and one request must not fan out concurrent queries on the reused connection.
      const settings = await this.scolia.getClubSettings(clubId);
      const boards = await this.scolia.listBoards(clubId);
      const queue = await this.scoliaDashboard.queueCounts(clubId);
      const incidents = await this.scoliaDashboard.listOpenIncidents(clubId);
      const failedEvents = await this.scoliaDashboard.listFailedEvents(clubId);
      return ok({ settings, queue, boards, incidents, failed_events: failedEvents, ...this.scolia.scope() });
    }

    const scoliaSettings = /^\/v1\/clubs\/([1-9][0-9]*)\/scolia\/settings$/.exec(path);
    if (scoliaSettings && method === "GET") {
      const clubId = capture(scoliaSettings, 1);
      await this.requireAdmin(request, clubId);
      return ok({ settings: await this.scolia.getClubSettings(clubId) });
    }
    if (scoliaSettings && (method === "PATCH" || method === "PUT")) {
      const clubId = capture(scoliaSettings, 1);
      const admin = await this.requireAdmin(request, clubId);
      assertProductionHardwareMutationAllowed(this.config);
      return ok({ settings: await this.scolia.updateClubSettings(clubId, await readJsonObject(request), decimalId(admin.id)) });
    }

    const boardScolia = /^\/v1\/clubs\/([1-9][0-9]*)\/kiosks\/([1-9][0-9]*)\/scolia$/.exec(path);
    if (boardScolia && method === "GET") {
      const clubId = capture(boardScolia, 1);
      const kioskId = capture(boardScolia, 2);
      await this.requireAdmin(request, clubId);
      const board = await this.scolia.getBoardSettings(clubId, kioskId);
      if (!board) throw new DomainValidationError("kiosk_not_found", "Boardet ble ikke funnet.", 404);
      return ok({ board });
    }
    if (boardScolia && (method === "PATCH" || method === "PUT")) {
      const clubId = capture(boardScolia, 1);
      const kioskId = capture(boardScolia, 2);
      const admin = await this.requireAdmin(request, clubId);
      assertProductionHardwareMutationAllowed(this.config);
      const board = await this.scolia.updateBoardSettings(clubId, kioskId, await readJsonObject(request), decimalId(admin.id));
      if (!board) throw new DomainValidationError("kiosk_not_found", "Boardet ble ikke funnet.", 404);
      return ok({ board });
    }

    const fallback = /^\/v1\/clubs\/([1-9][0-9]*)\/kiosks\/([1-9][0-9]*)\/scolia\/fallback$/.exec(path);
    if (method === "POST" && fallback) {
      const clubId = capture(fallback, 1);
      const kioskId = capture(fallback, 2);
      await this.requireAdmin(request, clubId);
      assertMutationAllowed(this.config);
      return ok({ board: await this.scolia.fallback(clubId, kioskId) });
    }

    const resetPhase = /^\/v1\/clubs\/([1-9][0-9]*)\/kiosks\/([1-9][0-9]*)\/scolia\/reset-phase$/.exec(path);
    if (method === "POST" && resetPhase) {
      const clubId = capture(resetPhase, 1);
      const kioskId = capture(resetPhase, 2);
      const admin = await this.requireAdmin(request, clubId);
      assertMutationAllowed(this.config);
      return ok({ command: await this.scolia.resetPhase(clubId, kioskId, decimalId(admin.id)) });
    }

    const resume = /^\/v1\/clubs\/([1-9][0-9]*)\/kiosks\/([1-9][0-9]*)\/scolia\/resume$/.exec(path);
    if (method === "POST" && resume) {
      const clubId = capture(resume, 1);
      const kioskId = capture(resume, 2);
      const admin = await this.requireAdmin(request, clubId);
      assertMutationAllowed(this.config);
      return ok({ command: await this.scolia.resume(clubId, kioskId, decimalId(admin.id)) });
    }

    const resolveIncident = /^\/v1\/clubs\/([1-9][0-9]*)\/scolia\/incidents\/([1-9][0-9]*)\/resolve$/.exec(path);
    if (method === "POST" && resolveIncident) {
      const clubId = capture(resolveIncident, 1);
      const incidentId = capture(resolveIncident, 2);
      const admin = await this.requireAdmin(request, clubId);
      assertMutationAllowed(this.config);
      const resolved = await this.scolia.resolveIncident(clubId, incidentId, decimalId(admin.id));
      if (!resolved) throw new DomainValidationError("incident_not_found", "Scolia-hendelsen finnes ikke eller er allerede løst.", 404);
      return ok({ resolved: true, incident_id: incidentId });
    }

    const retryEvent = /^\/v1\/clubs\/([1-9][0-9]*)\/scolia\/events\/([1-9][0-9]*)\/retry$/.exec(path);
    if (method === "POST" && retryEvent) {
      const clubId = capture(retryEvent, 1);
      const eventId = capture(retryEvent, 2);
      await this.requireAdmin(request, clubId);
      assertMutationAllowed(this.config);
      const retried = await this.scolia.retryDeadLetter(clubId, eventId);
      if (!retried) throw new DomainValidationError("event_not_retryable", "Scolia-eventen finnes ikke eller ligger ikke i dead-letter.", 409);
      return ok({ retried: true, event_id: eventId });
    }

    const cleanup = /^\/v1\/clubs\/([1-9][0-9]*)\/scolia\/cleanup$/.exec(path);
    if (method === "POST" && cleanup) {
      const clubId = capture(cleanup, 1);
      await this.requireAdmin(request, clubId);
      assertMutationAllowed(this.config);
      return ok({ deleted: await this.scolia.cleanupOldEvents(clubId) });
    }

    return null;
  }

  private async requireAdmin(request: IncomingMessage, clubId: string): Promise<IdentityUser> {
    const token = bearerToken(request);
    if (token === null) throw new RuntimeAccessError(401, "authentication_required", "Authentication is required.");
    const user = await this.identityRepository.findBySessionToken(token, this.identityTouchAllowed());
    if (user === null) throw new RuntimeAccessError(401, "invalid_session", "Session is invalid or expired.");
    const role = String(user.role ?? "");
    if (role === "super_admin") return user;
    if (role !== "club_admin") throw new RuntimeAccessError(403, "admin_required", "Club administrator access is required.");
    const clubIds = new Set(
      String(user.admin_club_ids ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => /^[1-9][0-9]*$/.test(value)),
    );
    if (!clubIds.has(clubId)) throw new RuntimeAccessError(403, "club_access_denied", "You cannot manage this club.");
    return user;
  }

  private async requireSuperAdmin(request: IncomingMessage): Promise<IdentityUser> {
    const token = bearerToken(request);
    if (token === null) throw new RuntimeAccessError(401, "authentication_required", "Authentication is required.");
    const user = await this.identityRepository.findBySessionToken(token, this.identityTouchAllowed());
    if (user === null) throw new RuntimeAccessError(401, "invalid_session", "Session is invalid or expired.");
    if (String(user.role ?? "") !== "super_admin") {
      throw new RuntimeAccessError(403, "super_admin_required", "Bare superadmin kan slette klubbutstyr.");
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

export function assertProductionHardwareMutationAllowed(config: BackendRuntimeConfig): void {
  if (config.environment === "test") {
    throw new RuntimeAccessError(
      403,
      "production_hardware_read_only",
      "TEST kan lese canonical PROD-utstyr, men kan ikke endre fysisk skive- eller Scolia-konfigurasjon.",
    );
  }
  if (
    config.environment !== "prod" ||
    config.prefixes.runtime !== "bd_prod_" ||
    config.prefixes.hardware !== "bd_prod_"
  ) {
    throw new RuntimeAccessError(
      403,
      "production_hardware_write_blocked",
      "Physical equipment writes require armed PROD runtime against the canonical bd_prod_ hardware registry.",
    );
  }
  assertMutationAllowed(config);
}

function capture(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new RuntimeAccessError(400, "invalid_route", "Route parameter is missing.");
  return value;
}

function requiredId(value: unknown, name: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new DomainValidationError("invalid_id", `${name} must be a positive decimal id.`);
  return normalized;
}

function decimalId(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new RuntimeAccessError(500, "identity_invalid", "Authenticated user has an invalid id.");
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

function ok(payload: Record<string, unknown>, statusCode = 200): EquipmentAdminRouteResult {
  return { statusCode, payload: { ok: true, ...payload } };
}
