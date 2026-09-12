import { createHash } from "node:crypto";

import type { CanonicalScoringPort } from "../contracts/canonical-scoring.js";
import { asDbId } from "../contracts/scoring.js";
import { evaluateVisit } from "../domain/dart501.js";
import { DomainValidationError } from "../domain/errors.js";
import { boolValue, mapScoliaSector } from "../domain/scolia.js";
import type {
  MySqlScoliaBridgeRepository,
  ScoliaEventRow,
  ScoliaVisitBuffer,
} from "../mysql/scolia-bridge-repository.js";

interface ScoliaDisconnectPort {
  markDisconnected(kioskIdInput: unknown, reasonInput: unknown): Promise<void>;
}

interface ScoliaCommandPort {
  queueCommand(
    clubIdInput: unknown,
    kioskIdInput: unknown,
    typeInput: unknown,
    payloadInput: unknown,
    userIdInput: unknown,
  ): Promise<Record<string, unknown>>;
}

export class ScoliaEventProcessor {
  constructor(
    private readonly bridge: MySqlScoliaBridgeRepository,
    private readonly scoring: CanonicalScoringPort,
    private readonly disconnects: ScoliaDisconnectPort = bridge,
    private readonly commands: ScoliaCommandPort = bridge as unknown as ScoliaCommandPort,
  ) {}

  async drain(limitInput: unknown = 25, maxProcessingMs = 750): Promise<Record<string, unknown>> {
    const limit = clampInt(limitInput, 1, 25, 25);
    const budgetMs = Math.min(5000, Math.max(100, maxProcessingMs));
    const startedAt = Date.now();
    const events = await this.bridge.claimEvents(limit);
    if (events.length === 0) return { claimed: 0, processed: 0, failed: 0 };

    const groups = new Map<string, ScoliaEventRow[]>();
    for (const event of events) {
      const group = groups.get(event.kiosk_id) ?? [];
      group.push(event);
      groups.set(event.kiosk_id, group);
    }

    let processed = 0;
    let failed = 0;
    const release: string[] = [];
    let budgetExhausted = false;
    for (const boardEvents of groups.values()) {
      let blocked = false;
      for (const event of boardEvents) {
        if (!budgetExhausted && Date.now() - startedAt >= budgetMs) budgetExhausted = true;
        if (blocked || budgetExhausted) {
          release.push(event.id);
          continue;
        }
        try {
          const result = await this.processEvent(event);
          await this.bridge.markEventProcessed(event.id, result.status, result.visit_id ?? null, result.meta ?? null);
          processed += 1;
        } catch (error) {
          console.error("scolia_event_processing_failed", {
            event_id: event.id,
            kiosk_id: event.kiosk_id,
            event_type: event.event_type,
            error: error instanceof Error ? error.message : String(error),
          });
          await this.bridge.markEventFailed(event, error);
          failed += 1;
          blocked = true;
        }
      }
    }
    if (release.length > 0) await this.bridge.releaseClaims(release);
    return { claimed: events.length, processed, failed };
  }

  async processEvent(event: ScoliaEventRow): Promise<{ status: string; visit_id?: string; meta?: Record<string, unknown> }> {
    const board = await this.bridge.boardContext(event.kiosk_id);
    if (!board) throw new DomainValidationError("scolia_board_not_found", "Scolia-boardet finnes ikke lenger.", 404);
    const type = event.event_type.toUpperCase();
    const message = event.payload;
    const payload = recordOrEmpty(message.payload);

    if (type === "BRIDGE_CONNECTED") {
      await this.bridge.bridgeHeartbeat(event.kiosk_id, "connected");
      return { status: "processed", meta: { connection: "connected" } };
    }
    if (type === "BRIDGE_DISCONNECTED") {
      const reason = stringValue(payload.reason ?? message.reason) || "Scolia WebSocket disconnected";
      await this.disconnects.markDisconnected(event.kiosk_id, reason);
      return { status: "processed", meta: { connection: "disconnected" } };
    }
    if (type === "BRIDGE_ERROR") {
      const reason = stringValue(payload.error ?? message.error) || "Ukjent bridge-feil";
      await this.disconnects.markDisconnected(event.kiosk_id, reason);
      await this.bridge.recordIncident(event.club_id, event.kiosk_id, event.match_id, "error", "bridge_error", "Scolia Bridge rapporterte en feil", reason);
      return { status: "processed", meta: { bridge_error: reason } };
    }

    if (board.mode === "off") return { status: "ignored", meta: { reason: "scolia_disabled_for_board" } };

    if (type === "HELLO_CLIENT") {
      await this.bridge.updateRuntimeStatus(event.kiosk_id, payload);
      return { status: "processed", meta: { hello: true } };
    }
    if (["SBC_STATUS_CHANGED", "SBC_BOARD_AVAILABILITY_CHANGED"].includes(type)) {
      await this.bridge.updateRuntimeStatus(event.kiosk_id, payload);
      return { status: "processed", meta: { status_update: true } };
    }
    if (type === "TAKEOUT_STARTED") {
      await this.bridge.updateRuntimeStatus(event.kiosk_id, { ...payload, boardPhase: "Takeout" });
      return { status: "processed", meta: { takeout_started: true } };
    }
    if (type === "TAKEOUT_FINISHED") {
      const falseTakeout = boolValue(payload.falseTakeout ?? payload.false_takeout ?? false);
      await this.bridge.updateRuntimeStatus(event.kiosk_id, { ...payload, boardPhase: falseTakeout ? "Takeout" : "Throw" });
      if (falseTakeout) return { status: "processed", meta: { false_takeout: true } };
      const buffer = await this.bridge.getVisitBuffer(event.kiosk_id);
      const result = buffer && buffer.darts.length > 0 ? await this.finalizeBuffer(event.kiosk_id, buffer) : null;
      await this.bridge.setTurnLocked(event.kiosk_id, false);
      return result ?? { status: "processed", meta: { takeout_finished: true } };
    }
    if (type !== "THROW_DETECTED") return { status: "ignored", meta: { reason: "unsupported_event_type" } };

    if (board.fallback_active === 1 || board.needs_reconciliation === 1) {
      return { status: "ignored", meta: { reason: "manual_fallback_or_reconciliation" } };
    }
    if (board.turn_locked_until_takeout === 1) {
      return { status: "ignored", meta: { reason: "turn_complete_waiting_for_takeout" } };
    }

    await this.scoring.startMatch({ kiosk_id: asDbId(event.kiosk_id), source: "scolia" });
    const context = await this.bridge.scoringContext(event.kiosk_id);
    if (!context) return { status: "ignored", meta: { reason: "no_active_match" } };

    let buffer = await this.bridge.getVisitBuffer(event.kiosk_id);
    if (buffer && (buffer.match_id !== context.match_id || buffer.player_id !== context.player_id)) {
      await this.disconnects.markDisconnected(event.kiosk_id, "Scolia-bufferen samsvarer ikke med aktiv kamp/spiller. Manuell avstemming kreves.");
      throw new DomainValidationError("scolia_buffer_context_mismatch", "Scolia-bufferen samsvarer ikke med canonical kampstate.", 409);
    }

    const mapped = mapScoliaSector(payload.sector ?? "None", payload.bounceout ?? false);
    buffer ??= {
      kiosk_id: event.kiosk_id,
      match_id: context.match_id,
      player_id: context.player_id,
      darts: [],
      event_ids: [],
      provider_event_ids: [],
    };
    if (buffer.darts.length >= 3) {
      await this.disconnects.markDisconnected(event.kiosk_id, "Mer enn tre Scolia-kast ble registrert før takeout. Manuell avstemming kreves.");
      throw new DomainValidationError("scolia_too_many_darts", "Mer enn tre piler i samme Scolia-visit.", 409);
    }

    buffer.darts.push(mapped.dart);
    buffer.event_ids.push(event.id);
    if (event.provider_event_id) buffer.provider_event_ids.push(event.provider_event_id);
    await this.bridge.saveVisitBuffer(buffer);
    const evaluation = evaluateVisit(context.remaining, {
      input_mode: "per_dart",
      darts: buffer.darts,
      darts_used: buffer.darts.length,
    });

    if (buffer.darts.length === 3 || evaluation.is_bust || evaluation.is_checkout) {
      const fresh = await this.bridge.getVisitBuffer(event.kiosk_id);
      if (!fresh) throw new DomainValidationError("scolia_buffer_missing", "Scolia-bufferen forsvant under behandling.", 409);
      const result = await this.finalizeBuffer(event.kiosk_id, fresh);
      await this.bridge.setTurnLocked(event.kiosk_id, true);
      return result;
    }

    return {
      status: "processed",
      meta: {
        buffered: true,
        dart_index: buffer.darts.length - 1,
        dart: { ...mapped.dart, label: mapped.label, score: mapped.score },
        remaining_if_visit_ended_now: evaluation.remaining_after,
      },
    };
  }

  async deleteBufferedThrow(clubIdInput: unknown, kioskIdInput: unknown, indexInput: unknown, userIdInput: unknown): Promise<Record<string, unknown>> {
    const clubId = requiredId(clubIdInput, "club_id");
    const kioskId = requiredId(kioskIdInput, "kiosk_id");
    const userId = optionalId(userIdInput);
    const buffer = await this.bridge.getVisitBuffer(kioskId);
    if (!buffer || buffer.darts.length === 0) {
      throw new DomainValidationError("scolia_no_buffered_throw", "Det finnes ingen uferdig Scolia-pil å slette.", 409);
    }
    const index = indexInput == null ? buffer.darts.length - 1 : integerIndex(indexInput);
    if (index < 0 || index >= buffer.darts.length) throw new DomainValidationError("invalid_throw_index", "Ugyldig Scolia throwIndex.");
    buffer.darts.splice(index, 1);
    buffer.event_ids.splice(index, 1);
    if (index < buffer.provider_event_ids.length) buffer.provider_event_ids.splice(index, 1);
    if (buffer.darts.length === 0) await this.bridge.clearVisitBuffer(kioskId);
    else await this.bridge.saveVisitBuffer(buffer);
    const command = await this.commands.queueCommand(clubId, kioskId, "DELETE_THROW", { throwIndex: index }, userId);
    return { buffer: await this.bridge.getVisitBuffer(kioskId), command };
  }

  async correctBufferedThrow(clubIdInput: unknown, kioskIdInput: unknown, indexInput: unknown, sectorInput: unknown, userIdInput: unknown): Promise<Record<string, unknown>> {
    const clubId = requiredId(clubIdInput, "club_id");
    const kioskId = requiredId(kioskIdInput, "kiosk_id");
    const userId = optionalId(userIdInput);
    const index = integerIndex(indexInput);
    const sector = stringValue(sectorInput);
    const buffer = await this.bridge.getVisitBuffer(kioskId);
    if (!buffer || buffer.darts.length === 0) {
      throw new DomainValidationError("scolia_no_buffered_throw", "Det finnes ingen uferdig Scolia-pil å korrigere.", 409);
    }
    if (index < 0 || index >= buffer.darts.length) throw new DomainValidationError("invalid_throw_index", "Ugyldig Scolia throwIndex.");
    const mapped = mapScoliaSector(sector, false);
    buffer.darts[index] = mapped.dart;
    await this.bridge.saveVisitBuffer(buffer);
    const command = await this.commands.queueCommand(clubId, kioskId, "CORRECT_THROW", { throwIndex: index, sector }, userId);
    return { buffer, command, dart: { ...mapped.dart, label: mapped.label, score: mapped.score } };
  }

  private async finalizeBuffer(kioskId: string, buffer: ScoliaVisitBuffer): Promise<{ status: string; visit_id?: string; meta: Record<string, unknown> }> {
    const context = await this.bridge.scoringContext(kioskId);
    if (!context) throw new DomainValidationError("scolia_no_scoring_context", "Ingen aktiv canonical kamp finnes for Scolia-visiten.", 409);
    if (buffer.match_id !== context.match_id || buffer.player_id !== context.player_id) {
      await this.disconnects.markDisconnected(kioskId, "Scolia-visiten kunne ikke avstemmes mot canonical spiller.");
      throw new DomainValidationError("scolia_visit_context_changed", "Canonical turrekkefølge endret seg før Scolia-visiten ble ferdig.", 409);
    }
    const darts = buffer.darts.slice();
    if (darts.length === 0) {
      await this.bridge.clearVisitBuffer(kioskId);
      return { status: "processed", meta: { empty_buffer: true } };
    }
    const evaluation = evaluateVisit(context.remaining, { input_mode: "per_dart", darts, darts_used: darts.length });
    const requestKey = `scolia-${hashIds(buffer.event_ids)}`;
    const result = await this.scoring.recordVisit({
      kiosk_id: asDbId(kioskId),
      source: "scolia",
      payload: { input_mode: "per_dart", darts, darts_used: darts.length, request_id: requestKey },
    });
    const visitId = await this.bridge.findVisitByRequestKey(requestKey);
    await this.bridge.clearVisitBuffer(kioskId);
    return {
      status: "processed",
      ...(visitId ? { visit_id: visitId } : {}),
      meta: {
        canonical: result.kind !== "duplicate",
        duplicate: result.kind === "duplicate",
        source: "scolia",
        request_id: requestKey,
        score: evaluation.score,
        darts_used: evaluation.darts_used,
        is_bust: evaluation.is_bust,
        is_checkout: evaluation.is_checkout,
      },
    };
  }
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function stringValue(value: unknown): string { return String(value ?? "").trim(); }
function optionalId(value: unknown): string | null { const v = String(value ?? "").trim(); return /^[1-9][0-9]*$/.test(v) ? v : null; }
function requiredId(value: unknown, name: string): string { const v = optionalId(value); if (!v) throw new DomainValidationError(`invalid_${name}`, `${name} must be a positive decimal id.`); return v; }
function integerIndex(value: unknown): number { const n = Number(value); return Number.isInteger(n) ? n : -1; }
function clampInt(value: unknown, min: number, max: number, fallback: number): number { const n = Number(value); return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback; }
function hashIds(ids: readonly string[]): string {
  return createHash("sha256").update(ids.join(","), "utf8").digest("hex");
}
