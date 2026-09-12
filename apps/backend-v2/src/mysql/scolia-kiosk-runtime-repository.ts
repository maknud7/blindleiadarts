import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

interface TestLeaseContext {
  readonly testKioskId: string;
  readonly testClubId: string;
  readonly physicalKioskId: string;
  readonly clubSlug: string;
}

export class MySqlScoliaKioskRuntimeRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
    private readonly hardwarePrefix: TablePrefix,
  ) {}

  async fallback(clubIdInput: unknown, kioskIdInput: unknown): Promise<Record<string, unknown>> {
    const clubId = id(clubIdInput, "club_id");
    const kioskId = id(kioskIdInput, "kiosk_id");
    return this.sessions.withTransaction(async (db) => {
      const board = await db.query<QueryResultRow>(
        `SELECT id FROM \`${this.runtimePrefix}kiosks\` WHERE id=? AND club_id=? AND is_active=1 LIMIT 1 FOR UPDATE`,
        [kioskId, clubId],
      );
      if (!board[0]) throw new DomainValidationError("kiosk_not_found", "Boardet ble ikke funnet.", 404);
      const reason = "Manuell fallback aktivert fra board-terminal.";
      await db.execute(
        `INSERT INTO \`${this.runtimePrefix}scolia_board_runtime\`
          (kiosk_id,connection_state,fallback_active,needs_reconciliation,last_disconnect_reason,last_disconnect_at,connected_at)
         VALUES (?,'disconnected',1,1,?,NOW(3),NULL)
         ON DUPLICATE KEY UPDATE connection_state='disconnected',fallback_active=1,needs_reconciliation=1,
           last_disconnect_reason=VALUES(last_disconnect_reason),last_disconnect_at=NOW(3),connected_at=NULL`,
        [kioskId, reason],
      );
      return this.statusWith(db, kioskId);
    });
  }

  async markDisconnected(kioskIdInput: unknown, reasonInput: unknown): Promise<void> {
    const kioskId = id(kioskIdInput, "kiosk_id");
    const reason = String(reasonInput ?? "Scolia WebSocket disconnected").trim().slice(0, 255) || "Scolia WebSocket disconnected";
    await this.sessions.withTransaction(async (db) => {
      const runtimeRows = await db.query<QueryResultRow>(
        `SELECT id,club_id,source_kiosk_id FROM \`${this.runtimePrefix}kiosks\` WHERE id=? AND is_active=1 LIMIT 1 FOR UPDATE`,
        [kioskId],
      );
      const runtime = runtimeRows[0];
      if (!runtime) return;
      const physicalId = this.runtimePrefix === this.hardwarePrefix
        ? kioskId
        : id(runtime.source_kiosk_id, "physical_kiosk_id");
      const settingsRows = await db.query<QueryResultRow>(
        `SELECT s.mode,s.auto_fallback_to_manual,k.scoring_mode
           FROM \`${this.hardwarePrefix}kiosks\` k
           LEFT JOIN \`${this.hardwarePrefix}scolia_board_settings\` s ON s.kiosk_id=k.id
          WHERE k.id=? LIMIT 1`,
        [physicalId],
      );
      const settings = settingsRows[0] ?? {};
      const mode = String(settings.mode ?? (String(settings.scoring_mode ?? "") === "scolia" ? "live" : "off"));
      const autoFallback = Number(settings.auto_fallback_to_manual ?? 1) === 1;
      const matches = await db.query<QueryResultRow>(
        `SELECT id FROM \`${this.runtimePrefix}matches\`
          WHERE kiosk_id=? AND status='in_progress' ORDER BY id LIMIT 1`,
        [kioskId],
      );
      const fallback = matches.length > 0 && mode === "live" && autoFallback;
      await db.execute(
        `INSERT INTO \`${this.runtimePrefix}scolia_board_runtime\`
          (kiosk_id,connection_state,fallback_active,needs_reconciliation,last_disconnect_reason,last_disconnect_at,connected_at)
         VALUES (?,'disconnected',?,?,?,NOW(3),NULL)
         ON DUPLICATE KEY UPDATE connection_state='disconnected',
           fallback_active=GREATEST(fallback_active,VALUES(fallback_active)),
           needs_reconciliation=GREATEST(needs_reconciliation,VALUES(needs_reconciliation)),
           last_disconnect_reason=VALUES(last_disconnect_reason),last_disconnect_at=NOW(3),connected_at=NULL`,
        [kioskId, fallback ? 1 : 0, fallback ? 1 : 0, reason],
      );
    });
  }

  async resetPhase(clubIdInput: unknown, kioskIdInput: unknown): Promise<void> {
    const clubId = id(clubIdInput, "club_id");
    const kioskId = id(kioskIdInput, "kiosk_id");
    await this.sessions.withTransaction(async (db) => {
      await this.assertKioskWith(db, clubId, kioskId);
      await db.execute(`DELETE FROM \`${this.runtimePrefix}scolia_visit_buffers\` WHERE kiosk_id=?`, [kioskId]);
      await db.execute(
        `INSERT INTO \`${this.runtimePrefix}scolia_board_runtime\` (kiosk_id,turn_locked_until_takeout)
         VALUES (?,0) ON DUPLICATE KEY UPDATE turn_locked_until_takeout=0`,
        [kioskId],
      );
    });
  }

  async resume(clubIdInput: unknown, kioskIdInput: unknown): Promise<void> {
    const clubId = id(clubIdInput, "club_id");
    const kioskId = id(kioskIdInput, "kiosk_id");
    await this.sessions.withTransaction(async (db) => {
      await this.assertKioskWith(db, clubId, kioskId);
      await db.execute(
        `UPDATE \`${this.runtimePrefix}scolia_board_runtime\`
            SET fallback_active=0,needs_reconciliation=0,turn_locked_until_takeout=0,last_reconciled_at=NOW(3)
          WHERE kiosk_id=?`,
        [kioskId],
      );
      await db.execute(`DELETE FROM \`${this.runtimePrefix}scolia_visit_buffers\` WHERE kiosk_id=?`, [kioskId]);
      await db.execute(
        `UPDATE \`${this.runtimePrefix}scolia_incidents\`
            SET status='resolved',resolved_at=NOW(3),resolved_by_user_id=NULL
          WHERE club_id=? AND kiosk_id=? AND status='open'
            AND category IN ('connection_lost_during_match','reconciliation_required')`,
        [clubId, kioskId],
      );
    });
  }

  async status(kioskIdInput: unknown): Promise<Record<string, unknown>> {
    const kioskId = id(kioskIdInput, "kiosk_id");
    return this.sessions.withConnection((db) => this.statusWith(db, kioskId));
  }

  async acquireTestLease(
    testClubIdInput: unknown,
    testKioskIdInput: unknown,
    requestedPhysicalIdInput: unknown,
  ): Promise<Record<string, unknown>> {
    this.assertSplitTestScope();
    const testClubId = id(testClubIdInput, "club_id");
    const testKioskId = id(testKioskIdInput, "kiosk_id");
    const requestedPhysicalId = optionalId(requestedPhysicalIdInput);

    return this.sessions.withTransaction(async (db) => {
      const context = await this.testLeaseContextWith(db, testClubId, testKioskId, requestedPhysicalId, true);
      const physicalRows = await db.query<QueryResultRow>(
        `SELECT k.id,k.club_id,k.code,k.name,k.board_number,k.scoring_mode,c.slug AS club_slug,
                s.serial_number,s.mode,s.auto_fallback_to_manual,
                cs.enabled AS club_scolia_enabled,cs.access_token
           FROM \`${this.hardwarePrefix}kiosks\` k
           INNER JOIN \`${this.hardwarePrefix}clubs\` c ON c.id=k.club_id
           LEFT JOIN \`${this.hardwarePrefix}scolia_board_settings\` s ON s.kiosk_id=k.id
           LEFT JOIN \`${this.hardwarePrefix}scolia_club_settings\` cs ON cs.club_id=k.club_id
          WHERE k.id=? AND k.is_active=1 LIMIT 1 FOR UPDATE`,
        [context.physicalKioskId],
      );
      const physical = physicalRows[0];
      if (!physical) throw new DomainValidationError("physical_board_not_found", "Den fysiske PROD-skiva finnes ikke.", 404);
      if (stringValue(physical.club_slug) !== context.clubSlug) {
        throw new DomainValidationError("physical_board_club_mismatch", "TEST-skiva peker på en fysisk skive i en annen klubb.", 409);
      }
      if (stringValue(physical.scoring_mode).toLowerCase() !== "scolia") {
        return {
          leased: false,
          reason: "not_scolia",
          physical_kiosk_id: context.physicalKioskId,
          test_kiosk_id: context.testKioskId,
          configuration_scope: "production_hardware",
        };
      }

      const serial = stringValue(physical.serial_number).toUpperCase();
      if (
        serial === "" ||
        stringValue(physical.mode).toLowerCase() !== "live" ||
        numberValue(physical.club_scolia_enabled) !== 1 ||
        stringValue(physical.access_token) === ""
      ) {
        throw new DomainValidationError(
          "scolia_physical_not_ready",
          "Den fysiske Scolia-skiva mangler aktivt serienummer, klubbtilkobling eller access token i PROD-innstillingene.",
          409,
        );
      }

      await db.execute(
        `DELETE FROM \`${this.hardwarePrefix}scolia_test_leases\`
          WHERE expires_at<=NOW(3) AND (physical_kiosk_id=? OR test_kiosk_id=?)`,
        [context.physicalKioskId, context.testKioskId],
      );
      const leaseRows = await db.query<QueryResultRow>(
        `SELECT physical_kiosk_id,test_kiosk_id FROM \`${this.hardwarePrefix}scolia_test_leases\`
          WHERE (physical_kiosk_id=? OR test_kiosk_id=?) AND expires_at>NOW(3) FOR UPDATE`,
        [context.physicalKioskId, context.testKioskId],
      );
      for (const lease of leaseRows) {
        const leasePhysicalId = id(lease.physical_kiosk_id, "lease_physical_kiosk_id");
        const leaseTestKioskId = id(lease.test_kiosk_id, "lease_test_kiosk_id");
        if (leasePhysicalId !== context.physicalKioskId || leaseTestKioskId !== context.testKioskId) {
          throw new DomainValidationError(
            "scolia_board_already_leased",
            "Denne Scolia-skiva eller testterminalen brukes allerede av en annen aktiv test-lease.",
            409,
          );
        }
      }

      const autoFallback = numberValue(physical.auto_fallback_to_manual) === 0 ? 0 : 1;
      // The only canonical PROD write permitted here is the explicit TEST lease.
      // Serial/token/master settings are never copied or mutated from TEST.
      await db.execute(`DELETE FROM \`${this.runtimePrefix}scolia_board_settings\` WHERE serial_number=?`, [serial]);
      await db.execute(
        `INSERT INTO \`${this.runtimePrefix}scolia_board_settings\`
          (kiosk_id,serial_number,mode,auto_fallback_to_manual,force_connect_override,forward_messages_override,updated_by_user_id)
         VALUES (?,NULL,'live',?,NULL,NULL,NULL)
         ON DUPLICATE KEY UPDATE serial_number=NULL,mode='live',
           auto_fallback_to_manual=VALUES(auto_fallback_to_manual),force_connect_override=NULL,
           forward_messages_override=NULL,updated_by_user_id=NULL`,
        [context.testKioskId, autoFallback],
      );
      await db.execute(
        `INSERT INTO \`${this.runtimePrefix}scolia_board_runtime\`
          (kiosk_id,connection_state,fallback_active,needs_reconciliation)
         VALUES (?,'disconnected',0,0)
         ON DUPLICATE KEY UPDATE connection_state='disconnected',fallback_active=0,needs_reconciliation=0,
           board_status=NULL,board_phase=NULL,error_type=NULL,last_disconnect_reason=NULL`,
        [context.testKioskId],
      );
      await db.execute(`DELETE FROM \`${this.runtimePrefix}scolia_visit_buffers\` WHERE kiosk_id=?`, [context.testKioskId]);
      await db.execute(
        `UPDATE \`${this.runtimePrefix}kiosks\` SET scoring_mode='scolia' WHERE id=? AND club_id=?`,
        [context.testKioskId, context.testClubId],
      );
      await db.execute(
        `INSERT INTO \`${this.hardwarePrefix}scolia_test_leases\`
          (physical_kiosk_id,test_kiosk_id,leased_at,heartbeat_at,expires_at)
         VALUES (?,?,NOW(3),NOW(3),DATE_ADD(NOW(3),INTERVAL 3 MINUTE))
         ON DUPLICATE KEY UPDATE test_kiosk_id=VALUES(test_kiosk_id),leased_at=NOW(3),heartbeat_at=NOW(3),
           expires_at=DATE_ADD(NOW(3),INTERVAL 3 MINUTE)`,
        [context.physicalKioskId, context.testKioskId],
      );

      return {
        leased: true,
        physical_kiosk_id: context.physicalKioskId,
        test_kiosk_id: context.testKioskId,
        board_number: numberValue(physical.board_number),
        serial_number: serial,
        expires_in_seconds: 180,
        configuration_scope: "production_hardware",
        shared_across_environments: true,
      };
    });
  }

  async heartbeatTestLease(
    testClubIdInput: unknown,
    testKioskIdInput: unknown,
    requestedPhysicalIdInput: unknown,
  ): Promise<Record<string, unknown>> {
    this.assertSplitTestScope();
    const testClubId = id(testClubIdInput, "club_id");
    const testKioskId = id(testKioskIdInput, "kiosk_id");
    const requestedPhysicalId = optionalId(requestedPhysicalIdInput);
    return this.sessions.withConnection(async (db) => {
      const context = await this.testLeaseContextWith(db, testClubId, testKioskId, requestedPhysicalId, false);
      const updated = await db.execute(
        `UPDATE \`${this.hardwarePrefix}scolia_test_leases\`
            SET heartbeat_at=NOW(3),expires_at=DATE_ADD(NOW(3),INTERVAL 3 MINUTE)
          WHERE physical_kiosk_id=? AND test_kiosk_id=? AND expires_at>NOW(3)`,
        [context.physicalKioskId, context.testKioskId],
      );
      if (updated.affectedRows < 1) {
        throw new DomainValidationError("scolia_test_lease_expired", "Scolia-testleasen har utløpt. Velg skiva på nytt.", 409);
      }
      return { active: true, expires_in_seconds: 180, configuration_scope: "production_hardware" };
    });
  }

  async releaseTestLease(
    testClubIdInput: unknown,
    testKioskIdInput: unknown,
    requestedPhysicalIdInput: unknown,
  ): Promise<Record<string, unknown>> {
    this.assertSplitTestScope();
    const testClubId = id(testClubIdInput, "club_id");
    const testKioskId = id(testKioskIdInput, "kiosk_id");
    const requestedPhysicalId = optionalId(requestedPhysicalIdInput);
    return this.sessions.withTransaction(async (db) => {
      const context = await this.testLeaseContextWith(db, testClubId, testKioskId, requestedPhysicalId, true);
      await db.execute(
        `DELETE FROM \`${this.hardwarePrefix}scolia_test_leases\` WHERE physical_kiosk_id=? AND test_kiosk_id=?`,
        [context.physicalKioskId, context.testKioskId],
      );
      await db.execute(`DELETE FROM \`${this.runtimePrefix}scolia_board_settings\` WHERE kiosk_id=?`, [context.testKioskId]);
      await db.execute(
        `UPDATE \`${this.runtimePrefix}scolia_board_runtime\`
            SET connection_state='disabled',fallback_active=0,needs_reconciliation=0,
                board_status=NULL,board_phase=NULL,error_type=NULL,last_disconnect_reason=NULL,
                turn_locked_until_takeout=0
          WHERE kiosk_id=?`,
        [context.testKioskId],
      );
      await db.execute(`DELETE FROM \`${this.runtimePrefix}scolia_visit_buffers\` WHERE kiosk_id=?`, [context.testKioskId]);
      await db.execute(
        `UPDATE \`${this.runtimePrefix}kiosks\` SET scoring_mode='manual' WHERE id=? AND club_id=?`,
        [context.testKioskId, context.testClubId],
      );
      return {
        released: true,
        physical_kiosk_id: context.physicalKioskId,
        test_kiosk_id: context.testKioskId,
        configuration_scope: "production_hardware",
      };
    });
  }

  private async assertKioskWith(db: SqlExecutor, clubId: string, kioskId: string): Promise<void> {
    const rows = await db.query<QueryResultRow>(
      `SELECT id FROM \`${this.runtimePrefix}kiosks\` WHERE id=? AND club_id=? AND is_active=1 LIMIT 1`,
      [kioskId, clubId],
    );
    if (!rows[0]) throw new DomainValidationError("kiosk_not_found", "Boardet ble ikke funnet.", 404);
  }

  private async statusWith(db: SqlExecutor, kioskId: string): Promise<Record<string, unknown>> {
    const rows = await db.query<QueryResultRow>(
      `SELECT * FROM \`${this.runtimePrefix}scolia_board_runtime\` WHERE kiosk_id=? LIMIT 1`,
      [kioskId],
    );
    return rows[0]
      ? { ...rows[0], kiosk_id: kioskId }
      : { kiosk_id: kioskId, connection_state: "disconnected", fallback_active: 0, needs_reconciliation: 0, turn_locked_until_takeout: 0 };
  }

  private async testLeaseContextWith(
    db: SqlExecutor,
    testClubId: string,
    testKioskId: string,
    requestedPhysicalId: string | null,
    lock: boolean,
  ): Promise<TestLeaseContext> {
    const rows = await db.query<QueryResultRow>(
      `SELECT k.id,k.club_id,k.source_kiosk_id,c.slug
         FROM \`${this.runtimePrefix}kiosks\` k
         INNER JOIN \`${this.runtimePrefix}clubs\` c ON c.id=k.club_id
        WHERE k.id=? AND k.club_id=? AND k.is_active=1 LIMIT 1${lock ? " FOR UPDATE" : ""}`,
      [testKioskId, testClubId],
    );
    const row = rows[0];
    if (!row) throw new DomainValidationError("test_kiosk_not_found", "Testterminalen ble ikke funnet.", 404);
    const physicalKioskId = optionalId(row.source_kiosk_id);
    if (physicalKioskId === null) {
      throw new DomainValidationError("test_alias_required", "Velg en fysisk PROD-skive i testmodus først.", 409);
    }
    if (requestedPhysicalId !== null && requestedPhysicalId !== physicalKioskId) {
      throw new DomainValidationError("physical_board_mismatch", "Testterminalen peker på en annen fysisk skive.", 409);
    }
    const clubSlug = stringValue(row.slug);
    if (!clubSlug) throw new DomainValidationError("test_club_not_found", "TEST-klubben mangler canonical slug.", 409);
    return { testKioskId, testClubId, physicalKioskId, clubSlug };
  }

  private assertSplitTestScope(): void {
    if (this.runtimePrefix === this.hardwarePrefix) {
      throw new DomainValidationError("scolia_test_lease_test_only", "Scolia test-lease finnes bare i isolert TEST-runtime.", 404);
    }
  }
}

function optionalId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}
function id(value: unknown, name: string): string {
  const normalized = optionalId(value);
  if (normalized === null) throw new DomainValidationError(`invalid_${name}`, `${name} must be a positive decimal id.`);
  return normalized;
}
function stringValue(value: unknown): string { return String(value ?? "").trim(); }
function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}
