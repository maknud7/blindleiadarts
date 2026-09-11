import { randomBytes } from "node:crypto";

import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

export class MySqlScreenDeviceRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
  ) {}

  async listByClubId(clubIdInput: unknown): Promise<Record<string, unknown>[]> {
    const clubId = requiredId(clubIdInput, "club_id");
    return this.sessions.withConnection(async (db) => {
      await this.assertClubExistsWith(db, clubId);
      const rows = await db.query<QueryResultRow>(
        `SELECT id,club_id,label,access_code,access_token,is_active,last_connected_at,created_at,updated_at
           FROM \`${this.runtimePrefix}screen_devices\`
          WHERE club_id=?
          ORDER BY created_at DESC,id DESC`,
        [clubId],
      );
      return rows.map(publicScreen);
    });
  }

  async createForClub(clubIdInput: unknown, labelInput: unknown): Promise<Record<string, unknown>> {
    const clubId = requiredId(clubIdInput, "club_id");
    const label = normalizeLabel(labelInput);
    return this.sessions.withTransaction(async (db) => {
      const club = await this.assertClubExistsWith(db, clubId);
      const prefix = codePrefix(club.slug ?? club.name ?? "screen");
      const accessCode = await this.uniqueAccessCodeWith(db, prefix);
      const accessToken = await this.uniqueAccessTokenWith(db);
      const result = await db.execute(
        `INSERT INTO \`${this.runtimePrefix}screen_devices\`
          (club_id,label,access_code,access_token,is_active)
         VALUES (?,?,?,?,1)`,
        [clubId, label, accessCode, accessToken],
      );
      const id = requiredId(result.insertId, "screen_device_id");
      const rows = await db.query<QueryResultRow>(
        `SELECT id,club_id,label,access_code,access_token,is_active,last_connected_at,created_at,updated_at
           FROM \`${this.runtimePrefix}screen_devices\` WHERE id=? AND club_id=? LIMIT 1`,
        [id, clubId],
      );
      if (!rows[0]) throw new DomainValidationError("screen_create_failed", "Venue-skjermen kunne ikke leses etter opprettelse.", 500);
      return publicScreen(rows[0]);
    });
  }

  async deleteForClub(clubIdInput: unknown, screenIdInput: unknown): Promise<boolean> {
    const clubId = requiredId(clubIdInput, "club_id");
    const screenId = requiredId(screenIdInput, "screen_id");
    return this.sessions.withConnection(async (db) => {
      const result = await db.execute(
        `DELETE FROM \`${this.runtimePrefix}screen_devices\` WHERE id=? AND club_id=?`,
        [screenId, clubId],
      );
      return result.affectedRows > 0;
    });
  }

  private async assertClubExistsWith(db: SqlExecutor, clubId: string): Promise<QueryResultRow> {
    const rows = await db.query<QueryResultRow>(
      `SELECT id,name,slug FROM \`${this.runtimePrefix}clubs\` WHERE id=? LIMIT 1`,
      [clubId],
    );
    if (!rows[0]) throw new DomainValidationError("club_not_found", "Klubben finnes ikke i dette miljøet.", 404);
    return rows[0];
  }

  private async uniqueAccessCodeWith(db: SqlExecutor, prefix: string): Promise<string> {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = `${prefix}-${randomPart(4)}`;
      const rows = await db.query<QueryResultRow>(
        `SELECT id FROM \`${this.runtimePrefix}screen_devices\` WHERE access_code=? LIMIT 1`,
        [candidate],
      );
      if (rows.length === 0) return candidate;
    }
    throw new DomainValidationError("screen_code_generation_failed", "Kunne ikke lage unik skjermkode.", 500);
  }

  private async uniqueAccessTokenWith(db: SqlExecutor): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = randomBytes(24).toString("hex");
      const rows = await db.query<QueryResultRow>(
        `SELECT id FROM \`${this.runtimePrefix}screen_devices\` WHERE access_token=? LIMIT 1`,
        [candidate],
      );
      if (rows.length === 0) return candidate;
    }
    throw new DomainValidationError("screen_token_generation_failed", "Kunne ikke lage unik skjermtoken.", 500);
  }
}

function publicScreen(row: QueryResultRow): Record<string, unknown> {
  return {
    id: requiredId(row.id, "screen_id"),
    club_id: requiredId(row.club_id, "club_id"),
    label: nullableString(row.label),
    access_code: nullableString(row.access_code),
    access_token: nullableString(row.access_token),
    is_active: numberValue(row.is_active),
    last_connected_at: row.last_connected_at ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

function codePrefix(value: unknown): string {
  const normalized = String(value ?? "screen")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "") || "screen";
  return normalized.toUpperCase().slice(0, 4).padEnd(4, "X");
}

function randomPart(length: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  let result = "";
  for (let index = 0; index < length; index += 1) result += alphabet[bytes[index]! % alphabet.length];
  return result;
}

function normalizeLabel(value: unknown): string {
  const normalized = String(value ?? "").trim();
  return (normalized || "Venue Screen").slice(0, 150);
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableString(value: unknown): string | null {
  const normalized = value == null ? "" : String(value).trim();
  return normalized === "" ? null : normalized;
}

function requiredId(value: unknown, name: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new DomainValidationError("invalid_id", `${name} must be a positive decimal id.`);
  return normalized;
}
