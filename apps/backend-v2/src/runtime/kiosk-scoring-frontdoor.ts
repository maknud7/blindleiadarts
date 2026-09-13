import type { IncomingMessage } from "node:http";

import { DomainValidationError } from "../domain/errors.js";
import type { MySqlScoliaKioskAuthRepository } from "../mysql/scolia-kiosk-auth-repository.js";
import { assertMutationAllowed, type BackendRuntimeConfig } from "./config.js";

export interface KioskScoringRouteResult {
  readonly statusCode: number;
  readonly payload: Record<string, unknown>;
}

export interface ManualKioskScoringPort {
  startManualMatch(kioskIdInput: unknown): Promise<Record<string, unknown>>;
  recordManualVisit(kioskIdInput: unknown, payloadInput: unknown): Promise<Record<string, unknown>>;
  undoManualVisit(kioskIdInput: unknown): Promise<Record<string, unknown>>;
}

/**
 * Public paired-kiosk scoring and session front door.
 *
 * The PHP same-origin proxy selects Node before dispatch. Once this route is
 * entered, all state resolution, pairing reset, canonical scoring and response
 * snapshots stay in backend-v2; there is no PHP fallback after an attempted mutation.
 */
export class KioskScoringFrontdoor {
  constructor(
    private readonly config: BackendRuntimeConfig,
    private readonly kiosks: MySqlScoliaKioskAuthRepository,
    private readonly scoring: ManualKioskScoringPort,
  ) {}

  async handle(method: string, path: string, request: IncomingMessage): Promise<KioskScoringRouteResult | null> {
    const match = /^\/v1\/kiosks\/([^/]+)\/(state|start-match|visit|undo|unpair)$/.exec(path);
    if (!match) return null;

    const action = capture(match, 2);
    if (action === "state" && method !== "GET") return null;
    if (action !== "state" && method !== "POST") return null;

    // Kiosk state reads refresh last_seen_at just like the legacy runtime, so the
    // complete front door intentionally requires a writable backend-v2 service.
    assertMutationAllowed(this.config);

    const code = decodeCode(capture(match, 1));
    const pairingToken = header(request, "x-kiosk-pairing-token");
    if (action === "unpair") {
      return ok(await this.kiosks.unpairScoring(code, pairingToken));
    }

    const kiosk = await this.kiosks.resolveScoring(code, pairingToken, true);
    if (action === "start-match") {
      await this.scoring.startManualMatch(kiosk.kiosk_id);
    } else if (action === "visit") {
      await this.scoring.recordManualVisit(kiosk.kiosk_id, await readJsonObject(request));
    } else if (action === "undo") {
      await this.scoring.undoManualVisit(kiosk.kiosk_id);
    }

    return ok(await this.kiosks.scoringSnapshot(kiosk.kiosk_id));
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

function decodeCode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new DomainValidationError("invalid_kiosk_code", "Kiosk code is not valid URL encoding.", 400);
  }
}

function ok(payload: Record<string, unknown>, statusCode = 200): KioskScoringRouteResult {
  return { statusCode, payload: { ok: true, ...payload } };
}
