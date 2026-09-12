import { randomInt } from "node:crypto";

import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

type CheckinMethod = "admin_or_code" | "admin_only" | "code";

interface TournamentSettingsRow extends QueryResultRow {
  id: unknown;
  club_id: unknown;
  name: unknown;
  status: unknown;
  start_at: unknown;
  checkin_opens_at: unknown;
  checkin_closes_at: unknown;
  checkin_method: unknown;
  checkin_code: unknown;
}

interface RegistrationRow extends QueryResultRow {
  id: unknown;
  tournament_id: unknown;
  player_id: unknown;
  status: unknown;
  checked_in_at: unknown;
  checkin_source: unknown;
}

export class MySqlTournamentAttendanceAdminRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly prefix: TablePrefix,
  ) {}

  async getClubSettings(clubIdInput: unknown): Promise<Record<string, unknown>> {
    const clubId = requiredId(clubIdInput, "club_id");
    return this.sessions.withConnection((db) => this.getClubSettingsWith(db, clubId));
  }

  async updateClubSettings(
    clubIdInput: unknown,
    payload: Record<string, unknown>,
    userIdInput: unknown,
  ): Promise<Record<string, unknown>> {
    const clubId = requiredId(clubIdInput, "club_id");
    const userId = requiredId(userIdInput, "user_id");
    return this.sessions.withTransaction(async (db) => {
      const current = await this.getClubSettingsWith(db, clubId);
      const method = normalizeMethod(payload.default_method ?? current.default_method);
      const opens = clampInt(payload.opens_minutes_before_start ?? current.opens_minutes_before_start, 0, 1440);
      const closes = clampInt(payload.closes_minutes_after_start ?? current.closes_minutes_after_start, 0, 360);
      await db.execute(
        `INSERT INTO \`${this.prefix}club_checkin_settings\`
          (club_id,default_method,opens_minutes_before_start,closes_minutes_after_start,updated_by_user_id)
         VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE default_method=VALUES(default_method),
           opens_minutes_before_start=VALUES(opens_minutes_before_start),
           closes_minutes_after_start=VALUES(closes_minutes_after_start),
           updated_by_user_id=VALUES(updated_by_user_id)`,
        [clubId, method, opens, closes, userId],
      );
      return this.getClubSettingsWith(db, clubId);
    });
  }

  async getTournamentSettings(tournamentIdInput: unknown): Promise<Record<string, unknown> | null> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withConnection(async (db) => {
      const row = await this.tournamentSettingsWith(db, tournamentId);
      return row === null ? null : this.effectiveSettingsWith(db, row);
    });
  }

  async updateTournamentSettings(
    tournamentIdInput: unknown,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withTransaction(async (db) => {
      const row = await this.requireTournamentSettingsWith(db, tournamentId);
      if (String(row.status ?? "") !== "draft") {
        throw new DomainValidationError("checkin_closed", "Innsjekken er avsluttet.", 409);
      }
      const current = await this.effectiveSettingsWith(db, row);
      const opensAt = Object.prototype.hasOwnProperty.call(payload, "checkin_opens_at")
        ? nullableDateTime(payload.checkin_opens_at)
        : nullableString(row.checkin_opens_at);
      const method = Object.prototype.hasOwnProperty.call(payload, "checkin_method")
        ? nullableMethod(payload.checkin_method)
        : nullableMethod(row.checkin_method);
      let code = Object.prototype.hasOwnProperty.call(payload, "checkin_code")
        ? normalizeCode(payload.checkin_code)
        : normalizeCode(row.checkin_code);
      const rotate = boolValue(payload.rotate_checkin_code);
      const effectiveMethod = method ?? normalizeMethod(current.default_method);
      if (rotate || (methodUsesCode(effectiveMethod) && code === null)) {
        code = await this.generateUniqueCodeWith(db, requiredId(row.club_id, "club_id"), tournamentId);
      }
      if (!methodUsesCode(effectiveMethod) && Object.prototype.hasOwnProperty.call(payload, "checkin_method")) {
        code = null;
      }
      await db.execute(
        `UPDATE \`${this.prefix}tournaments\`
            SET checkin_opens_at=?,checkin_method=?,checkin_code=?
          WHERE id=?`,
        [opensAt, method, code, tournamentId],
      );
      const fresh = await this.requireTournamentSettingsWith(db, tournamentId);
      return this.effectiveSettingsWith(db, fresh);
    });
  }

  async rotateTournamentCode(tournamentIdInput: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withTransaction(async (db) => {
      const row = await this.requireTournamentSettingsWith(db, tournamentId);
      if (String(row.status ?? "") !== "draft") {
        throw new DomainValidationError("checkin_closed", "Innsjekken er avsluttet.", 409);
      }
      const current = await this.effectiveSettingsWith(db, row);
      const method = normalizeMethod(current.effective_method);
      if (!methodUsesCode(method)) {
        throw new DomainValidationError(
          "checkin_code_not_enabled",
          "Denne turneringen bruker ikke innsjekk-kode.",
          409,
        );
      }
      const code = await this.generateUniqueCodeWith(db, requiredId(row.club_id, "club_id"), tournamentId);
      await db.execute(`UPDATE \`${this.prefix}tournaments\` SET checkin_code=? WHERE id=?`, [code, tournamentId]);
      const fresh = await this.requireTournamentSettingsWith(db, tournamentId);
      return this.effectiveSettingsWith(db, fresh);
    });
  }

  async statusForPlayer(tournamentIdInput: unknown, playerIdInput: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    const playerId = requiredId(playerIdInput, "player_id");
    return this.sessions.withConnection(async (db) => {
      const row = await this.requireTournamentSettingsWith(db, tournamentId);
      const settings = await this.effectiveSettingsWith(db, row);
      const registration = await this.registrationWith(db, tournamentId, playerId);
      const status = String(row.status ?? "");
      const opensAt = nullableString(settings.effective_checkin_opens_at);
      const windowState = status !== "draft"
        ? "closed"
        : await this.windowStateWith(db, opensAt);
      const method = normalizeMethod(settings.effective_method);
      return {
        tournament_id: publicId(tournamentId),
        registration_status: registration?.status ?? null,
        window_state: windowState,
        opens_at: opensAt,
        closes_at: row.checkin_closes_at ?? null,
        method,
        code_allowed: status === "draft" && methodUsesCode(method),
        admin_checkin_allowed: status === "draft",
        checked_in_at: registration?.checked_in_at ?? null,
        checkin_source: registration?.checkin_source ?? null,
      };
    });
  }

  async adminCheckIn(tournamentIdInput: unknown, playerIdInput: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    const playerId = requiredId(playerIdInput, "player_id");
    return this.sessions.withTransaction(async (db) => {
      const tournament = await this.requireTournamentSettingsWith(db, tournamentId);
      if (String(tournament.status ?? "") !== "draft") {
        throw new DomainValidationError("checkin_closed", "Innsjekken er avsluttet.", 409);
      }
      const registration = await this.registrationWith(db, tournamentId, playerId);
      if (registration === null) {
        throw new DomainValidationError(
          "registration_required_before_check_in",
          "Du må være påmeldt før du kan sjekke inn.",
        );
      }
      const status = String(registration.status ?? "");
      if (status === "checked_in") return formatRegistration(registration);
      if (status === "waitlisted") {
        throw new DomainValidationError(
          "registration_waitlisted",
          "Du står på venteliste og kan ikke sjekke inn før du har fått plass.",
        );
      }
      if (status !== "registered") {
        throw new DomainValidationError("registration_not_checkin_eligible", "Denne påmeldingen kan ikke sjekkes inn.");
      }
      const registrationId = requiredId(registration.id, "registration_id");
      await db.execute(
        `UPDATE \`${this.prefix}tournament_players\`
            SET status='checked_in',checked_in_at=NOW(3),checkin_source='admin_override'
          WHERE id=?`,
        [registrationId],
      );
      const fresh = await this.registrationWith(db, tournamentId, playerId);
      if (fresh === null) throw new DomainValidationError("registration_not_found", "Påmeldingen ble ikke funnet.", 404);
      return formatRegistration(fresh);
    });
  }

  async adminCheckOut(tournamentIdInput: unknown, playerIdInput: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    const playerId = requiredId(playerIdInput, "player_id");
    return this.sessions.withTransaction(async (db) => {
      const tournament = await this.requireTournamentSettingsWith(db, tournamentId);
      if (String(tournament.status ?? "") !== "draft") {
        throw new DomainValidationError("checkin_closed", "Innsjekken er avsluttet.", 409);
      }
      const registration = await this.registrationWith(db, tournamentId, playerId);
      if (registration === null) throw new DomainValidationError("registration_not_found", "Påmeldingen ble ikke funnet.", 404);
      if (String(registration.status ?? "") !== "checked_in") {
        throw new DomainValidationError("registration_not_checked_in", "Spilleren er ikke sjekket inn.", 409);
      }
      const registrationId = requiredId(registration.id, "registration_id");
      await db.execute(
        `UPDATE \`${this.prefix}tournament_players\`
            SET status='registered',checked_in_at=NULL,checkin_source=NULL
          WHERE id=?`,
        [registrationId],
      );
      const fresh = await this.registrationWith(db, tournamentId, playerId);
      if (fresh === null) throw new DomainValidationError("registration_not_found", "Påmeldingen ble ikke funnet.", 404);
      return formatRegistration(fresh);
    });
  }

  async addGuest(
    tournamentIdInput: unknown,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    const firstName = String(payload.first_name ?? "").trim();
    const lastName = String(payload.last_name ?? "").trim();
    if (firstName === "" || lastName === "") {
      throw new DomainValidationError("guest_name_required", "Fornavn og etternavn må fylles ut.");
    }
    if (firstName.length > 120 || lastName.length > 120) {
      throw new DomainValidationError("guest_name_too_long", "Navnet er for langt.");
    }

    return this.sessions.withTransaction(async (db) => {
      const tournament = await this.requireTournamentSettingsWith(db, tournamentId);
      if (String(tournament.status ?? "") !== "draft") {
        throw new DomainValidationError("checkin_closed", "Innsjekken er avsluttet.", 409);
      }
      const duplicate = await db.query<QueryResultRow>(
        `SELECT tp.id
           FROM \`${this.prefix}tournament_players\` tp
           INNER JOIN \`${this.prefix}players\` p ON p.id=tp.player_id
          WHERE tp.tournament_id=? AND tp.status NOT IN ('withdrawn','no_show')
            AND LOWER(p.first_name)=LOWER(?) AND LOWER(p.last_name)=LOWER(?)
          LIMIT 1`,
        [tournamentId, firstName, lastName],
      );
      if (duplicate.length > 0) {
        throw new DomainValidationError("guest_already_added", "Denne spilleren er allerede lagt til i turneringen.", 409);
      }
      const maxRows = await db.query<QueryResultRow>(
        `SELECT max_players FROM \`${this.prefix}tournaments\` WHERE id=? LIMIT 1`,
        [tournamentId],
      );
      const maxPlayersRaw = maxRows[0]?.max_players;
      if (maxPlayersRaw !== null && maxPlayersRaw !== undefined) {
        const activeRows = await db.query<QueryResultRow>(
          `SELECT COUNT(*) AS cnt FROM \`${this.prefix}tournament_players\`
            WHERE tournament_id=? AND status IN ('registered','checked_in','waitlisted','paused')`,
          [tournamentId],
        );
        if (Number(activeRows[0]?.cnt ?? 0) >= Number(maxPlayersRaw)) {
          throw new DomainValidationError("tournament_full", "Turneringen har nådd maks antall spillere.", 409);
        }
      }
      const displayName = `${firstName} ${lastName}`.trim();
      const player = await db.execute(
        `INSERT INTO \`${this.prefix}players\` (club_id,display_name,first_name,last_name,is_active)
         VALUES (NULL,?,?,?,1)`,
        [displayName, firstName, lastName],
      );
      const playerId = requiredId(player.insertId, "player_id");
      const registration = await db.execute(
        `INSERT INTO \`${this.prefix}tournament_players\`
          (tournament_id,player_id,status,registration_source,checked_in_at,checkin_source)
         VALUES (?,?,'checked_in','guest_admin',NOW(3),'admin_guest')`,
        [tournamentId, playerId],
      );
      return {
        id: publicId(requiredId(registration.insertId, "registration_id")),
        tournament_id: publicId(tournamentId),
        player_id: publicId(playerId),
        display_name: displayName,
        first_name: firstName,
        last_name: lastName,
        status: "checked_in",
        registration_source: "guest_admin",
      };
    });
  }

  private async getClubSettingsWith(db: SqlExecutor, clubId: string): Promise<Record<string, unknown>> {
    const rows = await db.query<QueryResultRow>(
      `SELECT club_id,default_method,opens_minutes_before_start,closes_minutes_after_start,
              updated_by_user_id,created_at,updated_at
         FROM \`${this.prefix}club_checkin_settings\` WHERE club_id=? LIMIT 1`,
      [clubId],
    );
    const row = rows[0] ?? {};
    return {
      club_id: publicId(clubId),
      default_method: row.default_method ?? "admin_or_code",
      opens_minutes_before_start: Number(row.opens_minutes_before_start ?? 60),
      closes_minutes_after_start: Number(row.closes_minutes_after_start ?? 10),
      ...(row.updated_by_user_id === undefined ? {} : { updated_by_user_id: row.updated_by_user_id }),
      ...(row.created_at === undefined ? {} : { created_at: row.created_at }),
      ...(row.updated_at === undefined ? {} : { updated_at: row.updated_at }),
    };
  }

  private async tournamentSettingsWith(db: SqlExecutor, tournamentId: string): Promise<TournamentSettingsRow | null> {
    const rows = await db.query<TournamentSettingsRow>(
      `SELECT id,club_id,name,status,start_at,checkin_opens_at,checkin_closes_at,checkin_method,checkin_code
         FROM \`${this.prefix}tournaments\` WHERE id=? LIMIT 1`,
      [tournamentId],
    );
    return rows[0] ?? null;
  }

  private async requireTournamentSettingsWith(db: SqlExecutor, tournamentId: string): Promise<TournamentSettingsRow> {
    const row = await this.tournamentSettingsWith(db, tournamentId);
    if (row === null) throw new DomainValidationError("tournament_not_found", "Turneringen ble ikke funnet.", 404);
    return row;
  }

  private async effectiveSettingsWith(db: SqlExecutor, row: TournamentSettingsRow): Promise<Record<string, unknown>> {
    const clubId = requiredId(row.club_id, "club_id");
    const club = await this.getClubSettingsWith(db, clubId);
    const startAt = nullableString(row.start_at);
    if (startAt === null) {
      throw new DomainValidationError(
        "checkin_start_time_required",
        "Turneringen må ha starttid før innsjekk kan konfigureres.",
      );
    }
    const opens = nullableString(row.checkin_opens_at)
      ?? shiftMinutes(startAt, -Number(club.opens_minutes_before_start ?? 60));
    const method = nullableMethod(row.checkin_method) ?? normalizeMethod(club.default_method);
    return {
      id: publicId(requiredId(row.id, "tournament_id")),
      club_id: publicId(clubId),
      name: row.name ?? null,
      status: String(row.status ?? ""),
      start_at: row.start_at ?? null,
      checkin_opens_at: row.checkin_opens_at ?? null,
      checkin_closes_at: row.checkin_closes_at ?? null,
      checkin_method: row.checkin_method ?? null,
      checkin_code: row.checkin_code ?? null,
      ...club,
      effective_checkin_opens_at: opens,
      effective_checkin_closes_at: row.checkin_closes_at ?? null,
      effective_method: method,
    };
  }

  private async registrationWith(db: SqlExecutor, tournamentId: string, playerId: string): Promise<RegistrationRow | null> {
    const rows = await db.query<RegistrationRow>(
      `SELECT id,tournament_id,player_id,status,checked_in_at,checkin_source
         FROM \`${this.prefix}tournament_players\`
        WHERE tournament_id=? AND player_id=? LIMIT 1`,
      [tournamentId, playerId],
    );
    return rows[0] ?? null;
  }

  private async windowStateWith(db: SqlExecutor, opensAt: string | null): Promise<"not_open" | "open"> {
    if (opensAt === null) return "not_open";
    const rows = await db.query<QueryResultRow>(`SELECT CASE WHEN NOW(3) >= ? THEN 1 ELSE 0 END AS is_open`, [opensAt]);
    return Number(rows[0]?.is_open ?? 0) === 1 ? "open" : "not_open";
  }

  private async generateUniqueCodeWith(db: SqlExecutor, clubId: string, excludeTournamentId: string): Promise<string> {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      let code = "";
      for (let index = 0; index < 3; index += 1) code += alphabet[randomInt(alphabet.length)];
      const rows = await db.query<QueryResultRow>(
        `SELECT id FROM \`${this.prefix}tournaments\` WHERE club_id=? AND checkin_code=? AND id<>? LIMIT 1`,
        [clubId, code, excludeTournamentId],
      );
      if (rows.length === 0) return code;
    }
    throw new DomainValidationError("checkin_code_generation_failed", "Kunne ikke lage en unik innsjekk-kode.", 500);
  }
}

function formatRegistration(row: RegistrationRow): Record<string, unknown> {
  return {
    id: publicId(requiredId(row.id, "registration_id")),
    tournament_id: publicId(requiredId(row.tournament_id, "tournament_id")),
    player_id: publicId(requiredId(row.player_id, "player_id")),
    status: String(row.status ?? ""),
    checked_in_at: row.checked_in_at ?? null,
    checkin_source: row.checkin_source ?? null,
  };
}

function normalizeMethod(value: unknown): CheckinMethod {
  const method = String(value ?? "").trim().toLowerCase();
  return method === "admin_only" || method === "code" ? method : "admin_or_code";
}

function nullableMethod(value: unknown): CheckinMethod | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  if (text === "" || text === "inherit") return null;
  if (text === "admin_or_code" || text === "admin_only" || text === "code") return text;
  throw new DomainValidationError("invalid_checkin_method", "Ugyldig metode for innsjekk.");
}

function methodUsesCode(method: CheckinMethod): boolean {
  return method === "admin_or_code" || method === "code";
}

function normalizeCode(value: unknown): string | null {
  const code = String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code === "") return null;
  if (code.length < 3 || code.length > 12) {
    throw new DomainValidationError("invalid_checkin_code", "Innsjekk-koden må være 3–12 tegn.");
  }
  return code;
}

function nullableDateTime(value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const text = String(value).trim();
  const plain = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/.exec(text);
  if (plain) return `${plain[1]} ${plain[2]}:${plain[3] ?? "00"}`;
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) {
    throw new DomainValidationError("invalid_checkin_datetime", "Ugyldig dato eller tidspunkt for innsjekk.");
  }
  return parsed.toISOString().slice(0, 19).replace("T", " ");
}

function shiftMinutes(value: string, minutes: number): string {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const parsed = new Date(`${normalized}Z`);
  if (!Number.isFinite(parsed.getTime())) {
    throw new DomainValidationError("invalid_checkin_datetime", "Ugyldig dato eller tidspunkt for innsjekk.");
  }
  parsed.setUTCMinutes(parsed.getUTCMinutes() + minutes);
  return parsed.toISOString().slice(0, 19).replace("T", " ");
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace("T", " ");
  const text = String(value).trim();
  return text === "" ? null : text;
}

function boolValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function clampInt(value: unknown, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  const finite = Number.isFinite(parsed) ? parsed : 0;
  return Math.min(max, Math.max(min, finite));
}

function requiredId(value: unknown, name: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new DomainValidationError("invalid_id", `${name} must be a positive decimal id.`, 400);
  }
  return normalized;
}

function publicId(value: string): number | string {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
}
