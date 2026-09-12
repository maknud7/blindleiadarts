import { randomUUID } from "node:crypto";

import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

export class MySqlScoliaAdminRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
    private readonly hardwarePrefix: TablePrefix,
  ) {}

  scope(): Record<string, unknown> {
    return {
      configuration_scope: "production_hardware",
      shared_across_environments: true,
      configuration_table_prefix: this.hardwarePrefix,
      runtime_table_prefix: this.runtimePrefix,
    };
  }

  async getClubSettings(environmentClubIdInput: unknown, includeSecret = false): Promise<Record<string, unknown>> {
    const environmentClubId = requiredId(environmentClubIdInput, "club_id");
    return this.sessions.withConnection((db) => this.getClubSettingsWith(db, environmentClubId, includeSecret));
  }

  async updateClubSettings(
    environmentClubIdInput: unknown,
    payload: Record<string, unknown>,
    userIdInput: unknown,
  ): Promise<Record<string, unknown>> {
    const environmentClubId = requiredId(environmentClubIdInput, "club_id");
    const userId = requiredId(userIdInput, "user_id");
    return this.sessions.withTransaction(async (db) => {
      const canonicalClubId = await this.canonicalClubIdWith(db, environmentClubId);
      const current = await this.getClubSettingsWith(db, environmentClubId, true);
      let token = payload.access_token === undefined ? stringValue(current.access_token) : stringValue(payload.access_token);
      if (token === "********" || token.startsWith("••••")) token = stringValue(current.access_token);
      const enabled = boolInt(payload.enabled ?? current.enabled);
      const force = boolInt(payload.force_connect ?? current.force_connect);
      const forward = boolInt(payload.forward_messages_to_scolia ?? current.forward_messages_to_scolia);
      const fallback = boolInt(payload.disconnect_fallback_enabled ?? current.disconnect_fallback_enabled);
      const maxAttempts = clampInt(payload.queue_max_attempts ?? current.queue_max_attempts, 1, 20, 8);
      const retryBase = clampInt(payload.queue_retry_base_seconds ?? current.queue_retry_base_seconds, 1, 300, 2);
      const retention = clampInt(payload.event_retention_days ?? current.event_retention_days, 1, 365, 30);
      await db.execute(
        `INSERT INTO \`${this.hardwarePrefix}scolia_club_settings\`
          (club_id,enabled,access_token,force_connect,forward_messages_to_scolia,disconnect_fallback_enabled,
           queue_max_attempts,queue_retry_base_seconds,event_retention_days,updated_by_user_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),access_token=VALUES(access_token),
           force_connect=VALUES(force_connect),forward_messages_to_scolia=VALUES(forward_messages_to_scolia),
           disconnect_fallback_enabled=VALUES(disconnect_fallback_enabled),queue_max_attempts=VALUES(queue_max_attempts),
           queue_retry_base_seconds=VALUES(queue_retry_base_seconds),event_retention_days=VALUES(event_retention_days),
           updated_by_user_id=VALUES(updated_by_user_id)`,
        [canonicalClubId, enabled, token, force, forward, fallback, maxAttempts, retryBase, retention, userId],
      );
      return this.getClubSettingsWith(db, environmentClubId, false);
    });
  }

  async listBoards(environmentClubIdInput: unknown): Promise<Record<string, unknown>[]> {
    const environmentClubId = requiredId(environmentClubIdInput, "club_id");
    return this.sessions.withConnection((db) => this.listBoardsWith(db, environmentClubId));
  }

  async getBoardSettings(environmentClubIdInput: unknown, kioskIdInput: unknown): Promise<Record<string, unknown> | null> {
    const environmentClubId = requiredId(environmentClubIdInput, "club_id");
    const kioskId = requiredId(kioskIdInput, "kiosk_id");
    return this.sessions.withConnection((db) => this.getBoardSettingsWith(db, environmentClubId, kioskId));
  }

  async updateBoardSettings(
    environmentClubIdInput: unknown,
    kioskIdInput: unknown,
    payload: Record<string, unknown>,
    userIdInput: unknown,
  ): Promise<Record<string, unknown> | null> {
    const environmentClubId = requiredId(environmentClubIdInput, "club_id");
    const kioskId = requiredId(kioskIdInput, "kiosk_id");
    const userId = requiredId(userIdInput, "user_id");
    return this.sessions.withTransaction(async (db) => {
      const current = await this.getBoardSettingsWith(db, environmentClubId, kioskId);
      if (!current) return null;
      if (payload.bridge_attached !== undefined) {
        if (typeof payload.bridge_attached !== "boolean") {
throw new DomainValidationError("bridge_attached_required", "bridge_attached must be true or false.");
        }
        return this.setBridgeAttachedWith(db, environmentClubId, kioskId, current, payload.bridge_attached, userId);
      }
      const physicalId = requiredId(current.physical_kiosk_id, "physical_kiosk_id");
      let serial = payload.serial_number === undefined ? nullableString(current.serial_number) : nullableString(payload.serial_number);
      if (serial) serial = serial.toUpperCase();
      let mode = stringValue(payload.mode ?? current.mode ?? "off").toLowerCase();
      if (mode === "shadow") mode = "live";
      if (mode !== "off" && mode !== "live") throw new DomainValidationError("invalid_scolia_mode", "Scolia-board kan bare bruke live scoring.");
      if (mode === "live" && !serial) throw new DomainValidationError("scolia_serial_required", "Serialnummer må settes før Scolia kan aktiveres.");
      const autoFallback = boolInt(payload.auto_fallback_to_manual ?? current.auto_fallback_to_manual ?? 1);
      const forceOverride = payload.force_connect_override === undefined ? nullableBoolInt(current.force_connect_override) : nullableBoolInt(payload.force_connect_override);
      const forwardOverride = payload.forward_messages_override === undefined ? nullableBoolInt(current.forward_messages_override) : nullableBoolInt(payload.forward_messages_override);
      if (serial) {
        const conflicts = await db.query<QueryResultRow>(
          `SELECT kiosk_id FROM \`${this.hardwarePrefix}scolia_board_settings\` WHERE serial_number=? AND kiosk_id<>? LIMIT 1 FOR UPDATE`,
          [serial, physicalId],
        );
        if (conflicts.length > 0) throw new DomainValidationError("scolia_serial_in_use", "Dette Scolia-serienummeret er allerede koblet til en annen fysisk skive.", 409);
      }
      await db.execute(
        `INSERT INTO \`${this.hardwarePrefix}scolia_board_settings\`
          (kiosk_id,serial_number,mode,auto_fallback_to_manual,force_connect_override,forward_messages_override,updated_by_user_id)
         VALUES (?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE serial_number=VALUES(serial_number),mode=VALUES(mode),
           auto_fallback_to_manual=VALUES(auto_fallback_to_manual),force_connect_override=VALUES(force_connect_override),
           forward_messages_override=VALUES(forward_messages_override),updated_by_user_id=VALUES(updated_by_user_id)`,
        [physicalId, serial, mode, autoFallback, forceOverride, forwardOverride, userId],
      );
      await db.execute(
        `UPDATE \`${this.hardwarePrefix}kiosks\` SET scoring_mode=? WHERE id=?`,
        [mode === "live" ? "scolia" : "manual", physicalId],
      );
      if (this.runtimePrefix === this.hardwarePrefix) {
        const runtimeState = mode === "off" ? "disabled" : "disconnected";
        await db.execute(
          `INSERT INTO \`${this.runtimePrefix}scolia_board_runtime\` (kiosk_id,connection_state) VALUES (?,?)
           ON DUPLICATE KEY UPDATE connection_state=IF(?='disabled','disabled',IF(connection_state='disabled','disconnected',connection_state))`,
          [physicalId, runtimeState, runtimeState],
        );
      }
      return this.getBoardSettingsWith(db, environmentClubId, kioskId);
    });
  }

  async adminDashboard(environmentClubIdInput: unknown): Promise<Record<string, unknown>> {
    const clubId = requiredId(environmentClubIdInput, "club_id");
    return this.sessions.withConnection(async (db) => {
      const [boards, settings, incidents, failedEvents, queue] = await Promise.all([
        this.listBoardsWith(db, clubId),
        this.getClubSettingsWith(db, clubId, false),
        db.query<QueryResultRow>(
          `SELECT i.*,k.name AS kiosk_name,k.board_number FROM \`${this.runtimePrefix}scolia_incidents\` i
           LEFT JOIN \`${this.runtimePrefix}kiosks\` k ON k.id=i.kiosk_id
           WHERE i.club_id=? AND i.status='open'
           ORDER BY FIELD(i.severity,'critical','error','warning','info'),i.last_seen_at DESC LIMIT 100`,
          [clubId],
        ),
        db.query<QueryResultRow>(
          `SELECT e.id,e.kiosk_id,k.board_number,e.match_id,e.event_type,e.processing_status,e.attempt_count,e.received_at,e.last_error
           FROM \`${this.runtimePrefix}scolia_events\` e INNER JOIN \`${this.runtimePrefix}kiosks\` k ON k.id=e.kiosk_id
           WHERE e.club_id=? AND e.processing_status IN ('failed','dead_letter') ORDER BY e.id DESC LIMIT 100`,
          [clubId],
        ),
        this.queueCountsWith(db, clubId, null),
      ]);
      return { settings, queue, boards, incidents: incidents.map(publicRow), failed_events: failedEvents.map(publicRow), ...this.scope() };
    });
  }

  async fallback(environmentClubIdInput: unknown, kioskIdInput: unknown): Promise<Record<string, unknown>> {
    const clubId = requiredId(environmentClubIdInput, "club_id");
    const kioskId = requiredId(kioskIdInput, "kiosk_id");
    return this.sessions.withTransaction(async (db) => {
      const board = await this.getBoardSettingsWith(db, clubId, kioskId);
      if (!board) throw new DomainValidationError("kiosk_not_found", "Boardet ble ikke funnet.", 404);
      const runtimeId = requiredRuntimeId(board);
      await this.markDisconnectedWith(db, clubId, runtimeId, "Manuell fallback aktivert av admin.");
      return this.getRuntimeStatusWith(db, clubId, kioskId);
    });
  }

  async resetPhase(environmentClubIdInput: unknown, kioskIdInput: unknown, userIdInput: unknown): Promise<Record<string, unknown>> {
    const clubId = requiredId(environmentClubIdInput, "club_id");
    const kioskId = requiredId(kioskIdInput, "kiosk_id");
    const userId = requiredId(userIdInput, "user_id");
    return this.sessions.withTransaction(async (db) => {
      const board = await this.getBoardSettingsWith(db, clubId, kioskId);
      if (!board) throw new DomainValidationError("kiosk_not_found", "Boardet ble ikke funnet.", 404);
      const runtimeId = requiredRuntimeId(board);
      await db.execute(`DELETE FROM \`${this.runtimePrefix}scolia_visit_buffers\` WHERE kiosk_id=?`, [runtimeId]);
      await db.execute(
        `INSERT INTO \`${this.runtimePrefix}scolia_board_runtime\` (kiosk_id,turn_locked_until_takeout) VALUES (?,0)
         ON DUPLICATE KEY UPDATE turn_locked_until_takeout=0`,
        [runtimeId],
      );
      return this.queueCommandWith(db, clubId, runtimeId, "RESET_PHASE", {}, userId);
    });
  }

  async resume(environmentClubIdInput: unknown, kioskIdInput: unknown, userIdInput: unknown): Promise<Record<string, unknown>> {
    const clubId = requiredId(environmentClubIdInput, "club_id");
    const kioskId = requiredId(kioskIdInput, "kiosk_id");
    const userId = requiredId(userIdInput, "user_id");
    return this.sessions.withTransaction(async (db) => {
      const board = await this.getBoardSettingsWith(db, clubId, kioskId);
      if (!board) throw new DomainValidationError("kiosk_not_found", "Boardet ble ikke funnet.", 404);
      const runtimeId = requiredRuntimeId(board);
      await db.execute(
        `UPDATE \`${this.runtimePrefix}scolia_board_runtime\`
            SET fallback_active=0,needs_reconciliation=0,turn_locked_until_takeout=0,last_reconciled_at=NOW(3)
          WHERE kiosk_id=?`,
        [runtimeId],
      );
      await db.execute(`DELETE FROM \`${this.runtimePrefix}scolia_visit_buffers\` WHERE kiosk_id=?`, [runtimeId]);
      await db.execute(
        `UPDATE \`${this.runtimePrefix}scolia_incidents\`
            SET status='resolved',resolved_at=NOW(3),resolved_by_user_id=?
          WHERE club_id=? AND kiosk_id=? AND status='open'
            AND category IN ('connection_lost_during_match','reconciliation_required')`,
        [userId, clubId, runtimeId],
      );
      return this.queueCommandWith(db, clubId, runtimeId, "RESET_PHASE", {}, userId);
    });
  }

  async resolveIncident(clubIdInput: unknown, incidentIdInput: unknown, userIdInput: unknown): Promise<boolean> {
    const clubId = requiredId(clubIdInput, "club_id");
    const incidentId = requiredId(incidentIdInput, "incident_id");
    const userId = requiredId(userIdInput, "user_id");
    return this.sessions.withConnection(async (db) => {
      const result = await db.execute(
        `UPDATE \`${this.runtimePrefix}scolia_incidents\`
            SET status='resolved',resolved_at=NOW(3),resolved_by_user_id=?
          WHERE id=? AND club_id=? AND status='open'`,
        [userId, incidentId, clubId],
      );
      return result.affectedRows > 0;
    });
  }

  async retryDeadLetter(clubIdInput: unknown, eventIdInput: unknown): Promise<boolean> {
    const clubId = requiredId(clubIdInput, "club_id");
    const eventId = requiredId(eventIdInput, "event_id");
    return this.sessions.withConnection(async (db) => {
      const result = await db.execute(
        `UPDATE \`${this.runtimePrefix}scolia_events\`
            SET processing_status='queued',attempt_count=0,next_attempt_at=NOW(3),last_error=NULL
          WHERE id=? AND club_id=? AND processing_status='dead_letter'`,
        [eventId, clubId],
      );
      return result.affectedRows > 0;
    });
  }

  async cleanupOldEvents(clubIdInput: unknown): Promise<number> {
    const clubId = requiredId(clubIdInput, "club_id");
    return this.sessions.withTransaction(async (db) => {
      const settings = await this.getClubSettingsWith(db, clubId, true);
      const days = clampInt(settings.event_retention_days, 1, 365, 30);
      const result = await db.execute(
        `DELETE FROM \`${this.runtimePrefix}scolia_events\`
          WHERE club_id=? AND processing_status IN ('processed','ignored')
            AND received_at<DATE_SUB(NOW(),INTERVAL ? DAY)`,
        [clubId, days],
      );
      return result.affectedRows;
    });
  }

  private async getClubSettingsWith(db: SqlExecutor, environmentClubId: string, includeSecret: boolean): Promise<Record<string, unknown>> {
    const canonicalClubId = await this.canonicalClubIdWith(db, environmentClubId);
    const rows = await db.query<QueryResultRow>(
      `SELECT * FROM \`${this.hardwarePrefix}scolia_club_settings\` WHERE club_id=? LIMIT 1`,
      [canonicalClubId],
    );
    const row = rows[0] ?? {};
    const settings: Record<string, unknown> = {
      club_id: environmentClubId,
      canonical_club_id: canonicalClubId,
      enabled: 0,
      access_token: null,
      force_connect: 1,
      forward_messages_to_scolia: 0,
      disconnect_fallback_enabled: 1,
      queue_max_attempts: 8,
      queue_retry_base_seconds: 2,
      event_retention_days: 30,
      ...publicRow(row),
      ...this.scope(),
    };
    settings.club_id = environmentClubId;
    settings.canonical_club_id = canonicalClubId;
    const token = stringValue(settings.access_token);
    if (!includeSecret) {
      delete settings.access_token;
      settings.access_token_configured = token !== "";
      settings.access_token_masked = token === "" ? "" : `••••••••${token.slice(-4)}`;
    }
    return settings;
  }

  private async listBoardsWith(db: SqlExecutor, environmentClubId: string): Promise<Record<string, unknown>[]> {
    const canonicalClubId = await this.canonicalClubIdWith(db, environmentClubId);
    const rows = await db.query<QueryResultRow>(
      `SELECT k.id,k.code,k.name,k.board_number,k.scoring_mode,k.is_active,
              s.serial_number,s.mode,s.auto_fallback_to_manual
         FROM \`${this.hardwarePrefix}kiosks\` k
         LEFT JOIN \`${this.hardwarePrefix}scolia_board_settings\` s ON s.kiosk_id=k.id
        WHERE k.club_id=? AND k.is_active=1 ORDER BY k.board_number,k.id`,
      [canonicalClubId],
    );
    const result: Record<string, unknown>[] = [];
    for (const row of rows) {
      const physicalId = requiredId(row.id, "physical_kiosk_id");
      const runtimeId = await this.runtimeKioskIdWith(db, environmentClubId, physicalId);
      let runtime: QueryResultRow = {};
      if (runtimeId) {
        const runtimeRows = await db.query<QueryResultRow>(
          `SELECT connection_state,board_status,board_phase,error_type,fallback_active,needs_reconciliation,
                  last_bridge_heartbeat_at,last_event_at,last_disconnect_at,last_disconnect_reason
             FROM \`${this.runtimePrefix}scolia_board_runtime\` WHERE kiosk_id=? LIMIT 1`,
          [runtimeId],
        );
        runtime = runtimeRows[0] ?? {};
      }
      const mode = stringValue(row.mode) || (stringValue(row.scoring_mode) === "scolia" ? "live" : "off");
      result.push({
        ...publicRow(row),
        ...publicRow(runtime),
        id: runtimeId ?? physicalId,
        physical_kiosk_id: physicalId,
        runtime_kiosk_id: runtimeId,
        mode,
        connection_state: stringValue(runtime.connection_state) || (mode === "off" ? "disabled" : "disconnected"),
        fallback_active: numberValue(runtime.fallback_active),
        needs_reconciliation: numberValue(runtime.needs_reconciliation),
        ...this.scope(),
      });
    }
    return result;
  }

  private async getBoardSettingsWith(db: SqlExecutor, environmentClubId: string, kioskId: string): Promise<Record<string, unknown> | null> {
    const resolved = await this.resolvePhysicalBoardWith(db, environmentClubId, kioskId);
    if (!resolved) return null;
    const rows = await db.query<QueryResultRow>(
      `SELECT k.id,k.club_id,k.code,k.name,k.board_number,k.scoring_mode,k.is_active,
              s.serial_number,s.mode,s.auto_fallback_to_manual,s.force_connect_override,s.forward_messages_override
         FROM \`${this.hardwarePrefix}kiosks\` k
         LEFT JOIN \`${this.hardwarePrefix}scolia_board_settings\` s ON s.kiosk_id=k.id
        WHERE k.club_id=? AND k.id=? LIMIT 1`,
      [resolved.canonicalClubId, resolved.physicalId],
    );
    const row = rows[0];
    if (!row) return null;
    let runtime: QueryResultRow = {};
    if (resolved.runtimeId) {
      const runtimeRows = await db.query<QueryResultRow>(
        `SELECT connection_state,board_status,board_phase,error_type,fallback_active,needs_reconciliation,
                turn_locked_until_takeout,last_disconnect_reason,last_bridge_heartbeat_at,connected_at,
                last_event_at,last_disconnect_at,last_reconciled_at
           FROM \`${this.runtimePrefix}scolia_board_runtime\` WHERE kiosk_id=? LIMIT 1`,
        [resolved.runtimeId],
      );
      runtime = runtimeRows[0] ?? {};
    }
    const mode = stringValue(row.mode) || (stringValue(row.scoring_mode) === "scolia" ? "live" : "off");
    const serial = stringValue(row.serial_number);
    const isScolia = stringValue(row.scoring_mode).toLowerCase() === "scolia" && serial !== "";
    const bridgeAttached = isScolia && mode === "live";
    return {
      ...publicRow(row),
      ...publicRow(runtime),
      id: kioskId,
      physical_kiosk_id: resolved.physicalId,
      runtime_kiosk_id: resolved.runtimeId,
      environment_club_id: environmentClubId,
      canonical_club_id: resolved.canonicalClubId,
      mode,
      is_scolia: isScolia,
      bridge_attached: bridgeAttached,
      bridge_released: isScolia && !bridgeAttached,
      direct_scolia_ready: isScolia && !bridgeAttached,
      can_change_bridge: this.runtimePrefix === this.hardwarePrefix,
      release_effective_within_seconds: 12,
      auto_fallback_to_manual: row.auto_fallback_to_manual == null ? 1 : numberValue(row.auto_fallback_to_manual),
      connection_state: stringValue(runtime.connection_state) || (mode === "off" ? "disabled" : "disconnected"),
      fallback_active: numberValue(runtime.fallback_active),
      needs_reconciliation: numberValue(runtime.needs_reconciliation),
      turn_locked_until_takeout: numberValue(runtime.turn_locked_until_takeout),
      ...this.scope(),
    };
  }

  private async setBridgeAttachedWith(
    db: SqlExecutor,
    clubId: string,
    kioskId: string,
    current: Record<string, unknown>,
    attached: boolean,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const physicalId = requiredId(current.physical_kiosk_id, "physical_kiosk_id");
    const runtimeId = optionalId(current.runtime_kiosk_id);
    const serial = stringValue(current.serial_number);
    const isScolia = stringValue(current.scoring_mode).toLowerCase() === "scolia" && serial !== "";
    if (!isScolia) {
      throw new DomainValidationError("scolia_not_configured", "Denne skiva er ikke konfigurert som en fysisk Scolia-skive.", 409);
    }

    const currentAttached = stringValue(current.mode).toLowerCase() === "live";
    if (currentAttached === attached) {
      return { ...current, bridge_changed: false };
    }

    if (!attached && runtimeId) {
      await this.markDisconnectedWith(db, clubId, runtimeId, "Scolia frikoblet fra Blindleia av admin.");
    }

    const newMode = attached ? "live" : "off";
    const updated = await db.execute(
      `UPDATE \`${this.hardwarePrefix}scolia_board_settings\` SET mode=?,updated_by_user_id=? WHERE kiosk_id=?`,
      [newMode, userId, physicalId],
    );
    if (updated.affectedRows < 1) {
      throw new DomainValidationError("scolia_bridge_update_failed", "Scolia-innstillingen kunne ikke oppdateres.", 500);
    }

    if (attached) {
      await db.execute(
        `INSERT INTO \`${this.hardwarePrefix}scolia_board_runtime\` (kiosk_id,connection_state,board_status,board_phase,error_type,connected_at)
         VALUES (?,'disconnected',NULL,NULL,NULL,NULL)
         ON DUPLICATE KEY UPDATE connection_state='disconnected',board_status=NULL,board_phase=NULL,error_type=NULL,connected_at=NULL`,
        [physicalId],
      );
    } else {
      const reason = "Frikoblet fra Blindleia av admin.";
      await db.execute(
        `INSERT INTO \`${this.hardwarePrefix}scolia_board_runtime\`
(kiosk_id,connection_state,board_status,board_phase,error_type,last_disconnect_reason,last_disconnect_at,connected_at)
         VALUES (?,'disabled',NULL,NULL,NULL,?,NOW(3),NULL)
         ON DUPLICATE KEY UPDATE connection_state='disabled',board_status=NULL,board_phase=NULL,error_type=NULL,
 last_disconnect_reason=VALUES(last_disconnect_reason),last_disconnect_at=NOW(3),connected_at=NULL`,
        [physicalId, reason],
      );
      await db.execute(`DELETE FROM \`${this.hardwarePrefix}scolia_test_leases\` WHERE physical_kiosk_id=?`, [physicalId]);
      await db.execute(
        `UPDATE \`${this.hardwarePrefix}scolia_commands\`
  SET status='expired',completed_at=NOW(3),last_error=?
WHERE kiosk_id=? AND status IN ('queued','delivered','failed')`,
        [reason, physicalId],
      );
    }

    const fresh = await this.getBoardSettingsWith(db, clubId, kioskId);
    if (!fresh) throw new DomainValidationError("kiosk_not_found", "Skiva forsvant etter Scolia-frikobling.", 404);
    return { ...fresh, bridge_changed: true };
  }

  private async getRuntimeStatusWith(db: SqlExecutor, clubId: string, kioskId: string): Promise<Record<string, unknown>> {
    const board = await this.getBoardSettingsWith(db, clubId, kioskId);
    if (!board) throw new DomainValidationError("kiosk_not_found", "Boardet ble ikke funnet.", 404);
    const runtimeId = requiredRuntimeId(board);
    const buffers = await db.query<QueryResultRow>(
      `SELECT match_id,player_id,darts_json,updated_at FROM \`${this.runtimePrefix}scolia_visit_buffers\` WHERE kiosk_id=? LIMIT 1`,
      [runtimeId],
    );
    const buffer = buffers[0];
    const queue = await this.queueCountsWith(db, clubId, runtimeId);
    return {
      ...board,
      effective_scoring_mode: numberValue(board.fallback_active) === 1 || numberValue(board.needs_reconciliation) === 1
        ? "manual"
        : stringValue(board.mode) === "live" ? "scolia" : "manual",
      buffer: buffer ? {
        match_id: optionalId(buffer.match_id),
        player_id: optionalId(buffer.player_id),
        darts: parseJsonArray(buffer.darts_json),
        updated_at: buffer.updated_at ?? null,
      } : null,
      queue,
    };
  }

  private async markDisconnectedWith(db: SqlExecutor, clubId: string, runtimeId: string, reasonInput: string): Promise<void> {
    const reason = reasonInput.slice(0, 255);
    const matches = await db.query<QueryResultRow>(
      `SELECT id FROM \`${this.runtimePrefix}matches\` WHERE kiosk_id=? AND status='in_progress' ORDER BY id LIMIT 1`,
      [runtimeId],
    );
    const fallback = matches.length > 0 ? 1 : 0;
    await db.execute(
      `INSERT INTO \`${this.runtimePrefix}scolia_board_runtime\`
        (kiosk_id,connection_state,fallback_active,needs_reconciliation,last_disconnect_reason,last_disconnect_at,connected_at)
       VALUES (?,'disconnected',?,?,?,NOW(3),NULL)
       ON DUPLICATE KEY UPDATE connection_state='disconnected',fallback_active=GREATEST(fallback_active,VALUES(fallback_active)),
         needs_reconciliation=GREATEST(needs_reconciliation,VALUES(needs_reconciliation)),last_disconnect_reason=VALUES(last_disconnect_reason),
         last_disconnect_at=NOW(3),connected_at=NULL`,
      [runtimeId, fallback, fallback, reason],
    );
    if (fallback) {
      const existing = await db.query<QueryResultRow>(
        `SELECT id FROM \`${this.runtimePrefix}scolia_incidents\`
          WHERE club_id=? AND kiosk_id=? AND status='open' AND category='connection_lost_during_match' LIMIT 1`,
        [clubId, runtimeId],
      );
      if (existing[0]) {
        await db.execute(
          `UPDATE \`${this.runtimePrefix}scolia_incidents\`
              SET severity='critical',summary=?,details=?,last_seen_at=NOW(3),occurrence_count=occurrence_count+1,match_id=COALESCE(?,match_id)
            WHERE id=?`,
          ["Scolia mistet forbindelsen under kamp – manuell fallback er aktiv", reason, optionalId(matches[0]?.id), requiredId(existing[0].id, "incident_id")],
        );
      } else {
        await db.execute(
          `INSERT INTO \`${this.runtimePrefix}scolia_incidents\`
            (club_id,kiosk_id,match_id,severity,category,summary,details,context_json)
           VALUES (?,?,?,'critical','connection_lost_during_match',?,?,?)`,
          [clubId, runtimeId, optionalId(matches[0]?.id), "Scolia mistet forbindelsen under kamp – manuell fallback er aktiv", reason, JSON.stringify({ fallback_active: true })],
        );
      }
    }
  }

  private async queueCommandWith(
    db: SqlExecutor,
    clubId: string,
    kioskId: string,
    type: string,
    payload: Record<string, unknown>,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const messageId = randomUUID();
    const payloadJson = Object.keys(payload).length === 0 ? null : JSON.stringify(payload);
    const result = await db.execute(
      `INSERT INTO \`${this.runtimePrefix}scolia_commands\`
        (club_id,kiosk_id,command_type,message_id,payload_json,created_by_user_id)
       VALUES (?,?,?,?,?,?)`,
      [clubId, kioskId, type, messageId, payloadJson, userId],
    );
    return { id: requiredId(result.insertId, "command_id"), message_id: messageId, type, payload };
  }

  private async queueCountsWith(db: SqlExecutor, clubId: string, kioskId: string | null): Promise<Record<string, number>> {
    const rows = kioskId === null
      ? await db.query<QueryResultRow>(
          `SELECT processing_status,COUNT(*) AS c FROM \`${this.runtimePrefix}scolia_events\` WHERE club_id=? GROUP BY processing_status`,
          [clubId],
        )
      : await db.query<QueryResultRow>(
          `SELECT processing_status,COUNT(*) AS c FROM \`${this.runtimePrefix}scolia_events\` WHERE club_id=? AND kiosk_id=? GROUP BY processing_status`,
          [clubId, kioskId],
        );
    const counts: Record<string, number> = { queued: 0, processing: 0, processed: 0, ignored: 0, failed: 0, dead_letter: 0 };
    for (const row of rows) counts[stringValue(row.processing_status)] = numberValue(row.c);
    return counts;
  }

  private async resolvePhysicalBoardWith(
    db: SqlExecutor,
    environmentClubId: string,
    kioskId: string,
  ): Promise<{ physicalId: string; runtimeId: string | null; canonicalClubId: string } | null> {
    const canonicalClubId = await this.canonicalClubIdWith(db, environmentClubId);
    if (this.runtimePrefix === this.hardwarePrefix) {
      const rows = await db.query<QueryResultRow>(
        `SELECT id FROM \`${this.hardwarePrefix}kiosks\` WHERE id=? AND club_id=? LIMIT 1`,
        [kioskId, canonicalClubId],
      );
      return rows[0] ? { physicalId: kioskId, runtimeId: kioskId, canonicalClubId } : null;
    }
    const runtimeRows = await db.query<QueryResultRow>(
      `SELECT id,source_kiosk_id FROM \`${this.runtimePrefix}kiosks\` WHERE id=? AND club_id=? LIMIT 1`,
      [kioskId, environmentClubId],
    );
    if (runtimeRows[0]) {
      const physicalId = optionalId(runtimeRows[0].source_kiosk_id);
      if (!physicalId) throw new DomainValidationError("scolia_prod_hardware_required", "Scolia kan bare konfigureres på en fysisk PROD-skive. TEST-skiver har ikke egne Scolia-innstillinger.", 409);
      return { physicalId, runtimeId: requiredId(runtimeRows[0].id, "runtime_kiosk_id"), canonicalClubId };
    }
    const physicalRows = await db.query<QueryResultRow>(
      `SELECT id FROM \`${this.hardwarePrefix}kiosks\` WHERE id=? AND club_id=? LIMIT 1`,
      [kioskId, canonicalClubId],
    );
    if (!physicalRows[0]) return null;
    return { physicalId: kioskId, runtimeId: await this.runtimeKioskIdWith(db, environmentClubId, kioskId), canonicalClubId };
  }

  private async runtimeKioskIdWith(db: SqlExecutor, environmentClubId: string, physicalId: string): Promise<string | null> {
    if (this.runtimePrefix === this.hardwarePrefix) return physicalId;
    const rows = await db.query<QueryResultRow>(
      `SELECT id FROM \`${this.runtimePrefix}kiosks\` WHERE club_id=? AND source_kiosk_id=? AND is_active=1 LIMIT 1`,
      [environmentClubId, physicalId],
    );
    return rows[0] ? requiredId(rows[0].id, "runtime_kiosk_id") : null;
  }

  private async canonicalClubIdWith(db: SqlExecutor, environmentClubId: string): Promise<string> {
    if (this.runtimePrefix === this.hardwarePrefix) return environmentClubId;
    const environmentRows = await db.query<QueryResultRow>(
      `SELECT slug FROM \`${this.runtimePrefix}clubs\` WHERE id=? LIMIT 1`,
      [environmentClubId],
    );
    const slug = stringValue(environmentRows[0]?.slug);
    if (!slug) throw new DomainValidationError("club_not_found", "Klubben finnes ikke i dette miljøet.", 404);
    const canonicalRows = await db.query<QueryResultRow>(
      `SELECT id FROM \`${this.hardwarePrefix}clubs\` WHERE slug=? LIMIT 1`,
      [slug],
    );
    if (!canonicalRows[0]) throw new DomainValidationError("canonical_hardware_club_missing", "Klubben mangler canonical PROD-utstyrsregister.", 409);
    return requiredId(canonicalRows[0].id, "canonical_club_id");
  }
}

function requiredRuntimeId(board: Record<string, unknown>): string {
  const id = optionalId(board.runtime_kiosk_id);
  if (!id) throw new DomainValidationError("scolia_runtime_not_active", "Denne fysiske skiva har ingen aktiv runtime i dette miljøet.", 409);
  return id;
}

function publicRow(row: QueryResultRow): Record<string, unknown> {
  return { ...row };
}

function parseJsonArray(value: unknown): unknown[] {
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function nullableBoolInt(value: unknown): 0 | 1 | null {
  if (value == null || stringValue(value) === "") return null;
  return boolInt(value);
}

function boolInt(value: unknown): 0 | 1 {
  if (typeof value === "boolean") return value ? 1 : 0;
  return ["1", "true", "yes", "on"].includes(stringValue(value).toLowerCase()) ? 1 : 0;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringValue(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function nullableString(value: unknown): string | null {
  const normalized = stringValue(value);
  return normalized === "" ? null : normalized;
}

function requiredId(value: unknown, name: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new DomainValidationError("invalid_id", `${name} must be a positive decimal id.`);
  return normalized;
}

function optionalId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}
