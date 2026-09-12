import type { IncomingMessage } from "node:http";

import { DomainValidationError } from "../domain/errors.js";
import type { MySqlScoliaAdminRepository } from "../mysql/scolia-admin-repository.js";
import type { MySqlScoliaBridgeRepository } from "../mysql/scolia-bridge-repository.js";
import type { MySqlScoliaCommandRepository } from "../mysql/scolia-command-repository.js";
import type { MySqlScoliaKioskAuthRepository } from "../mysql/scolia-kiosk-auth-repository.js";
import type { MySqlScoliaKioskRuntimeRepository } from "../mysql/scolia-kiosk-runtime-repository.js";
import type { ScoliaEventProcessor } from "../service/scolia-event-processor.js";
import { assertInternalToken, assertMutationAllowed, type BackendRuntimeConfig } from "./config.js";

export interface ScoliaRuntimeRouteResult {
  readonly statusCode: number;
  readonly payload: Record<string, unknown>;
}

interface KioskUiState {
  readonly board: Record<string, unknown>;
  readonly match_id: string | null;
  readonly last_visit: Record<string, unknown> | null;
  readonly latest_canonical_visit: Record<string, unknown> | null;
  readonly last_status_probe_age_seconds: number | null;
}

export class ScoliaRuntimeRouter {
  constructor(
    private readonly config: BackendRuntimeConfig,
    private readonly bridge: MySqlScoliaBridgeRepository,
    private readonly commands: MySqlScoliaCommandRepository,
    private readonly processor: ScoliaEventProcessor,
    private readonly kioskAuth: MySqlScoliaKioskAuthRepository,
    private readonly kioskRuntime: MySqlScoliaKioskRuntimeRepository,
    private readonly scoliaAdmin: MySqlScoliaAdminRepository,
  ) {}

  async handle(method: string, path: string, request: IncomingMessage): Promise<ScoliaRuntimeRouteResult | null> {
    if (method === "GET" && path === "/v1/scolia/health") {
      return ok({
        service: "scolia-bridge",
        generated_at: new Date().toISOString(),
        data: await this.bridge.bridgeHealthState(this.config.internalToken !== null),
      });
    }

    if (path.startsWith("/v1/scolia/bridge/")) {
      this.requireBridge(request);
      if (method === "GET" && path === "/v1/scolia/bridge/config") {
        return ok({ boards: await this.bridge.listBridgeBoards(), ...this.bridge.scope() });
      }
      if (method === "GET" && path === "/v1/scolia/bridge/router") {
        return ok({ data: await this.bridge.bridgeRouterState() });
      }
      assertMutationAllowed(this.config);
      if (method === "POST" && path === "/v1/scolia/bridge/events") {
        const body = await readJsonObject(request);
        const serial = stringValue(body.serial_number);
        const message = body.message;
        if (!serial || message === null || typeof message !== "object" || Array.isArray(message)) {
          throw new DomainValidationError("scolia_event_invalid", "serial_number and message are required.", 422);
        }
        const event = await this.bridge.enqueueEvent(serial, message, body.kiosk_id);
        return ok({ event, queued: true }, event.duplicate === true ? 200 : 202);
      }
      if (method === "POST" && path === "/v1/scolia/bridge/drain") {
        const body = await readJsonObject(request);
        return ok(await this.processor.drain(body.limit ?? 50));
      }
      if (method === "POST" && path === "/v1/scolia/bridge/heartbeat") {
        const body = await readJsonObject(request);
        const boards = Array.isArray(body.boards) ? body.boards : [];
        let updated = 0;
        for (const item of boards) {
          if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
          const record = item as Record<string, unknown>;
          const kioskId = optionalId(record.kiosk_id);
          if (!kioskId) continue;
          await this.bridge.bridgeHeartbeat(kioskId, record.state ?? "connected");
          updated += 1;
        }
        return ok({ updated });
      }
      if (method === "POST" && path === "/v1/scolia/bridge/commands/poll") {
        const body = await readJsonObject(request);
        return ok({ items: await this.commands.pollCommands(body.kiosk_ids, body.limit ?? 100) });
      }
      const commandPoll = /^\/v1\/scolia\/bridge\/commands\/([1-9][0-9]*)$/.exec(path);
      if (method === "GET" && commandPoll) {
        return ok({ items: await this.commands.pollCommands([capture(commandPoll, 1)], 100) });
      }
      const commandResult = /^\/v1\/scolia\/bridge\/commands\/([1-9][0-9]*)\/result$/.exec(path);
      if (method === "POST" && commandResult) {
        const commandId = capture(commandResult, 1);
        const body = await readJsonObject(request);
        await this.commands.completeCommand(commandId, body.result ?? "failed", body.error);
        return ok({ command_id: commandId });
      }
      throw new DomainValidationError("scolia_bridge_route_not_found", "Unknown Scolia bridge route.", 404);
    }

    const testLeaseRoute = /^\/v1\/kiosks\/([^/]+)\/scolia\/test-lease\/(acquire|heartbeat|release)$/.exec(path);
    if (testLeaseRoute) {
      if (method !== "POST") return null;
      if (this.config.environment !== "test") {
        throw new DomainValidationError("scolia_test_lease_test_only", "Scolia test-lease finnes bare i TEST.", 404);
      }
      assertMutationAllowed(this.config);
      const code = decodeURIComponent(capture(testLeaseRoute, 1));
      const action = capture(testLeaseRoute, 2);
      const paired = await this.kioskAuth.resolve(code, header(request, "x-kiosk-pairing-token"), true);
      const body = await readJsonObject(request);
      if (action === "acquire") {
        return ok(await this.kioskRuntime.acquireTestLease(paired.club_id, paired.kiosk_id, body.physical_kiosk_id));
      }
      if (action === "heartbeat") {
        return ok(await this.kioskRuntime.heartbeatTestLease(paired.club_id, paired.kiosk_id, body.physical_kiosk_id));
      }
      return ok(await this.kioskRuntime.releaseTestLease(paired.club_id, paired.kiosk_id, body.physical_kiosk_id));
    }

    const kioskRoute = /^\/v1\/kiosks\/([^/]+)\/scolia(?:\/(status|undo|fallback|resume|reset-phase|delete-throw|correct-throw))?$/.exec(path);
    if (!kioskRoute) return null;
    const code = decodeURIComponent(capture(kioskRoute, 1));
    const action = kioskRoute[2] ?? "status";
    const paired = await this.kioskAuth.resolve(code, header(request, "x-kiosk-pairing-token"), true);

    if (method === "GET" && action === "status") {
      const state = await this.kioskUiState(paired.club_id, paired.kiosk_id);
      const isLiveScolia = state.board.mode === "live" && state.board.effective_scoring_mode === "scolia";
      if (isLiveScolia && state.board.bridge_heartbeat_fresh === true) {
        const probeAge = state.last_status_probe_age_seconds;
        if (probeAge === null || probeAge >= 5) {
          try {
            await this.commands.queueCommand(paired.club_id, paired.kiosk_id, "GET_SBC_STATUS", {}, null);
          } catch {
            // A status read stays available even if an individual probe cannot be queued.
          }
        }
      }
      return ok({ board: state.board, match_id: state.match_id, last_visit: state.last_visit });
    }

    if (method !== "POST") return null;
    assertMutationAllowed(this.config);
    if (action === "undo") {
      const state = await this.kioskUiState(paired.club_id, paired.kiosk_id);
      const buffer = objectValue(state.board.buffer);
      const darts = Array.isArray(buffer.darts) ? buffer.darts : [];
      if (darts.length > 0) {
        const result = await this.processor.deleteBufferedThrow(paired.club_id, paired.kiosk_id, null, null);
        const fresh = await this.kioskUiState(paired.club_id, paired.kiosk_id);
        return ok({
          action: "buffered_throw_removed",
          result,
          board: fresh.board,
          last_visit: fresh.last_visit,
        });
      }
      if (state.match_id === null) {
        throw new DomainValidationError("active_match_required", "Det finnes ingen aktiv kamp å angre i.", 409);
      }
      const latest = state.latest_canonical_visit;
      if (latest === null) {
        throw new DomainValidationError("visit_not_found", "Det finnes ikke noe kast å angre.", 409);
      }
      if (latest.source !== "scolia") {
        throw new DomainValidationError("latest_visit_not_scolia", "Siste kast ble ikke registrert av Scolia og kan ikke angres fra Scolia-knappen.", 409);
      }
      await this.processor.undoCanonicalVisit(paired.kiosk_id);
      await this.kioskRuntime.resetPhase(paired.club_id, paired.kiosk_id);
      const reset = await this.commands.queueCommand(paired.club_id, paired.kiosk_id, "RESET_PHASE", {}, null);
      const fresh = await this.kioskUiState(paired.club_id, paired.kiosk_id);
      return ok({
        action: "visit_undone",
        reset_command: reset,
        board: fresh.board,
        last_visit: fresh.last_visit,
      });
    }
    if (action === "fallback") {
      return ok({ board: await this.kioskRuntime.fallback(paired.club_id, paired.kiosk_id) });
    }
    if (action === "reset-phase") {
      await this.kioskRuntime.resetPhase(paired.club_id, paired.kiosk_id);
      return ok({ command: await this.commands.queueCommand(paired.club_id, paired.kiosk_id, "RESET_PHASE", {}, null) });
    }
    if (action === "resume") {
      const body = await readJsonObject(request);
      if (body.reconciled !== true) {
        throw new DomainValidationError("scolia_reconciliation_required", "Bekreft avstemming før Scolia gjenopptas.", 409);
      }
      await this.kioskRuntime.resume(paired.club_id, paired.kiosk_id);
      return ok({ command: await this.commands.queueCommand(paired.club_id, paired.kiosk_id, "RESET_PHASE", {}, null) });
    }
    if (action === "delete-throw") {
      const body = await readJsonObject(request);
      return ok(await this.processor.deleteBufferedThrow(paired.club_id, paired.kiosk_id, body.throw_index, null));
    }
    if (action === "correct-throw") {
      const body = await readJsonObject(request);
      return ok(await this.processor.correctBufferedThrow(paired.club_id, paired.kiosk_id, body.throw_index, body.sector, null));
    }
    return null;
  }

  private async kioskUiState(clubId: string, kioskId: string): Promise<KioskUiState> {
    const settings = await this.scoliaAdmin.getBoardSettings(clubId, kioskId);
    if (!settings) throw new DomainValidationError("kiosk_not_found", "Boardet ble ikke funnet.", 404);
    const snapshot = await this.commands.kioskUiSnapshot(clubId, kioskId);
    const physical = snapshot.physical_status;
    const physicalStatus = stringValue(physical.status);
    const physicalStatusAge = physical.age_seconds;
    const bridgeAge = snapshot.bridge_heartbeat_age_seconds;
    const connectionState = stringValue(settings.connection_state);
    const bridgeFresh = connectionState === "connected" && bridgeAge !== null && bridgeAge <= 45;
    const statusFresh = physicalStatus !== "" && physicalStatusAge !== null && physicalStatusAge <= 12;
    const normalizedPhysicalStatus = physicalStatus.toLowerCase();
    const unavailableStatuses = new Set([
      "offline",
      "unavailable",
      "disconnected",
      "error",
      "camera error",
      "calibration error",
    ]);
    const physicalAvailable = bridgeFresh && statusFresh && !unavailableStatuses.has(normalizedPhysicalStatus);
    const fallbackActive = numberValue(settings.fallback_active) === 1 || numberValue(settings.needs_reconciliation) === 1;
    const effectiveScoringMode = fallbackActive
      ? "manual"
      : stringValue(settings.mode) === "live" ? "scolia" : "manual";
    const board: Record<string, unknown> = {
      ...settings,
      effective_scoring_mode: effectiveScoringMode,
      buffer: snapshot.buffer,
      queue: snapshot.queue,
      reported_board_status: settings.board_status ?? null,
      physical_board_status: physical.status,
      physical_status_event_type: physical.event_type,
      physical_status_received_at: physical.received_at,
      physical_status_age_seconds: physicalStatusAge,
      physical_status_fresh: statusFresh,
      bridge_heartbeat_age_seconds: bridgeAge,
      bridge_heartbeat_fresh: bridgeFresh,
      physical_available: physicalAvailable,
    };
    const isLiveScolia = board.mode === "live" && effectiveScoringMode === "scolia";
    if (isLiveScolia && !physicalAvailable) {
      board.board_status = "Offline";
    } else if (physicalAvailable && physicalStatus !== "") {
      board.board_status = physicalStatus;
    }
    return {
      board,
      match_id: snapshot.match_id,
      last_visit: snapshot.last_visit,
      latest_canonical_visit: snapshot.latest_canonical_visit,
      last_status_probe_age_seconds: snapshot.last_status_probe_age_seconds,
    };
  }

  private requireBridge(request: IncomingMessage): void {
    const supplied = header(request, "x-bd-backend-v2-token") ?? header(request, "x-scolia-bridge-secret");
    try {
      assertInternalToken(this.config, supplied);
    } catch {
      throw new DomainValidationError("scolia_bridge_unauthorized", "Invalid Scolia bridge secret.", 401);
    }
  }
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 65_536) throw new DomainValidationError("request_too_large", "Request body exceeds 64 KiB.", 413);
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value as Record<string, unknown>;
  } catch {
    throw new DomainValidationError("invalid_json", "Request body must contain a JSON object.", 400);
  }
}
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
function capture(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (!value) throw new DomainValidationError("route_capture_missing", "Route parameter is missing.", 500);
  return value;
}
function optionalId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}
function stringValue(value: unknown): string { return String(value ?? "").trim(); }
function numberValue(value: unknown): number {
  const valueNumber = Number(value ?? 0);
  return Number.isFinite(valueNumber) ? valueNumber : 0;
}
function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function ok(payload: Record<string, unknown>, statusCode = 200): ScoliaRuntimeRouteResult {
  return { statusCode, payload: { ok: true, ...payload } };
}
