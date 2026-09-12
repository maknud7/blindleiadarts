import { randomUUID } from "node:crypto";

import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, TablePrefix } from "./contracts.js";

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
function numberValue(value: unknown): number { const number = Number(value ?? 0); return Number.isFinite(number) ? number : 0; }
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
function publicRow(row: QueryResultRow): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]));
}
