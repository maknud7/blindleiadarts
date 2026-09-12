import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, TablePrefix } from "./contracts.js";

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
          (kiosk_id,connection_state,fallback_active,needs_reconciliation,last_disconnect_reason,last_disconnect_at)
         VALUES (?,'disconnected',1,1,?,NOW(3))
         ON DUPLICATE KEY UPDATE connection_state='disconnected',fallback_active=1,needs_reconciliation=1,
           last_disconnect_reason=VALUES(last_disconnect_reason),last_disconnect_at=NOW(3)`,
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
          WHERE kiosk_id=? AND status IN ('in_progress','assigned')
          ORDER BY FIELD(status,'in_progress','assigned'),id LIMIT 1`,
        [kioskId],
      );
      const fallback = matches.length > 0 && mode === "live" && autoFallback;
      await db.execute(
        `INSERT INTO \`${this.runtimePrefix}scolia_board_runtime\`
          (kiosk_id,connection_state,fallback_active,needs_reconciliation,last_disconnect_reason,last_disconnect_at)
         VALUES (?,'disconnected',?,?,?,NOW(3))
         ON DUPLICATE KEY UPDATE connection_state='disconnected',fallback_active=VALUES(fallback_active),
           needs_reconciliation=VALUES(needs_reconciliation),last_disconnect_reason=VALUES(last_disconnect_reason),last_disconnect_at=NOW(3)`,
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

  private async assertKioskWith(db: { query: <T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]) => Promise<readonly T[]> }, clubId: string, kioskId: string): Promise<void> {
    const rows = await db.query<QueryResultRow>(
      `SELECT id FROM \`${this.runtimePrefix}kiosks\` WHERE id=? AND club_id=? AND is_active=1 LIMIT 1`,
      [kioskId, clubId],
    );
    if (!rows[0]) throw new DomainValidationError("kiosk_not_found", "Boardet ble ikke funnet.", 404);
  }

  private async statusWith(db: { query: <T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]) => Promise<readonly T[]> }, kioskId: string): Promise<Record<string, unknown>> {
    const rows = await db.query<QueryResultRow>(
      `SELECT * FROM \`${this.runtimePrefix}scolia_board_runtime\` WHERE kiosk_id=? LIMIT 1`,
      [kioskId],
    );
    return rows[0]
      ? { ...rows[0], kiosk_id: kioskId }
      : { kiosk_id: kioskId, connection_state: "disconnected", fallback_active: 0, needs_reconciliation: 0, turn_locked_until_takeout: 0 };
  }
}

function id(value: unknown, name: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new DomainValidationError(`invalid_${name}`, `${name} must be a positive decimal id.`);
  return normalized;
}
