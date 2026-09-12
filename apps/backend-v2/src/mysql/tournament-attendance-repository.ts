import { DomainValidationError } from "../domain/errors.js";
import { MySqlTournamentAttendanceAdminRepository } from "./tournament-attendance-admin-repository.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

interface AttendanceTournamentRow extends QueryResultRow {
  id: unknown;
  club_id: unknown;
  status: unknown;
  start_at: unknown;
  checkin_opens_at: unknown;
  checkin_method: unknown;
  checkin_code: unknown;
  effective_checkin_opens_at: unknown;
  effective_method: unknown;
  window_open: unknown;
}

interface RegistrationRow extends QueryResultRow {
  id: unknown;
  tournament_id: unknown;
  player_id: unknown;
  status: unknown;
  checked_in_at: unknown;
  checkin_source: unknown;
}

export interface TournamentAttendanceResult {
  tournament_id: string;
  status: "ready";
  checked_in_count: number;
  no_show_count?: number;
  withdrawn_waitlist_count?: number;
  already_finished: boolean;
}

export class MySqlTournamentAttendanceRepository {
  private static readonly MIN_PLAYERS = 2;
  private readonly admin: MySqlTournamentAttendanceAdminRepository;

  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly prefix: TablePrefix,
  ) {
    this.admin = new MySqlTournamentAttendanceAdminRepository(sessions, prefix);
  }

  async findTournament(tournamentIdInput: unknown): Promise<Record<string, unknown> | null> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withConnection(async (db) => {
      const row = await this.findTournamentWith(db, tournamentId);
      if (row === null) return null;
      return {
        id: publicId(requiredId(row.id, "tournament_id")),
        club_id: publicId(requiredId(row.club_id, "club_id")),
        status: String(row.status ?? ""),
      };
    });
  }

  async getClubSettings(clubIdInput: unknown): Promise<Record<string, unknown>> {
    return this.admin.getClubSettings(clubIdInput);
  }

  async updateClubSettings(
    clubIdInput: unknown,
    payload: Record<string, unknown>,
    userIdInput: unknown,
  ): Promise<Record<string, unknown>> {
    return this.admin.updateClubSettings(clubIdInput, payload, userIdInput);
  }

  async getTournamentSettings(tournamentIdInput: unknown): Promise<Record<string, unknown> | null> {
    return this.admin.getTournamentSettings(tournamentIdInput);
  }

  async updateTournamentSettings(
    tournamentIdInput: unknown,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.admin.updateTournamentSettings(tournamentIdInput, payload);
  }

  async rotateTournamentCode(tournamentIdInput: unknown): Promise<Record<string, unknown>> {
    return this.admin.rotateTournamentCode(tournamentIdInput);
  }

  async statusForPlayer(tournamentIdInput: unknown, playerIdInput: unknown): Promise<Record<string, unknown>> {
    return this.admin.statusForPlayer(tournamentIdInput, playerIdInput);
  }

  async adminCheckIn(tournamentIdInput: unknown, playerIdInput: unknown): Promise<Record<string, unknown>> {
    return this.admin.adminCheckIn(tournamentIdInput, playerIdInput);
  }

  async adminCheckOut(tournamentIdInput: unknown, playerIdInput: unknown): Promise<Record<string, unknown>> {
    return this.admin.adminCheckOut(tournamentIdInput, playerIdInput);
  }

  async addGuest(tournamentIdInput: unknown, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.admin.addGuest(tournamentIdInput, payload);
  }

  async checkInPlayer(
    tournamentIdInput: unknown,
    playerIdInput: unknown,
    codeInput: unknown,
  ): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    const playerId = requiredId(playerIdInput, "player_id");

    return this.sessions.withTransaction(async (db) => {
      const tournament = await this.requireTournamentWith(db, tournamentId);
      if (String(tournament.status ?? "") !== "draft") {
        throw new DomainValidationError("checkin_closed", "Innsjekken er avsluttet.", 409);
      }
      if (tournament.start_at === null || tournament.start_at === undefined || String(tournament.start_at).trim() === "") {
        throw new DomainValidationError(
          "checkin_start_time_required",
          "Turneringen må ha starttid før innsjekk kan konfigureres.",
        );
      }

      const registration = await this.registrationWith(db, tournamentId, playerId);
      if (registration === null) {
        throw new DomainValidationError(
          "registration_required_before_check_in",
          "Du må være påmeldt før du kan sjekke inn.",
        );
      }

      const status = String(registration.status ?? "");
      if (status === "checked_in") {
        return formatCheckinResult(tournamentId, playerId, registration, true);
      }
      if (status === "waitlisted") {
        throw new DomainValidationError(
          "registration_waitlisted",
          "Du står på venteliste og kan ikke sjekke inn før du har fått plass.",
        );
      }
      if (status !== "registered") {
        throw new DomainValidationError(
          "registration_not_checkin_eligible",
          "Denne påmeldingen kan ikke sjekkes inn.",
        );
      }

      if (Number(tournament.window_open ?? 0) !== 1) {
        throw new DomainValidationError("checkin_not_open", "Innsjekken er ikke åpnet ennå.", 409);
      }

      const method = normalizeMethod(tournament.effective_method);
      if (method === "admin_only") {
        throw new DomainValidationError(
          "checkin_admin_required",
          "Denne turneringen sjekkes inn av turneringsleder.",
          409,
        );
      }

      const code = normalizeCode(codeInput);
      if (code === null) {
        throw new DomainValidationError(
          "checkin_code_required",
          "Tast inn innsjekk-koden som vises i lokalet.",
        );
      }
      const expectedCode = normalizeCode(tournament.checkin_code);
      if (expectedCode === null || expectedCode !== code) {
        throw new DomainValidationError(
          "checkin_code_invalid",
          "Innsjekk-koden stemmer ikke. Se koden på Live-skjermen eller kontakt turneringsleder.",
          409,
        );
      }

      const registrationId = requiredId(registration.id, "registration_id");
      await db.execute(
        `UPDATE \`${this.prefix}tournament_players\`
            SET status='checked_in', checked_in_at=NOW(3), checkin_source='player_code'
          WHERE id=?`,
        [registrationId],
      );
      const fresh = await this.registrationWith(db, tournamentId, playerId);
      if (fresh === null) {
        throw new DomainValidationError("registration_not_found", "Påmeldingen ble ikke funnet.", 404);
      }
      return formatCheckinResult(tournamentId, playerId, fresh, false);
    });
  }

  async finishCheckin(tournamentIdInput: unknown): Promise<TournamentAttendanceResult> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withTransaction(async (db) => {
      const tournament = await this.requireTournamentWith(db, tournamentId);
      const status = String(tournament.status ?? "");
      if (status === "ready") {
        return {
          tournament_id: tournamentId,
          status: "ready",
          checked_in_count: await this.countStatusWith(db, tournamentId, ["checked_in"]),
          already_finished: true,
        };
      }
      if (status !== "draft") {
        throw new DomainValidationError("checkin_closed", "Innsjekken er allerede avsluttet.", 409);
      }

      const checkedIn = await this.countStatusWith(db, tournamentId, ["checked_in"]);
      if (checkedIn < MySqlTournamentAttendanceRepository.MIN_PLAYERS) {
        throw new DomainValidationError(
          "not_enough_checked_in_players",
          "Minst to spillere må være sjekket inn før du kan gå videre.",
        );
      }

      const noShows = await db.execute(
        `UPDATE \`${this.prefix}tournament_players\`
            SET status='no_show', seed=NULL, seed_rating=NULL, seed_rating_source=NULL
          WHERE tournament_id=? AND status IN ('registered','paused')`,
        [tournamentId],
      );
      const waitlist = await db.execute(
        `UPDATE \`${this.prefix}tournament_players\`
            SET status='withdrawn', seed=NULL, seed_rating=NULL, seed_rating_source=NULL
          WHERE tournament_id=? AND status='waitlisted'`,
        [tournamentId],
      );
      await db.execute(
        `UPDATE \`${this.prefix}tournaments\`
            SET status='ready', checkin_closes_at=NOW(), registration_closes_at=NOW()
          WHERE id=? AND status='draft'`,
        [tournamentId],
      );

      return {
        tournament_id: tournamentId,
        status: "ready",
        checked_in_count: checkedIn,
        no_show_count: noShows.affectedRows,
        withdrawn_waitlist_count: waitlist.affectedRows,
        already_finished: false,
      };
    });
  }

  private async findTournamentWith(db: SqlExecutor, tournamentId: string): Promise<AttendanceTournamentRow | null> {
    const rows = await db.query<AttendanceTournamentRow>(
      `SELECT t.id,t.club_id,t.status,t.start_at,t.checkin_opens_at,t.checkin_method,t.checkin_code,
              COALESCE(t.checkin_opens_at,
                       DATE_SUB(t.start_at, INTERVAL COALESCE(ccs.opens_minutes_before_start,60) MINUTE)) AS effective_checkin_opens_at,
              COALESCE(t.checkin_method,ccs.default_method,'admin_or_code') AS effective_method,
              CASE WHEN NOW(3) >= COALESCE(t.checkin_opens_at,
                       DATE_SUB(t.start_at, INTERVAL COALESCE(ccs.opens_minutes_before_start,60) MINUTE))
                   THEN 1 ELSE 0 END AS window_open
         FROM \`${this.prefix}tournaments\` t
         LEFT JOIN \`${this.prefix}club_checkin_settings\` ccs ON ccs.club_id=t.club_id
        WHERE t.id=? LIMIT 1`,
      [tournamentId],
    );
    return rows[0] ?? null;
  }

  private async requireTournamentWith(db: SqlExecutor, tournamentId: string): Promise<AttendanceTournamentRow> {
    const tournament = await this.findTournamentWith(db, tournamentId);
    if (tournament === null) {
      throw new DomainValidationError("tournament_not_found", "Turneringen ble ikke funnet.", 404);
    }
    return tournament;
  }

  private async registrationWith(
    db: SqlExecutor,
    tournamentId: string,
    playerId: string,
  ): Promise<RegistrationRow | null> {
    const rows = await db.query<RegistrationRow>(
      `SELECT id,tournament_id,player_id,status,checked_in_at,checkin_source
         FROM \`${this.prefix}tournament_players\`
        WHERE tournament_id=? AND player_id=? LIMIT 1`,
      [tournamentId, playerId],
    );
    return rows[0] ?? null;
  }

  private async countStatusWith(db: SqlExecutor, tournamentId: string, statuses: readonly string[]): Promise<number> {
    const placeholders = statuses.map(() => "?").join(",");
    const rows = await db.query<QueryResultRow>(
      `SELECT COUNT(*) AS cnt FROM \`${this.prefix}tournament_players\`
        WHERE tournament_id=? AND status IN (${placeholders})`,
      [tournamentId, ...statuses],
    );
    return Number(rows[0]?.cnt ?? 0);
  }
}

function formatCheckinResult(
  tournamentId: string,
  playerId: string,
  registration: RegistrationRow,
  alreadyCheckedIn: boolean,
): Record<string, unknown> {
  return {
    tournament_id: publicId(tournamentId),
    player_id: publicId(playerId),
    status: "checked_in",
    checked_in_at: registration.checked_in_at ?? null,
    checkin_source: registration.checkin_source ?? null,
    already_checked_in: alreadyCheckedIn,
  };
}

function normalizeMethod(value: unknown): "admin_or_code" | "admin_only" | "code" {
  const method = String(value ?? "").trim().toLowerCase();
  return method === "admin_only" || method === "code" ? method : "admin_or_code";
}

function normalizeCode(value: unknown): string | null {
  const code = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (code === "") return null;
  if (code.length < 3 || code.length > 12) {
    throw new DomainValidationError("invalid_checkin_code", "Innsjekk-koden må være 3–12 tegn.");
  }
  return code;
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
