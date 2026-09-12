import { createHash } from "node:crypto";

import { asDbId, type DbId, type NormalizedDart } from "../contracts/scoring.js";
import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

export interface ScoliaEventRow extends Record<string, unknown> {
  id: string;
  club_id: string;
  kiosk_id: string;
  match_id: string | null;
  provider_event_id: string | null;
  event_type: string;
  priority: number;
  attempt_count: number;
  payload: Record<string, unknown>;
}

export interface ScoliaBoardContext extends Record<string, unknown> {
  kiosk_id: string;
  physical_kiosk_id: string;
  club_id: string;
  mode: string;
  fallback_active: number;
  needs_reconciliation: number;
  turn_locked_until_takeout: number;
}

export interface ScoliaVisitBuffer {
  kiosk_id: string;
  match_id: string;
  player_id: string;
  darts: NormalizedDart[];
  event_ids: string[];
  provider_event_ids: string[];
}

export interface ScoliaScoringContext {
  match_id: DbId;
  player_id: DbId;
  remaining: number;
}

export class MySqlScoliaBridgeRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
    private readonly hardwarePrefix: TablePrefix,
  ) {}

  scope(): Record<string, unknown> {
    return {
      configuration_table_prefix: this.hardwarePrefix,
      runtime_table_prefix: this.runtimePrefix,
      shared_hardware: this.runtimePrefix !== this.hardwarePrefix,
    };
  }

  async listBridgeBoards(): Promise<Record<string, unknown>[]> {
    // TEST must never establish a second physical Scolia websocket. The canonical
    // PROD bridge is the only physical owner and TEST receives traffic only through
    // an explicit active canonical test lease.
    if (this.runtimePrefix !== this.hardwarePrefix) return [];
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT k.id AS kiosk_id,k.club_id,k.code,k.name,k.board_number,s.serial_number,s.mode,s.auto_fallback_to_manual,
                s.force_connect_override,s.forward_messages_override,c.enabled,c.access_token,c.force_connect,
                c.forward_messages_to_scolia,c.disconnect_fallback_enabled
           FROM ${this.table(this.hardwarePrefix, "scolia_board_settings")} s
           INNER JOIN ${this.table(this.hardwarePrefix, "kiosks")} k ON k.id=s.kiosk_id AND k.is_active=1
           INNER JOIN ${this.table(this.hardwarePrefix, "scolia_club_settings")} c ON c.club_id=k.club_id AND c.enabled=1
          WHERE s.mode IN ('shadow','live') AND s.serial_number IS NOT NULL AND s.serial_number<>''
          ORDER BY k.club_id,k.board_number,k.id`,
      );
      return rows.map((row) => ({
        ...publicRow(row),
        kiosk_id: idString(row.kiosk_id),
        club_id: idString(row.club_id),
        force_connect: row.force_connect_override == null ? numberValue(row.force_connect) : numberValue(row.force_connect_override),
        forward_messages_to_scolia: row.forward_messages_override == null
          ? numberValue(row.forward_messages_to_scolia)
          : numberValue(row.forward_messages_override),
        force_connect_override: undefined,
        forward_messages_override: undefined,
      }));
    });
  }

  async enqueueEvent(serialInput: unknown, messageInput: unknown, routedKioskIdInput?: unknown): Promise<Record<string, unknown>> {
    const serial = stringValue(serialInput).toUpperCase();
    if (serial === "") throw new DomainValidationError("scolia_route_invalid", "Scolia-eventet mangler canonical serial.", 422);
    const message = objectValue(messageInput, "message");
    const routedInput = optionalId(routedKioskIdInput);

    return this.sessions.withTransaction(async (db) => {
      const physicalRows = await db.query<QueryResultRow>(
        `SELECT k.id AS physical_kiosk_id,k.club_id,c.slug AS club_slug,s.serial_number,s.mode,cs.enabled,cs.access_token
           FROM ${this.table(this.hardwarePrefix, "scolia_board_settings")} s
           INNER JOIN ${this.table(this.hardwarePrefix, "kiosks")} k ON k.id=s.kiosk_id AND k.is_active=1
           INNER JOIN ${this.table(this.hardwarePrefix, "clubs")} c ON c.id=k.club_id
           INNER JOIN ${this.table(this.hardwarePrefix, "scolia_club_settings")} cs ON cs.club_id=k.club_id AND cs.enabled=1
          WHERE UPPER(s.serial_number)=? AND s.mode IN ('shadow','live')
            AND cs.access_token IS NOT NULL AND cs.access_token<>'' LIMIT 1`,
        [serial],
      );
      const physical = physicalRows[0];
      if (!physical) throw new DomainValidationError("scolia_board_not_mapped", "Scolia-serienummeret er ikke koblet til en fysisk PROD-skive.", 404);
      const physicalId = requiredId(physical.physical_kiosk_id, "physical_kiosk_id");

      let runtimeKioskId: string;
      let runtimeClubId: string;
      if (this.runtimePrefix === this.hardwarePrefix) {
        if (routedInput !== null && routedInput !== physicalId) {
          throw new DomainValidationError("scolia_route_mismatch", "Scolia-eventet peker på feil fysisk PROD-skive.", 409);
        }
        runtimeKioskId = physicalId;
        runtimeClubId = requiredId(physical.club_id, "club_id");
      } else {
        const leases = await db.query<QueryResultRow>(
          `SELECT l.test_kiosk_id,k.club_id,c.slug
             FROM ${this.table(this.hardwarePrefix, "scolia_test_leases")} l
             INNER JOIN ${this.table(this.runtimePrefix, "kiosks")} k
               ON k.id=l.test_kiosk_id AND k.source_kiosk_id=l.physical_kiosk_id AND k.is_active=1
             INNER JOIN ${this.table(this.runtimePrefix, "clubs")} c ON c.id=k.club_id
            WHERE l.physical_kiosk_id=? AND l.expires_at>NOW(3) LIMIT 1 FOR UPDATE`,
          [physicalId],
        );
        const lease = leases[0];
        if (!lease || stringValue(lease.slug) !== stringValue(physical.club_slug)) {
          throw new DomainValidationError("scolia_test_lease_required", "Ingen aktiv TEST-lease finnes for denne fysiske Scolia-skiva.", 409);
        }
        runtimeKioskId = requiredId(lease.test_kiosk_id, "test_kiosk_id");
        runtimeClubId = requiredId(lease.club_id, "club_id");
        if (routedInput !== null && routedInput !== runtimeKioskId) {
          throw new DomainValidationError("scolia_test_lease_route_invalid", "Bridge-routen samsvarer ikke med aktiv TEST-lease.", 409);
        }
      }

      const providerId = stringValue(message.id) || null;
      const eventType = (stringValue(message.type) || "UNKNOWN").toUpperCase();
      const priority = eventPriority(eventType);
      const payload = recordOrEmpty(message.payload);
      const dedupeBasis = providerId !== null
        ? `id:${serial}:${providerId}`
        : `payload:${serial}:${eventType}:${JSON.stringify(message)}`;
      const dedupeKey = createHash("sha256").update(dedupeBasis).digest("hex");
      const detectedAt = providerDateTime(payload.detectionTime ?? payload.detection_time);
      const matchRows = await db.query<QueryResultRow>(
        `SELECT id FROM ${this.table(this.runtimePrefix, "matches")}
          WHERE kiosk_id=? AND status IN ('in_progress','assigned')
          ORDER BY FIELD(status,'in_progress','assigned'),id LIMIT 1`,
        [runtimeKioskId],
      );
      const matchId = matchRows[0] ? idString(matchRows[0].id) : null;
      const inserted = await db.execute(
        `INSERT IGNORE INTO ${this.table(this.runtimePrefix, "scolia_events")}
          (club_id,kiosk_id,match_id,provider_event_id,dedupe_key,event_type,priority,provider_detected_at,payload_json,next_attempt_at)
         VALUES (?,?,?,?,?,?,?,?,?,NOW(3))`,
        [runtimeClubId, runtimeKioskId, matchId, providerId, dedupeKey, eventType, priority, detectedAt, JSON.stringify(message)],
      );
      let eventId = inserted.affectedRows > 0 ? idString(inserted.insertId) : null;
      if (eventId === null) {
        const duplicates = await db.query<QueryResultRow>(
          `SELECT id FROM ${this.table(this.runtimePrefix, "scolia_events")} WHERE dedupe_key=? LIMIT 1`,
          [dedupeKey],
        );
        eventId = duplicates[0] ? requiredId(duplicates[0].id, "event_id") : "0";
      }
      await db.execute(
        `INSERT INTO ${this.table(this.runtimePrefix, "scolia_board_runtime")} (kiosk_id,last_event_at) VALUES (?,NOW(3))
         ON DUPLICATE KEY UPDATE last_event_at=NOW(3)`,
        [runtimeKioskId],
      );
      return { id: eventId, duplicate: inserted.affectedRows === 0, priority, kiosk_id: runtimeKioskId, club_id: runtimeClubId };
    });
  }

  async bridgeHeartbeat(kioskIdInput: unknown, stateInput: unknown = "connected"): Promise<void> {
    const kioskId = requiredId(kioskIdInput, "kiosk_id");
    const requested = stringValue(stateInput).toLowerCase();
    const state = ["connecting", "connected", "disconnected", "error"].includes(requested) ? requested : "connected";
    await this.sessions.withConnection((db) => db.execute(
      `INSERT INTO ${this.table(this.runtimePrefix, "scolia_board_runtime")} (kiosk_id,connection_state,last_bridge_heartbeat_at,connected_at)
       VALUES (?,?,NOW(3),IF(?='connected',NOW(3),NULL))
       ON DUPLICATE KEY UPDATE connection_state=VALUES(connection_state),last_bridge_heartbeat_at=NOW(3),
         connected_at=IF(VALUES(connection_state)='connected',COALESCE(connected_at,NOW(3)),connected_at)`,
      [kioskId, state, state],
    ).then(() => undefined));
  }

  async boardContext(kioskIdInput: unknown): Promise<ScoliaBoardContext | null> {
    const kioskId = requiredId(kioskIdInput, "kiosk_id");
    return this.sessions.withConnection((db) => this.boardContextWith(db, kioskId));
  }

  async markDisconnected(kioskIdInput: unknown, reasonInput: unknown): Promise<void> {
    const kioskId = requiredId(kioskIdInput, "kiosk_id");
    const reason = stringValue(reasonInput).slice(0, 1000) || "Scolia WebSocket disconnected";
    await this.sessions.withConnection(async (db) => {
      await db.execute(
        `INSERT INTO ${this.table(this.runtimePrefix, "scolia_board_runtime")}
          (kiosk_id,connection_state,fallback_active,needs_reconciliation,last_disconnect_reason,last_disconnect_at)
         VALUES (?,'disconnected',1,1,?,NOW(3))
         ON DUPLICATE KEY UPDATE connection_state='disconnected',fallback_active=1,needs_reconciliation=1,
           last_disconnect_reason=VALUES(last_disconnect_reason),last_disconnect_at=NOW(3)`,
        [kioskId, reason],
      );
    });
  }

  async updateRuntimeStatus(kioskIdInput: unknown, payloadInput: unknown): Promise<void> {
    const kioskId = requiredId(kioskIdInput, "kiosk_id");
    const payload = recordOrEmpty(payloadInput);
    const status = nullableString(payload.status ?? payload.boardStatus ?? payload.board_status);
    const phase = nullableString(payload.boardPhase ?? payload.board_phase);
    const error = nullableString(payload.errorType ?? payload.error_type);
    await this.sessions.withConnection((db) => db.execute(
      `INSERT INTO ${this.table(this.runtimePrefix, "scolia_board_runtime")}
        (kiosk_id,connection_state,board_status,board_phase,error_type,last_bridge_heartbeat_at)
       VALUES (?,'connected',?,?,?,NOW(3))
       ON DUPLICATE KEY UPDATE connection_state='connected',board_status=VALUES(board_status),board_phase=VALUES(board_phase),
         error_type=VALUES(error_type),last_bridge_heartbeat_at=NOW(3),connected_at=COALESCE(connected_at,NOW(3))`,
      [kioskId, status, phase, error],
    ).then(() => undefined));
  }

  async recordIncident(clubIdInput: unknown, kioskIdInput: unknown, matchIdInput: unknown, severity: string, category: string, summary: string, details: string): Promise<void> {
    const clubId = requiredId(clubIdInput, "club_id");
    const kioskId = requiredId(kioskIdInput, "kiosk_id");
    const matchId = optionalId(matchIdInput);
    await this.sessions.withConnection((db) => db.execute(
      `INSERT INTO ${this.table(this.runtimePrefix, "scolia_incidents")}
        (club_id,kiosk_id,match_id,severity,category,summary,details,status,first_seen_at,last_seen_at)
       VALUES (?,?,?,?,?,?,?,'open',NOW(3),NOW(3))`,
      [clubId, kioskId, matchId, severity, category, summary, details.slice(0, 6000)],
    ).then(() => undefined));
  }

  async scoringContext(kioskIdInput: unknown): Promise<ScoliaScoringContext | null> {
    const kioskId = requiredId(kioskIdInput, "kiosk_id");
    return this.sessions.withConnection(async (db) => {
      const matches = await db.query<QueryResultRow>(
        `SELECT m.id,m.player_a_id,m.player_b_id,l.id AS leg_id,l.start_score,l.starting_player_id
           FROM ${this.table(this.runtimePrefix, "matches")} m
           INNER JOIN ${this.table(this.runtimePrefix, "legs")} l ON l.match_id=m.id AND l.status='in_progress'
          WHERE m.kiosk_id=? AND m.status='in_progress'
          ORDER BY m.id,l.leg_number DESC LIMIT 1`,
        [kioskId],
      );
      const match = matches[0];
      if (!match) return null;
      const legId = requiredId(match.leg_id, "leg_id");
      const a = requiredId(match.player_a_id, "player_a_id");
      const b = requiredId(match.player_b_id, "player_b_id");
      const starter = requiredId(match.starting_player_id, "starting_player_id");
      const visits = await db.query<QueryResultRow>(
        `SELECT COUNT(*) AS c FROM ${this.table(this.runtimePrefix, "visits")} WHERE leg_id=?`,
        [legId],
      );
      const current = numberValue(visits[0]?.c) % 2 === 0 ? starter : (starter === a ? b : a);
      const remainingRows = await db.query<QueryResultRow>(
        `SELECT remaining_after FROM ${this.table(this.runtimePrefix, "visits")}
          WHERE leg_id=? AND player_id=? ORDER BY id DESC LIMIT 1`,
        [legId, current],
      );
      const remaining = remainingRows[0] ? numberValue(remainingRows[0].remaining_after) : numberValue(match.start_score || 501);
      return { match_id: asDbId(requiredId(match.id, "match_id")), player_id: asDbId(current), remaining };
    });
  }

  async getVisitBuffer(kioskIdInput: unknown): Promise<ScoliaVisitBuffer | null> {
    const kioskId = requiredId(kioskIdInput, "kiosk_id");
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT kiosk_id,match_id,player_id,darts_json,event_ids_json,provider_event_ids_json
           FROM ${this.table(this.runtimePrefix, "scolia_visit_buffers")} WHERE kiosk_id=? LIMIT 1`,
        [kioskId],
      );
      return rows[0] ? bufferRow(rows[0]) : null;
    });
  }

  async saveVisitBuffer(buffer: ScoliaVisitBuffer): Promise<void> {
    await this.sessions.withConnection((db) => db.execute(
      `INSERT INTO ${this.table(this.runtimePrefix, "scolia_visit_buffers")}
        (kiosk_id,match_id,player_id,darts_json,event_ids_json,provider_event_ids_json)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE match_id=VALUES(match_id),player_id=VALUES(player_id),darts_json=VALUES(darts_json),
         event_ids_json=VALUES(event_ids_json),provider_event_ids_json=VALUES(provider_event_ids_json),updated_at=NOW(3)`,
      [buffer.kiosk_id, buffer.match_id, buffer.player_id, JSON.stringify(buffer.darts), JSON.stringify(buffer.event_ids), JSON.stringify(buffer.provider_event_ids)],
    ).then(() => undefined));
  }

  async clearVisitBuffer(kioskIdInput: unknown): Promise<void> {
    const kioskId = requiredId(kioskIdInput, "kiosk_id");
    await this.sessions.withConnection((db) => db.execute(
      `DELETE FROM ${this.table(this.runtimePrefix, "scolia_visit_buffers")} WHERE kiosk_id=?`, [kioskId],
    ).then(() => undefined));
  }

  async setTurnLocked(kioskIdInput: unknown, locked: boolean): Promise<void> {
    const kioskId = requiredId(kioskIdInput, "kiosk_id");
    await this.sessions.withConnection((db) => db.execute(
      `INSERT INTO ${this.table(this.runtimePrefix, "scolia_board_runtime")} (kiosk_id,turn_locked_until_takeout)
       VALUES (?,?) ON DUPLICATE KEY UPDATE turn_locked_until_takeout=VALUES(turn_locked_until_takeout)`,
      [kioskId, locked ? 1 : 0],
    ).then(() => undefined));
  }

  async findVisitByRequestKey(requestKey: string): Promise<string | null> {
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT id FROM ${this.table(this.runtimePrefix, "visits")} WHERE request_key=? ORDER BY id DESC LIMIT 1`,
        [requestKey],
      );
      return rows[0] ? idString(rows[0].id) : null;
    });
  }

  async claimEvents(limitInput: unknown = 25): Promise<ScoliaEventRow[]> {
    const limit = clampInt(limitInput, 1, 25, 25);
    return this.sessions.withTransaction(async (db) => {
      await db.execute(
        `UPDATE ${this.table(this.runtimePrefix, "scolia_events")}
            SET processing_status='failed',next_attempt_at=NOW(3),processing_started_at=NULL,
                last_error=COALESCE(last_error,'Recovered stale Scolia processing lease')
          WHERE processing_status='processing' AND processing_started_at IS NOT NULL
            AND processing_started_at < DATE_SUB(NOW(3),INTERVAL 60 SECOND)`,
      );
      const heads = await db.query<QueryResultRow>(
        `SELECT e.kiosk_id,e.id,e.priority
           FROM ${this.table(this.runtimePrefix, "scolia_events")} e
          WHERE e.processing_status IN ('queued','failed')
            AND (e.attempt_count=0 OR e.next_attempt_at<=NOW(3))
            AND NOT EXISTS (
              SELECT 1 FROM ${this.table(this.runtimePrefix, "scolia_events")} older
               WHERE older.kiosk_id=e.kiosk_id AND older.id<e.id
                 AND older.processing_status IN ('queued','failed','processing','dead_letter')
            )
          ORDER BY e.priority DESC,e.id ASC LIMIT ${limit} FOR UPDATE`,
      );
      if (heads.length === 0) return [];
      const kioskIds = heads.map((row) => requiredId(row.kiosk_id, "kiosk_id"));
      const perBoard = Math.max(1, Math.floor(limit / kioskIds.length));
      const inSql = placeholders(kioskIds.length);
      const rows = await db.query<QueryResultRow>(
        `SELECT e.*
           FROM ${this.table(this.runtimePrefix, "scolia_events")} e
          WHERE e.kiosk_id IN (${inSql}) AND e.processing_status IN ('queued','failed')
            AND (e.attempt_count=0 OR e.next_attempt_at<=NOW(3))
            AND NOT EXISTS (
              SELECT 1 FROM ${this.table(this.runtimePrefix, "scolia_events")} blocker
               WHERE blocker.kiosk_id=e.kiosk_id AND blocker.id<e.id AND (
                 blocker.processing_status IN ('processing','dead_letter') OR
                 (blocker.processing_status IN ('queued','failed') AND blocker.attempt_count>0 AND blocker.next_attempt_at>NOW(3))
               )
            )
            AND (
              SELECT COUNT(*) FROM ${this.table(this.runtimePrefix, "scolia_events")} older
               WHERE older.kiosk_id=e.kiosk_id AND older.id<e.id
                 AND older.processing_status IN ('queued','failed','processing','dead_letter')
            ) < ${perBoard}
          ORDER BY FIELD(e.kiosk_id,${inSql}),e.id ASC FOR UPDATE`,
        [...kioskIds, ...kioskIds],
      );
      if (rows.length > 0) {
        const ids = rows.map((row) => requiredId(row.id, "event_id"));
        await db.execute(
          `UPDATE ${this.table(this.runtimePrefix, "scolia_events")}
              SET processing_status='processing',attempt_count=attempt_count+1,processing_started_at=NOW(3)
            WHERE id IN (${placeholders(ids.length)})`, ids,
        );
      }
      return rows.map(eventRow);
    });
  }

  async releaseClaims(eventIdsInput: readonly unknown[]): Promise<void> {
    const ids = eventIdsInput.map(optionalId).filter((value): value is string => value !== null);
    if (ids.length === 0) return;
    await this.sessions.withConnection((db) => db.execute(
      `UPDATE ${this.table(this.runtimePrefix, "scolia_events")}
          SET processing_status='queued',attempt_count=GREATEST(0,attempt_count-1),processing_started_at=NULL
        WHERE id IN (${placeholders(ids.length)}) AND processing_status='processing'`, ids,
    ).then(() => undefined));
  }

  async markEventProcessed(eventIdInput: unknown, statusInput: unknown, visitIdInput: unknown, metaInput: unknown): Promise<void> {
    const eventId = requiredId(eventIdInput, "event_id");
    const status = stringValue(statusInput) || "processed";
    const visitId = optionalId(visitIdInput);
    const meta = metaInput == null ? null : JSON.stringify(metaInput);
    await this.sessions.withConnection((db) => db.execute(
      `UPDATE ${this.table(this.runtimePrefix, "scolia_events")}
          SET processing_status=?,processed_at=NOW(3),last_error=NULL,canonical_visit_id=?,processing_meta_json=?,processing_started_at=NULL
        WHERE id=?`,
      [status, visitId, meta, eventId],
    ).then(() => undefined));
  }

  async markEventFailed(event: ScoliaEventRow, error: unknown): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 6000);
    const policy = await this.retryPolicy(event.club_id);
    const dead = event.attempt_count >= policy.maxAttempts;
    const delay = Math.min(900, policy.retryBaseSeconds * (2 ** Math.min(8, Math.max(0, event.attempt_count - 1))));
    await this.sessions.withConnection(async (db) => {
      await db.execute(
        `UPDATE ${this.table(this.runtimePrefix, "scolia_events")}
            SET processing_status=?,next_attempt_at=DATE_ADD(NOW(3),INTERVAL ? SECOND),last_error=?,processing_started_at=NULL
          WHERE id=?`,
        [dead ? "dead_letter" : "failed", delay, message, event.id],
      );
      if (dead) {
        await db.execute(
          `INSERT INTO ${this.table(this.runtimePrefix, "scolia_incidents")}
            (club_id,kiosk_id,match_id,severity,category,summary,details,status,first_seen_at,last_seen_at)
           VALUES (?,?,?,'error','event_dead_letter','Scolia-event kunne ikke behandles',?,'open',NOW(3),NOW(3))`,
          [event.club_id, event.kiosk_id, event.match_id, message],
        );
      }
    });
  }

  async runtimeStatus(kioskIdInput: unknown): Promise<Record<string, unknown>> {
    const kioskId = requiredId(kioskIdInput, "kiosk_id");
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT * FROM ${this.table(this.runtimePrefix, "scolia_board_runtime")} WHERE kiosk_id=? LIMIT 1`, [kioskId],
      );
      return rows[0] ? { ...publicRow(rows[0]), kiosk_id: kioskId } : { kiosk_id: kioskId, connection_state: "disconnected", fallback_active: 0, needs_reconciliation: 0, turn_locked_until_takeout: 0 };
    });
  }

  private async retryPolicy(environmentClubId: string): Promise<{ maxAttempts: number; retryBaseSeconds: number }> {
    return this.sessions.withConnection(async (db) => {
      let canonicalClubId = environmentClubId;
      if (this.runtimePrefix !== this.hardwarePrefix) {
        const rows = await db.query<QueryResultRow>(
          `SELECT p.id FROM ${this.table(this.runtimePrefix, "clubs")} t
             INNER JOIN ${this.table(this.hardwarePrefix, "clubs")} p ON p.slug=t.slug WHERE t.id=? LIMIT 1`, [environmentClubId],
        );
        if (rows[0]) canonicalClubId = requiredId(rows[0].id, "canonical_club_id");
      }
      const settings = await db.query<QueryResultRow>(
        `SELECT queue_max_attempts,queue_retry_base_seconds FROM ${this.table(this.hardwarePrefix, "scolia_club_settings")} WHERE club_id=? LIMIT 1`,
        [canonicalClubId],
      );
      return {
        maxAttempts: clampInt(settings[0]?.queue_max_attempts, 1, 20, 8),
        retryBaseSeconds: clampInt(settings[0]?.queue_retry_base_seconds, 1, 300, 2),
      };
    });
  }

  private async boardContextWith(db: SqlExecutor, kioskId: string): Promise<ScoliaBoardContext | null> {
    const runtimeRows = await db.query<QueryResultRow>(
      `SELECT k.id,k.club_id,k.source_kiosk_id,c.slug FROM ${this.table(this.runtimePrefix, "kiosks")} k
         INNER JOIN ${this.table(this.runtimePrefix, "clubs")} c ON c.id=k.club_id WHERE k.id=? AND k.is_active=1 LIMIT 1`,
      [kioskId],
    );
    const runtime = runtimeRows[0];
    if (!runtime) return null;
    const physicalId = this.runtimePrefix === this.hardwarePrefix
      ? kioskId
      : requiredId(runtime.source_kiosk_id, "physical_kiosk_id");
    const physicalRows = await db.query<QueryResultRow>(
      `SELECT k.id,k.club_id,c.slug,k.scoring_mode,s.serial_number,s.mode,s.auto_fallback_to_manual
         FROM ${this.table(this.hardwarePrefix, "kiosks")} k
         INNER JOIN ${this.table(this.hardwarePrefix, "clubs")} c ON c.id=k.club_id
         LEFT JOIN ${this.table(this.hardwarePrefix, "scolia_board_settings")} s ON s.kiosk_id=k.id
        WHERE k.id=? AND k.is_active=1 LIMIT 1`,
      [physicalId],
    );
    const physical = physicalRows[0];
    if (!physical || stringValue(physical.slug) !== stringValue(runtime.slug)) return null;
    const stateRows = await db.query<QueryResultRow>(
      `SELECT * FROM ${this.table(this.runtimePrefix, "scolia_board_runtime")} WHERE kiosk_id=? LIMIT 1`, [kioskId],
    );
    const state = stateRows[0] ?? {};
    return {
      ...publicRow(physical), ...publicRow(state),
      kiosk_id: kioskId,
      physical_kiosk_id: physicalId,
      club_id: requiredId(runtime.club_id, "club_id"),
      mode: stringValue(physical.mode) || (stringValue(physical.scoring_mode) === "scolia" ? "live" : "off"),
      fallback_active: numberValue(state.fallback_active),
      needs_reconciliation: numberValue(state.needs_reconciliation),
      turn_locked_until_takeout: numberValue(state.turn_locked_until_takeout),
    };
  }

  private table(prefix: TablePrefix, name: string): string {
    return `\`${prefix}${name}\``;
  }
}

function eventPriority(type: string): number {
  if (type === "THROW_DETECTED") return 100;
  if (["TAKEOUT_STARTED", "TAKEOUT_FINISHED"].includes(type)) return 95;
  if (["BRIDGE_DISCONNECTED", "BRIDGE_ERROR"].includes(type)) return 90;
  if (type === "HELLO_CLIENT") return 50;
  if (type === "BRIDGE_CONNECTED") return 40;
  if (["SBC_STATUS_CHANGED", "SBC_BOARD_AVAILABILITY_CHANGED"].includes(type)) return 30;
  return 50;
}

function eventRow(row: QueryResultRow): ScoliaEventRow {
  return {
    ...publicRow(row),
    id: requiredId(row.id, "event_id"),
    club_id: requiredId(row.club_id, "club_id"),
    kiosk_id: requiredId(row.kiosk_id, "kiosk_id"),
    match_id: optionalId(row.match_id),
    provider_event_id: nullableString(row.provider_event_id),
    event_type: stringValue(row.event_type) || "UNKNOWN",
    priority: numberValue(row.priority || 50),
    attempt_count: numberValue(row.attempt_count) + 1,
    payload: parseObject(row.payload_json),
  };
}

function bufferRow(row: QueryResultRow): ScoliaVisitBuffer {
  return {
    kiosk_id: requiredId(row.kiosk_id, "kiosk_id"),
    match_id: requiredId(row.match_id, "match_id"),
    player_id: requiredId(row.player_id, "player_id"),
    darts: parseArray(row.darts_json) as NormalizedDart[],
    event_ids: parseArray(row.event_ids_json).map((value) => String(value)),
    provider_event_ids: parseArray(row.provider_event_ids_json).map((value) => String(value)),
  };
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainValidationError("scolia_event_invalid", `${name} must be a JSON object.`, 422);
  }
  return value as Record<string, unknown>;
}
function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value)
    ? value as Record<string, unknown>
    : {};
}
function parseObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value)) {
    return value as Record<string, unknown>;
  }
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : "";
  if (text.trim() === "") return {};
  try { return recordOrEmpty(JSON.parse(text)); } catch { return {}; }
}
function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : "";
  if (text.trim() === "") return [];
  try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function requiredId(value: unknown, name: string): string {
  const id = optionalId(value);
  if (id === null) throw new DomainValidationError(`invalid_${name}`, `${name} must be a positive decimal id.`);
  return id;
}
function optionalId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}
function idString(value: unknown): string | null {
  return optionalId(value);
}
function stringValue(value: unknown): string { return String(value ?? "").trim(); }
function nullableString(value: unknown): string | null { const v = stringValue(value); return v === "" ? null : v; }
function numberValue(value: unknown): number { const n = Number(value ?? 0); return Number.isFinite(n) ? n : 0; }
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value); return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function placeholders(count: number): string { return Array.from({ length: count }, () => "?").join(","); }
function providerDateTime(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace("T", " ").replace("Z", "");
}
function publicRow(row: QueryResultRow): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]));
}
