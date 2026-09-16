import type { IncomingMessage } from "node:http";

import { DomainValidationError } from "../domain/errors.js";
import {
  MySqlKioskPlayerPreferenceRepository,
  type KioskInputMode,
} from "../mysql/kiosk-player-preference-repository.js";
import { assertMutationAllowed, type BackendRuntimeConfig } from "./config.js";

export interface KioskPlayerPreferenceRouteResult {
  readonly statusCode: number;
  readonly payload: Record<string, unknown>;
}

/** Paired-kiosk GET/POST front door for each player's manual scoring input preference. */
export class KioskPlayerPreferenceFrontdoor {
  constructor(
    private readonly config: BackendRuntimeConfig,
    private readonly preferences: MySqlKioskPlayerPreferenceRepository,
  ) {}

  async handle(
    method: string,
    path: string,
    request: IncomingMessage,
  ): Promise<KioskPlayerPreferenceRouteResult | null> {
    const match = /^\/v1\/kiosks\/([^/]+)\/player-preference$/.exec(path);
    if (!match) return null;
    if (method !== "GET" && method !== "POST") {
      throw new DomainValidationError("method_not_allowed", "Metoden støttes ikke.", 405);
    }

    const code = decodeCode(capture(match, 1));
    const pairingToken = header(request, "x-kiosk-pairing-token")?.trim() ?? "";
    if (code === "" || pairingToken === "") {
      throw new DomainValidationError(
        "kiosk_credentials_required",
        "Kiosk-kode og pairing-token kreves.",
        422,
      );
    }

    const kioskId = await this.preferences.resolvePairedKiosk(code, pairingToken);
    let state = await this.preferences.stateForKiosk(kioskId);

    if (method === "POST") {
      assertMutationAllowed(this.config);
      const body = await readJsonObject(request);
      const mode = String(body.preferred_input_mode ?? "").trim();
      if (mode !== "sum" && mode !== "per_dart") {
        throw new DomainValidationError("invalid_input_mode", "Velg enten sum eller per pil.", 422);
      }

      const playerId = String(body.player_id ?? "").trim();
      const activePlayerIds = new Set(state.players.map((player) => player.id));
      if (!activePlayerIds.has(playerId)) {
        throw new DomainValidationError(
          "player_not_in_match",
          "Spilleren tilhører ikke kampen på dette boardet.",
          403,
        );
      }

      await this.preferences.updatePreference(playerId, mode as KioskInputMode);
      state = await this.preferences.stateForKiosk(kioskId);
    }

    return { statusCode: 200, payload: { ok: true, data: state } };
  }
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 65_536) {
      throw new DomainValidationError("request_too_large", "Request body exceeds 64 KiB.", 413);
    }
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
    return decodeURIComponent(value).trim();
  } catch {
    throw new DomainValidationError("invalid_kiosk_code", "Kiosk code is not valid URL encoding.", 400);
  }
}
