import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, TablePrefix } from "./contracts.js";

interface TournamentRow extends QueryResultRow {
  id: unknown;
  club_id: unknown;
  status: unknown;
  auto_assign_enabled: unknown;
}

export class MySqlTournamentOperationsRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly prefix: TablePrefix,
  ) {}

  async findTournament(tournamentIdInput: unknown): Promise<TournamentRow | null> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<TournamentRow>(
        `SELECT id, club_id, status, auto_assign_enabled
           FROM \`${this.prefix}tournaments\` WHERE id=? LIMIT 1`,
        [tournamentId],
      );
      return rows[0] ?? null;
    });
  }

  async updateAutoAssignEnabled(tournamentIdInput: unknown, enabledInput: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    if (typeof enabledInput !== "boolean") {
      throw new DomainValidationError("auto_assign_enabled_required", "auto_assign_enabled is required.");
    }
    const tournament = await this.requireTournament(tournamentId);
    await this.sessions.withConnection(async (db) => {
      await db.execute(
        `UPDATE \`${this.prefix}tournaments\` SET auto_assign_enabled=? WHERE id=?`,
        [enabledInput ? 1 : 0, tournamentId],
      );
    });
    return {
      tournament_id: publicId(tournamentId),
      club_id: publicId(requiredId(tournament.club_id, "club_id")),
      auto_assign_enabled: enabledInput,
    };
  }

  async boardSelection(tournamentIdInput: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withConnection(async (db) => {
      const tournament = await this.requireTournamentWith(db, tournamentId);
      const clubId = requiredId(tournament.club_id, "club_id");
      const selectedRows = await db.query<QueryResultRow>(
        `SELECT kiosk_id FROM \`${this.prefix}tournament_kiosks\`
          WHERE tournament_id=? ORDER BY sort_order ASC, kiosk_id ASC`,
        [tournamentId],
      );
      const selected = selectedRows.map((row) => requiredId(row.kiosk_id, "kiosk_id"));
      const selectionInitialized = selected.length > 0;
      const selectedSet = new Set(selected);
      const rows = await db.query<QueryResultRow>(
        `SELECT k.id, k.code, k.name, k.board_number, k.scoring_mode, k.is_active,
                EXISTS(SELECT 1 FROM \`${this.prefix}matches\` m
                        WHERE m.kiosk_id=k.id AND m.status IN ('assigned','in_progress')) AS is_busy,
                EXISTS(SELECT 1 FROM \`${this.prefix}tournament_board_reservations\` r
                        WHERE r.kiosk_id=k.id) AS is_reserved
           FROM \`${this.prefix}kiosks\` k
          WHERE k.club_id=?
          ORDER BY k.board_number ASC, k.id ASC`,
        [clubId],
      );
      const boards = rows.map((row) => {
        const id = requiredId(row.id, "kiosk_id");
        const active = numberValue(row.is_active) === 1;
        const busy = numberValue(row.is_busy) === 1;
        const reserved = numberValue(row.is_reserved) === 1;
        const selectedBoard = selectionInitialized ? selectedSet.has(id) : active;
        return {
          id: publicId(id),
          code: stringValue(row.code),
          name: stringValue(row.name),
          board_number: numberValue(row.board_number),
          scoring_mode: stringValue(row.scoring_mode),
          is_active: active,
          is_busy: busy,
          is_reserved: reserved,
          selected: selectedBoard,
          can_remove: !busy && !reserved,
          removal_requires_move: busy,
        };
      });
      return {
        tournament_id: publicId(tournamentId),
        tournament_status: String(tournament.status ?? ""),
        selection_initialized: selectionInitialized,
        boards,
        selected_count: boards.filter((board) => board.selected).length,
      };
    });
  }

  async replaceBoardSelection(tournamentIdInput: unknown, rawKioskIds: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    if (!Array.isArray(rawKioskIds)) {
      throw new DomainValidationError("tournament_board_required", "Velg minst én aktiv skive til turneringen.");
    }
    const kioskIds = [...new Set(rawKioskIds.map((value) => requiredId(value, "kiosk_id")))];
    if (kioskIds.length === 0) {
      throw new DomainValidationError("tournament_board_required", "Velg minst én aktiv skive til turneringen.");
    }

    await this.sessions.withTransaction(async (db) => {
      const tournament = await this.requireTournamentWith(db, tournamentId);
      const status = String(tournament.status ?? "");
      if (status === "completed" || status === "archived") {
        throw new DomainValidationError(
          "tournament_boards_locked",
          "Skiver kan ikke endres etter at turneringen er avsluttet.",
          409,
        );
      }
      const clubId = requiredId(tournament.club_id, "club_id");
      const placeholders = kioskIds.map(() => "?").join(",");
      const validBoards = await db.query<QueryResultRow>(
        `SELECT id FROM \`${this.prefix}kiosks\`
          WHERE club_id=? AND is_active=1 AND id IN (${placeholders}) FOR UPDATE`,
        [clubId, ...kioskIds],
      );
      const validSet = new Set(validBoards.map((row) => requiredId(row.id, "kiosk_id")));
      if (validSet.size !== kioskIds.length) {
        throw new DomainValidationError(
          "invalid_tournament_board",
          "En valgt skive finnes ikke i klubben eller er deaktivert.",
        );
      }

      const currentRows = await db.query<QueryResultRow>(
        `SELECT kiosk_id FROM \`${this.prefix}tournament_kiosks\`
          WHERE tournament_id=? ORDER BY sort_order ASC, kiosk_id ASC FOR UPDATE`,
        [tournamentId],
      );
      const current = currentRows.map((row) => requiredId(row.kiosk_id, "kiosk_id"));
      const keep = new Set(kioskIds);
      const removed = current.filter((id) => !keep.has(id));
      if (removed.length > 0) {
        const removedPlaceholders = removed.map(() => "?").join(",");
        const blocked = await db.query<QueryResultRow>(
          `SELECT DISTINCT kiosk_id FROM \`${this.prefix}matches\`
            WHERE tournament_id=? AND kiosk_id IN (${removedPlaceholders})
              AND status IN ('assigned','in_progress') FOR UPDATE`,
          [tournamentId, ...removed],
        );
        if (blocked.length > 0) {
          throw new DomainValidationError(
            "tournament_board_in_use",
            "En valgt skive har en aktiv kamp. Flytt kampen før skiven fjernes.",
            409,
          );
        }
        await db.execute(
          `DELETE FROM \`${this.prefix}tournament_board_reservations\`
            WHERE tournament_id=? AND kiosk_id IN (${removedPlaceholders})`,
          [tournamentId, ...removed],
        );
      }

      await db.execute(`DELETE FROM \`${this.prefix}tournament_kiosks\` WHERE tournament_id=?`, [tournamentId]);
      for (let index = 0; index < kioskIds.length; index += 1) {
        await db.execute(
          `INSERT INTO \`${this.prefix}tournament_kiosks\` (tournament_id,kiosk_id,sort_order) VALUES (?,?,?)`,
          [tournamentId, kioskIds[index], index + 1],
        );
      }
    });

    return this.boardSelection(tournamentId);
  }

  private async requireTournament(tournamentId: string): Promise<TournamentRow> {
    const tournament = await this.findTournament(tournamentId);
    if (tournament === null) {
      throw new DomainValidationError("tournament_not_found", "Tournament was not found.", 404);
    }
    return tournament;
  }

  private async requireTournamentWith(
    db: { query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<readonly T[]> },
    tournamentId: string,
  ): Promise<TournamentRow> {
    const rows = await db.query<TournamentRow>(
      `SELECT id, club_id, status, auto_assign_enabled FROM \`${this.prefix}tournaments\` WHERE id=? LIMIT 1`,
      [tournamentId],
    );
    const tournament = rows[0] ?? null;
    if (tournament === null) {
      throw new DomainValidationError("tournament_not_found", "Tournament was not found.", 404);
    }
    return tournament;
  }
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

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringValue(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
