import { randomUUID } from "node:crypto";

import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

export interface ScoliaKioskUiSnapshot extends Record<string, unknown> {
  readonly physical_status: {
    readonly status: string | null;
    readonly age_seconds: number | null;
    readonly event_type: string | null;
    readonly received_at: unknown;
  };
  readonly bridge_heartbeat_age_seconds: number | null;
  readonly last_status_probe_age_seconds: number | null;
  readonly match_id: string | null;
  readonly last_visit: Record<string, unknown> | null;
  readonly latest_canonical_visit: Record<string, unknown> | null;
  readonly buffer: Record<string, unknown> | null;
  readonly queue: Record<string, number>;
}

export class MySqlScoliaCommandRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
  ) {}

  async queueCommand(
    clubIdInput: unknown,
    kioskIdInput: unknown,
    typeInput: unknown,
    payloadInput: unknown,
    userIdInput: unknown,
  ): Promise<Record<string, unknown>> {
    const clubId = requiredId(clubIdInput, "club_id");
    const kioskId = requiredId(kioskIdInput, "kiosk_id");
    const type = stringValue(typeInput).toUpperCase();
    if (type === "") throw new DomainValidationError("scolia_command_type_required", "command_type is required.", 422);
    const userId = optionalId(userIdInput);
    const payload = recordOrEmpty(payloadInput);
    const messageId = randomUUID();
    const payloadJson = Object.keys(payload).length === 0 ? null : JSON.stringify(payload);

    return this.sessions.withConnection(async (db) => {
      const result = await db.execute(
        `INSERT INTO \`${this.runtimePrefix}scolia_commands\`
          (club_id,kiosk_id,command_type,message_id,payload_json,status,priority,created_by_user_id)
         VALUES (?,?,?,?,?,'queued',100,?)`,
        [clubId, kioskId, type, messageId, payloadJson, userId],
      );
      return {
        id: idString(result.insertId),
        kiosk_id: kioskId,
        message_id: messageId,
        type,
        command_type: type,
        payload,
        status: "queued",
      };
    });
  }

  async pollCommands(kioskIdsInput: unknown, limitInput: unknown = 100): Promise<Record<string, unknown>[]> {
    const raw = Array.isArray(kioskIdsInput) ? kioskIdsInput : [];
    const kioskIds = Array.from(new Set(raw.map(optionalId).filter((value): value is string => value !== null))).slice(0, 100);
    if (kioskIds.length === 0) return [];
    const limit = clampInt(limitInput, 1, 200, 100);
    const placeholders = kioskIds.map(() => "?").join(",");

    return this.sessions.withTransaction(async (db) => {
      await db.execute(
        `UPDATE \`${this.runtimePrefix}scolia_commands\`
            SET status='failed',next_attempt_at=NOW(3),last_error=COALESCE(last_error,'Recovered stale command delivery')
          WHERE kiosk_id IN (${placeholders}) AND status='delivered'
            AND delivered_at < DATE_SUB(NOW(3),INTERVAL 30 SECOND)`,
        kioskIds,
      );
      const rows = await db.query<QueryResultRow>(
        `SELECT c.id,c.kiosk_id,c.command_type,c.message_id,c.payload_json,c.attempt_count,c.priority,c.created_at
           FROM \`${this.runtimePrefix}scolia_commands\` c
          WHERE c.kiosk_id IN (${placeholders})
            AND c.status IN ('queued','failed') AND c.next_attempt_at<=NOW(3)
            AND NOT EXISTS (
              SELECT 1 FROM \`${this.runtimePrefix}scolia_commands\` older
               WHERE older.kiosk_id=c.kiosk_id AND older.id<c.id
                 AND older.status IN ('queued','failed','delivered')
            )
          ORDER BY c.priority DESC,c.id ASC LIMIT ${limit} FOR UPDATE`,
        kioskIds,
      );
      if (rows.length > 0) {
        const commandIds = rows.map((row) => requiredId(row.id, "command_id"));
        await db.execute(
          `UPDATE \`${this.runtimePrefix}scolia_commands\`
              SET status='delivered',attempt_count=attempt_count+1,delivered_at=NOW(3)
            WHERE id IN (${commandIds.map(() => "?").join(",")})`,
          commandIds,
        );
      }
      return rows.map((row) => ({
        ...publicRow(row),
        id: requiredId(row.id, "command_id"),
        kiosk_id: requiredId(row.kiosk_id, "kiosk_id"),
        attempt_count: numberValue(row.attempt_count) + 1,
        priority: numberValue(row.priority),
        payload: parseObject(row.payload_json),
      }));
    });
  }

  async completeCommand(commandIdInput: unknown, resultInput: unknown, errorInput: unknown): Promise<void> {
    const commandId = requiredId(commandIdInput, "command_id");
    const result = stringValue(resultInput).toLowerCase();
    const status = result === "acked" || result === "ack"
      ? "acked"
      : result === "refused"
        ? "refused"
        : "failed";
    const error = nullableString(errorInput);
    await this.sessions.withConnection((db) => db.execute(
      `UPDATE \`${this.runtimePrefix}scolia_commands\`
          SET status=?,completed_at=IF(? IN ('acked','refused'),NOW(3),NULL),
              last_error=?,next_attempt_at=DATE_ADD(NOW(3),INTERVAL 3 SECOND)
        WHERE id=?`,
      [status, status, error, commandId],
    ).then(() => undefined));
  }

  async kioskUiSnapshot(clubIdInput: unknown, kioskIdInput: unknown): Promise<ScoliaKioskUiSnapshot> {
    const clubId = requiredId(clubIdInput, "club_id");
    const kioskId = requiredId(kioskIdInput, "kiosk_id");
    return this.sessions.withConnection(async (db) => {
      const statusRows = await db.query<QueryResultRow>(
        `SELECT event_type,payload_json,received_at,
                GREATEST(0,TIMESTAMPDIFF(SECOND,received_at,NOW(3))) AS age_seconds
           FROM \`${this.runtimePrefix}scolia_events\`
          WHERE kiosk_id=?
            AND (event_type='HELLO_CLIENT' OR event_type LIKE '%STATUS%' OR event_type LIKE '%AVAILABILITY%')
          ORDER BY id DESC LIMIT 1`,
        [kioskId],
      );
      const statusRow = statusRows[0];
      const message = statusRow ? parseObject(statusRow.payload_json) : {};
      const physicalPayload = recordOrEmpty(message.payload);
      const physicalStatus = firstNonEmpty(
        physicalPayload.boardStatus,
        physicalPayload.board_status,
        physicalPayload.status,
      );

      const ageRows = await db.query<QueryResultRow>(
        `SELECT
           (SELECT GREATEST(0,TIMESTAMPDIFF(SECOND,last_bridge_heartbeat_at,NOW(3)))
              FROM \`${this.runtimePrefix}scolia_board_runtime\`
             WHERE kiosk_id=? AND last_bridge_heartbeat_at IS NOT NULL LIMIT 1) AS bridge_heartbeat_age_seconds,
           (SELECT GREATEST(0,TIMESTAMPDIFF(SECOND,created_at,NOW(3)))
              FROM \`${this.runtimePrefix}scolia_commands\`
             WHERE kiosk_id=? AND command_type='GET_SBC_STATUS'
             ORDER BY id DESC LIMIT 1) AS last_status_probe_age_seconds`,
        [kioskId, kioskId],
      );
      const ages = ageRows[0] ?? {};

      const matchRows = await db.query<QueryResultRow>(
        `SELECT id FROM \`${this.runtimePrefix}matches\`
          WHERE kiosk_id=? AND status IN ('in_progress','assigned')
          ORDER BY FIELD(status,'in_progress','assigned'),id ASC LIMIT 1`,
        [kioskId],
      );
      const matchId = optionalId(matchRows[0]?.id);
      const latestCanonicalVisit = matchId === null ? null : await this.latestVisitWith(db, kioskId, matchId, false);
      const lastVisit = matchId === null ? null : await this.latestVisitWith(db, kioskId, matchId, true);

      const bufferRows = await db.query<QueryResultRow>(
        `SELECT match_id,player_id,darts_json,updated_at
           FROM \`${this.runtimePrefix}scolia_visit_buffers\` WHERE kiosk_id=? LIMIT 1`,
        [kioskId],
      );
      const bufferRow = bufferRows[0];
      const buffer = bufferRow ? {
        match_id: optionalId(bufferRow.match_id),
        player_id: optionalId(bufferRow.player_id),
        darts: parseArray(bufferRow.darts_json),
        updated_at: bufferRow.updated_at ?? null,
      } : null;

      const queueRows = await db.query<QueryResultRow>(
        `SELECT processing_status,COUNT(*) AS c
           FROM \`${this.runtimePrefix}scolia_events\`
          WHERE club_id=? AND kiosk_id=? GROUP BY processing_status`,
        [clubId, kioskId],
      );
      const queue: Record<string, number> = {
        queued: 0,
        processing: 0,
        processed: 0,
        ignored: 0,
        failed: 0,
        dead_letter: 0,
      };
      for (const row of queueRows) {
        const key = stringValue(row.processing_status);
        if (key !== "") queue[key] = numberValue(row.c);
      }

      return {
        physical_status: {
          status: physicalStatus,
          age_seconds: nullableNumber(statusRow?.age_seconds),
          event_type: nullableString(statusRow?.event_type),
          received_at: statusRow?.received_at ?? null,
        },
        bridge_heartbeat_age_seconds: nullableNumber(ages.bridge_heartbeat_age_seconds),
        last_status_probe_age_seconds: nullableNumber(ages.last_status_probe_age_seconds),
        match_id: matchId,
        last_visit: lastVisit,
        latest_canonical_visit: latestCanonicalVisit,
        buffer,
        queue,
      };
    });
  }

  private async latestVisitWith(
    db: SqlExecutor,
    kioskId: string,
    matchId: string,
    scoliaOnly: boolean,
  ): Promise<Record<string, unknown> | null> {
    const sourceFilter = scoliaOnly ? " AND v.request_key LIKE 'scolia-%'" : "";
    const rows = await db.query<QueryResultRow>(
      `SELECT v.id,v.match_id,v.leg_id,v.player_id,v.visit_number,v.score,v.darts_used,v.input_mode,
              v.darts_json,v.is_bust,v.remaining_after,v.request_key,v.created_at,p.display_name AS player_name
         FROM \`${this.runtimePrefix}visits\` v
         INNER JOIN \`${this.runtimePrefix}matches\` m ON m.id=v.match_id
         LEFT JOIN \`${this.runtimePrefix}players\` p ON p.id=v.player_id
        WHERE m.kiosk_id=? AND v.match_id=?${sourceFilter}
        ORDER BY v.id DESC LIMIT 1`,
      [kioskId, matchId],
    );
    const row = rows[0];
    if (!row) return null;
    const requestKey = stringValue(row.request_key);
    return {
      id: requiredId(row.id, "visit_id"),
      match_id: requiredId(row.match_id, "match_id"),
      leg_id: requiredId(row.leg_id, "leg_id"),
      player_id: requiredId(row.player_id, "player_id"),
      player_name: stringValue(row.player_name),
      visit_number: numberValue(row.visit_number),
      score: numberValue(row.score),
      darts_used: numberValue(row.darts_used),
      input_mode: stringValue(row.input_mode),
      darts: parseArray(row.darts_json),
      is_bust: numberValue(row.is_bust) === 1,
      remaining_after: numberValue(row.remaining_after),
      source: requestKey.startsWith("scolia-") ? "scolia" : "manual",
      created_at: row.created_at ?? null,
    };
  }
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function parseObject(value: unknown): Record<string, unknown> {
  try {
    return recordOrEmpty(JSON.parse(String(value ?? "{}")));
  } catch {
    return {};
  }
}
function parseArray(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function optionalId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}
function requiredId(value: unknown, name: string): string {
  const normalized = optionalId(value);
  if (normalized === null) throw new DomainValidationError(`invalid_${name}`, `${name} must be a positive decimal id.`);
  return normalized;
}
function idString(value: unknown): string | null { return optionalId(value); }
function stringValue(value: unknown): string { return String(value ?? "").trim(); }
function nullableString(value: unknown): string | null { const valueString = stringValue(value); return valueString === "" ? null : valueString; }
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function numberValue(value: unknown): number { const number = Number(value ?? 0); return Number.isFinite(number) ? number : 0; }
function firstNonEmpty(...values: unknown[]): string | null {
  for (const value of values) {
    const text = stringValue(value);
    if (text !== "") return text;
  }
  return null;
}
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
function publicRow(row: QueryResultRow): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]));
}
