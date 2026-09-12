import type { IncomingMessage } from "node:http";

import { DomainValidationError } from "../domain/errors.js";
import type { MySqlScoliaBridgeRepository } from "../mysql/scolia-bridge-repository.js";
import type { MySqlScoliaKioskAuthRepository } from "../mysql/scolia-kiosk-auth-repository.js";
import type { MySqlScoliaAdminRepository } from "../mysql/scolia-admin-repository.js";
import type { ScoliaEventProcessor } from "../service/scolia-event-processor.js";
import { assertInternalToken, assertMutationAllowed, type BackendRuntimeConfig } from "./config.js";

export interface ScoliaRuntimeRouteResult {
  readonly statusCode: number;
  readonly payload: Record<string, unknown>;
}

export class ScoliaRuntimeRouter {
  constructor(
    private readonly config: BackendRuntimeConfig,
    private readonly bridge: MySqlScoliaBridgeRepository,
    private readonly processor: ScoliaEventProcessor,
    private readonly kioskAuth: MySqlScoliaKioskAuthRepository,
    private readonly scoliaAdmin: MySqlScoliaAdminRepository,
  ) {}

  async handle(method: string, path: string, request: IncomingMessage): Promise<ScoliaRuntimeRouteResult | null> {
    if (path.startsWith("/v1/scolia/bridge/")) {
      this.requireBridge(request);
      if (method === "GET" && path === "/v1/scolia/bridge/config") {
        return ok({ boards: await this.bridge.listBridgeBoards(), ...this.bridge.scope() });
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
        return ok({ items: await this.bridge.pollCommands(body.kiosk_ids, body.limit ?? 100) });
      }
      const commandPoll = /^\/v1\/scolia\/bridge\/commands\/([1-9][0-9]*)$/.exec(path);
      if (method === "GET" && commandPoll) {
        return ok({ items: await this.bridge.pollCommands([capture(commandPoll, 1)], 100) });
      }
      const commandResult = /^\/v1\/scolia\/bridge\/commands\/([1-9][0-9]*)\/result$/.exec(path);
      if (method === "POST" && commandResult) {
        const commandId = capture(commandResult, 1);
        const body = await readJsonObject(request);
        await this.bridge.completeCommand(commandId, body.result ?? "failed", body.error);
        return ok({ command_id: commandId });
      }
      throw new DomainValidationError("scolia_bridge_route_not_found", "Unknown Scolia bridge route.", 404);
    }

    const kioskRoute = /^\/v1\/kiosks\/([^/]+)\/scolia(?:\/(status|fallback|resume|reset-phase|delete-throw|correct-throw))?$/.exec(path);
    if (!kioskRoute) return null;
    const code = decodeURIComponent(capture(kioskRoute, 1));
    const action = kioskRoute[2] ?? "status";
    const paired = await this.kioskAuth.resolve(code, header(request, "x-kiosk-pairing-token"), true);

    if (method === "GET" && action === "status") {
      const board = await this.scoliaAdmin.getBoardSettings(paired.club_id, paired.kiosk_id);
      if (!board) throw new DomainValidationError("kiosk_not_found", "Boardet ble ikke funnet.", 404);
      return ok({ board, buffer: await this.bridge.getVisitBuffer(paired.kiosk_id) });
    }

    if (method !== "POST") return null;
    assertMutationAllowed(this.config);
    if (action === "fallback") {
      return ok({ board: await this.scoliaAdmin.fallback(paired.club_id, paired.kiosk_id) });
    }
    if (action === "reset-phase") {
      return ok({ command: await this.scoliaAdmin.resetPhase(paired.club_id, paired.kiosk_id, "0") });
    }
    if (action === "resume") {
      const body = await readJsonObject(request);
      if (body.reconciled !== true) {
        throw new DomainValidationError("scolia_reconciliation_required", "Bekreft avstemming før Scolia gjenopptas.", 409);
      }
      return ok({ command: await this.scoliaAdmin.resume(paired.club_id, paired.kiosk_id, "0") });
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
function ok(payload: Record<string, unknown>, statusCode = 200): ScoliaRuntimeRouteResult {
  return { statusCode, payload: { ok: true, ...payload } };
}
