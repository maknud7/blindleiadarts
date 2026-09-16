import { randomBytes } from "node:crypto";

import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

interface ClubRow extends QueryResultRow {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly slug?: unknown;
  readonly logo_url?: unknown;
  readonly kiosk_pairing_code?: unknown;
  readonly created_at?: unknown;
  readonly updated_at?: unknown;
}

export class MySqlClubAdminRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly prefix: TablePrefix,
  ) {}

  async create(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const name = requiredName(payload.name);
    const slug = slugify(payload.slug ?? name);
    const logoUrl = nullableString(payload.logo_url);

    const clubId = await this.sessions.withTransaction(async (db) => {
      const pairingCode = await this.generateKioskPairingCode(db, slug !== "" ? slug : name);
      const inserted = await db.execute(
        `INSERT INTO \`${this.prefix}clubs\` (name,slug,logo_url,kiosk_pairing_code) VALUES (?,?,?,?)`,
        [name, slug, logoUrl, pairingCode],
      );
      return requiredId(inserted.insertId, "club_id");
    });

    return this.requireById(clubId);
  }

  async findById(clubIdInput: unknown): Promise<Record<string, unknown> | null> {
    const clubId = requiredId(clubIdInput, "club_id");
    return this.sessions.withConnection((db) => this.findByIdWith(db, clubId));
  }

  async findByKioskPairingCode(codeInput: unknown): Promise<Record<string, unknown> | null> {
    const code = String(codeInput ?? "").trim().toUpperCase();
    if (code === "") return null;

    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<ClubRow>(
        `SELECT id,name,slug,logo_url,kiosk_pairing_code,created_at,updated_at
           FROM \`${this.prefix}clubs\`
          WHERE kiosk_pairing_code=? LIMIT 1`,
        [code],
      );
      const row = rows[0];
      if (!row) return null;
      return formatClub(row);
    });
  }

  async listMatchCallsByClubId(clubIdInput: unknown): Promise<Record<string, unknown>[]> {
    const clubId = requiredId(clubIdInput, "club_id");
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT m.id,m.tournament_id,t.name AS tournament_name,m.kiosk_id,m.round_label,m.bracket_label,
                m.status,m.best_of_legs,m.legs_to_win,m.player_a_id,pa.display_name AS player_a_name,
                m.player_b_id,pb.display_name AS player_b_name,k.code AS kiosk_code,k.name AS kiosk_name,k.board_number
           FROM \`${this.prefix}matches\` m
           INNER JOIN \`${this.prefix}tournaments\` t ON t.id=m.tournament_id
           INNER JOIN \`${this.prefix}players\` pa ON pa.id=m.player_a_id
           INNER JOIN \`${this.prefix}players\` pb ON pb.id=m.player_b_id
           LEFT JOIN \`${this.prefix}kiosks\` k ON k.id=m.kiosk_id
          WHERE t.club_id=?
            AND m.status IN ('pending','assigned','in_progress')
          ORDER BY FIELD(m.status,'in_progress','assigned','pending'),m.id ASC`,
        [clubId],
      );

      return rows.map((row) => ({
        id: requiredId(row.id, "match_id"),
        tournament_id: requiredId(row.tournament_id, "tournament_id"),
        tournament_name: row.tournament_name ?? null,
        kiosk_id: nullableId(row.kiosk_id),
        round_label: row.round_label ?? null,
        bracket_label: row.bracket_label ?? null,
        status: row.status ?? null,
        best_of_legs: integer(row.best_of_legs),
        legs_to_win: integer(row.legs_to_win),
        player_a_id: requiredId(row.player_a_id, "player_a_id"),
        player_a_name: row.player_a_name ?? null,
        player_b_id: requiredId(row.player_b_id, "player_b_id"),
        player_b_name: row.player_b_name ?? null,
        kiosk_code: row.kiosk_code ?? null,
        kiosk_name: row.kiosk_name ?? null,
        board_number: row.board_number == null ? null : integer(row.board_number),
      }));
    });
  }

  private async requireById(clubId: string): Promise<Record<string, unknown>> {
    const row = await this.findById(clubId);
    if (row === null) {
      throw new DomainValidationError("club_not_found", "Club was not found.", 404);
    }
    return row;
  }

  private async findByIdWith(db: SqlExecutor, clubId: string): Promise<Record<string, unknown> | null> {
    const rows = await db.query<ClubRow>(
      `SELECT id,name,slug,logo_url,kiosk_pairing_code,created_at,updated_at
         FROM \`${this.prefix}clubs\`
        WHERE id=? LIMIT 1`,
      [clubId],
    );
    const row = rows[0];
    return row ? formatClub(row) : null;
  }

  private async generateKioskPairingCode(db: SqlExecutor, clubReference: string): Promise<string> {
    const normalized = slugify(clubReference).toUpperCase().replaceAll("-", "");
    const base = (normalized !== "" ? normalized : "CLUB").slice(0, 3).padEnd(3, "X");

    for (let attempt = 0; attempt < 64; attempt += 1) {
      const suffix = randomBytes(2).toString("hex").toUpperCase();
      const code = `${base}-K${suffix}`;
      const rows = await db.query<QueryResultRow>(
        `SELECT id FROM \`${this.prefix}clubs\` WHERE kiosk_pairing_code=? LIMIT 1`,
        [code],
      );
      if (rows.length === 0) return code;
    }

    throw new DomainValidationError(
      "club_pairing_code_exhausted",
      "Could not generate a unique kiosk pairing code.",
      500,
    );
  }
}

function formatClub(row: ClubRow): Record<string, unknown> {
  return {
    ...row,
    id: requiredId(row.id, "club_id"),
  };
}

function requiredName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name === "") {
    throw new DomainValidationError("club_name_required", "Club name is required.", 422);
  }
  return name;
}

function slugify(value: unknown): string {
  const raw = String(value ?? "").trim();
  const norwegian = raw
    .replaceAll("Æ", "AE")
    .replaceAll("æ", "ae")
    .replaceAll("Ø", "O")
    .replaceAll("ø", "o")
    .replaceAll("Å", "A")
    .replaceAll("å", "a");
  const ascii = norwegian
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase();
  const slug = ascii.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (slug !== "" ? slug : "club").slice(0, 150);
}

function nullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

function nullableId(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredId(value, "id");
}

function integer(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function requiredId(value: unknown, name: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new DomainValidationError("invalid_id", `${name} must be a positive decimal id.`, 400);
  }
  return normalized;
}
