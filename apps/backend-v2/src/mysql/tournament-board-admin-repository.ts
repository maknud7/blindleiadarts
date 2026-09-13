import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

export class MySqlTournamentBoardAdminRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly prefix: TablePrefix,
  ) {}

  async findTournament(tournamentIdInput: unknown): Promise<Record<string, unknown> | null> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withConnection(async (db) => this.findTournamentWith(db, tournamentId));
  }

  async findMatchContext(matchIdInput: unknown): Promise<Record<string, unknown> | null> {
    const matchId = requiredId(matchIdInput, "match_id");
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT m.id,m.tournament_id,t.club_id FROM \`${this.prefix}matches\` m
         INNER JOIN \`${this.prefix}tournaments\` t ON t.id=m.tournament_id
         WHERE m.id=? LIMIT 1`,
        [matchId],
      );
      const row = rows[0];
      return row ? { id: requiredId(row.id, "match_id"), tournament_id: requiredId(row.tournament_id, "tournament_id"), club_id: requiredId(row.club_id, "club_id") } : null;
    });
  }

  async boardAssignmentOverview(tournamentIdInput: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withConnection(async (db) => this.boardAssignmentOverviewWith(db, tournamentId));
  }

  async replaceBoardAssignments(tournamentIdInput: unknown, kioskIdsInput: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    const raw = Array.isArray(kioskIdsInput) ? kioskIdsInput : [];
    const kioskIds = [...new Set(raw.map((value) => optionalId(value)).filter((value): value is string => value !== null))];

    return this.sessions.withTransaction(async (db) => {
      const tournament = await this.requireTournamentWith(db, tournamentId);
      const clubId = requiredId(tournament.club_id, "club_id");
      if (kioskIds.length > 0) {
        const rows = await db.query<QueryResultRow>(
          `SELECT id FROM \`${this.prefix}kiosks\` WHERE club_id=?`,
          [clubId],
        );
        const allowed = new Set(rows.map((row) => requiredId(row.id, "kiosk_id")));
        for (const kioskId of kioskIds) {
          if (!allowed.has(kioskId)) {
            throw new DomainValidationError("kiosk_not_in_club", "One or more selected boards do not belong to this club.", 422);
          }
        }
      }

      await db.execute(`DELETE FROM \`${this.prefix}tournament_kiosks\` WHERE tournament_id=?`, [tournamentId]);
      for (let index = 0; index < kioskIds.length; index += 1) {
        await db.execute(
          `INSERT INTO \`${this.prefix}tournament_kiosks\` (tournament_id,kiosk_id,sort_order) VALUES (?,?,?)`,
          [tournamentId, kioskIds[index]!, index + 1],
        );
      }
      return this.boardAssignmentOverviewWith(db, tournamentId);
    });
  }

  async createMatch(tournamentIdInput: unknown, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    const playerAId = requiredId(payload.player_a_id, "player_a_id");
    const playerBId = requiredId(payload.player_b_id, "player_b_id");
    if (playerAId === playerBId) {
      throw new DomainValidationError("invalid_match_players", "Two distinct players are required to create a match.", 422);
    }
    const kioskId = optionalId(payload.kiosk_id);
    const roundLabel = nullableString(payload.round_label);
    const bracketLabel = nullableString(payload.bracket_label);
    const bestOfLegs = positiveIntOrDefault(payload.best_of_legs, 3);
    const legsToWin = positiveIntOrDefault(payload.legs_to_win, Math.floor(bestOfLegs / 2) + 1);

    return this.sessions.withTransaction(async (db) => {
      const tournament = await this.requireTournamentWith(db, tournamentId);
      const clubId = requiredId(tournament.club_id, "club_id");
      await this.assertPlayersRegisteredWith(db, tournamentId, playerAId, playerBId);
      if (kioskId !== null) {
        await this.assertPlayersCheckedInWith(db, tournamentId, playerAId, playerBId);
        await this.assertKioskCanBeUsedWith(db, tournamentId, clubId, kioskId, null, playerAId, playerBId);
      }
      const status = kioskId === null ? "pending" : "assigned";
      const insert = await db.execute(
        `INSERT INTO \`${this.prefix}matches\`
          (tournament_id,kiosk_id,round_label,bracket_label,status,best_of_legs,legs_to_win,player_a_id,player_b_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [tournamentId, kioskId, roundLabel, bracketLabel, status, bestOfLegs, legsToWin, playerAId, playerBId],
      );
      const matchId = requiredId(insert.insertId, "match_id");
      const match = await this.findMatchWith(db, matchId);
      if (match === null) throw new DomainValidationError("match_not_found", "Match was not found after creation.", 500);
      return match;
    });
  }

  async autoAssignPendingMatches(tournamentIdInput: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withTransaction(async (db) => {
      const tournament = await this.requireTournamentWith(db, tournamentId);
      const clubId = requiredId(tournament.club_id, "club_id");
      const boards = await this.listBoardsWith(db, tournamentId, clubId, true);
      const availableBoards = boards.filter((board) => Number(board.is_assigned_to_tournament ?? 0) === 1 && Number(board.is_active ?? 0) === 1 && Number(board.is_available ?? 0) === 1);
      if (availableBoards.length === 0) {
        throw new DomainValidationError("no_tournament_boards_available", "No available boards are assigned to this tournament.", 422);
      }

      const queue = await this.listQueueWith(db, tournamentId, clubId);
      const pending = queue.filter((match) => String(match.status ?? "") === "pending");
      const busyPlayers = await this.busyPlayerIdsWith(db, clubId);
      const assigned: Record<string, unknown>[] = [];
      const skipped: Record<string, unknown>[] = [];
      let boardIndex = 0;

      for (const match of pending) {
        const playerAId = requiredId(match.player_a_id, "player_a_id");
        const playerBId = requiredId(match.player_b_id, "player_b_id");
        if (match.players_checked_in !== true) {
          skipped.push({ ...match, skip_reason: "En eller begge spillere er ikke checket inn på arenaen ennå." });
          continue;
        }
        if (busyPlayers.has(playerAId) || busyPlayers.has(playerBId)) {
          skipped.push({ ...match, skip_reason: "En eller begge spillere er opptatt i en annen aktiv kamp." });
          continue;
        }
        const board = availableBoards[boardIndex++];
        if (!board) {
          skipped.push({ ...match, skip_reason: "Ingen ledige boards igjen i denne turneringen." });
          continue;
        }
        const kioskId = requiredId(board.id, "kiosk_id");
        const matchId = requiredId(match.id, "match_id");
        const update = await db.execute(
          `UPDATE \`${this.prefix}matches\` SET kiosk_id=?,status='assigned',starts_at=NULL,finished_at=NULL WHERE id=? AND status='pending'`,
          [kioskId, matchId],
        );
        if (update.affectedRows !== 1) throw new DomainValidationError("match_assignment_conflict", "Match assignment changed concurrently.", 409);
        busyPlayers.add(playerAId); busyPlayers.add(playerBId);
        assigned.push({
          match_id: matchId,
          players: `${String(match.player_a_name ?? "").trim()} vs ${String(match.player_b_name ?? "").trim()}`,
          kiosk_id: kioskId,
          kiosk_name: board.name ?? null,
          board_number: board.board_number ?? null,
          kiosk_code: board.code ?? null,
        });
      }

      return {
        tournament,
        assigned_count: assigned.length,
        skipped_count: skipped.length,
        assigned,
        skipped,
        overview: await this.boardAssignmentOverviewWith(db, tournamentId),
      };
    });
  }

  async assignMatchToKiosk(matchIdInput: unknown, kioskIdInput: unknown): Promise<Record<string, unknown>> {
    const matchId = requiredId(matchIdInput, "match_id");
    const kioskId = requiredId(kioskIdInput, "kiosk_id");
    return this.sessions.withTransaction(async (db) => {
      const match = await this.findMatchWith(db, matchId, true);
      if (match === null) throw new DomainValidationError("match_not_found", "Match was not found.", 404);
      const tournamentId = requiredId(match.tournament_id, "tournament_id");
      const tournament = await this.requireTournamentWith(db, tournamentId);
      const clubId = requiredId(tournament.club_id, "club_id");
      const playerAId = requiredId(match.player_a_id, "player_a_id");
      const playerBId = requiredId(match.player_b_id, "player_b_id");
      await this.assertKioskCanBeUsedWith(db, tournamentId, clubId, kioskId, matchId, playerAId, playerBId);
      await this.assertPlayersCheckedInWith(db, tournamentId, playerAId, playerBId);
      await db.execute(
        `UPDATE \`${this.prefix}matches\` SET kiosk_id=?,status='assigned',starts_at=NULL,finished_at=NULL WHERE id=?`,
        [kioskId, matchId],
      );
      const updated = await this.findMatchWith(db, matchId);
      if (updated === null) throw new DomainValidationError("match_not_found", "Match was not found after assignment.", 500);
      return updated;
    });
  }

  private async boardAssignmentOverviewWith(db: SqlExecutor, tournamentId: string): Promise<Record<string, unknown>> {
    const tournament = await this.requireTournamentWith(db, tournamentId);
    const clubId = requiredId(tournament.club_id, "club_id");
    const boards = await this.listBoardsWith(db, tournamentId, clubId);
    const queue = await this.listQueueWith(db, tournamentId, clubId);
    return {
      tournament,
      boards,
      queue: {
        pending_count: queue.filter((row) => row.status === "pending").length,
        assigned_count: queue.filter((row) => row.status === "assigned").length,
        in_progress_count: queue.filter((row) => row.status === "in_progress").length,
        items: queue,
      },
    };
  }

  private async findTournamentWith(db: SqlExecutor, tournamentId: string): Promise<Record<string, unknown> | null> {
    const rows = await db.query<QueryResultRow>(`SELECT * FROM \`${this.prefix}tournaments\` WHERE id=? LIMIT 1`, [tournamentId]);
    const row = rows[0];
    return row ? normalizeIds(row, ["id", "club_id", "season_id"]) : null;
  }

  private async requireTournamentWith(db: SqlExecutor, tournamentId: string): Promise<Record<string, unknown>> {
    const tournament = await this.findTournamentWith(db, tournamentId);
    if (tournament === null) throw new DomainValidationError("tournament_not_found", "Tournament was not found.", 404);
    return tournament;
  }

  private async findMatchWith(db: SqlExecutor, matchId: string, forUpdate = false): Promise<Record<string, unknown> | null> {
    const rows = await db.query<QueryResultRow>(
      `SELECT m.id,m.tournament_id,m.kiosk_id,m.round_label,m.bracket_label,m.status,m.best_of_legs,m.legs_to_win,
              m.player_a_id,pa.display_name AS player_a_name,m.player_b_id,pb.display_name AS player_b_name,
              m.winner_player_id,m.starts_at,m.finished_at,k.code AS kiosk_code,k.name AS kiosk_name,k.board_number
       FROM \`${this.prefix}matches\` m
       INNER JOIN \`${this.prefix}players\` pa ON pa.id=m.player_a_id
       INNER JOIN \`${this.prefix}players\` pb ON pb.id=m.player_b_id
       LEFT JOIN \`${this.prefix}kiosks\` k ON k.id=m.kiosk_id
       WHERE m.id=? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
      [matchId],
    );
    const row = rows[0];
    return row ? normalizeIds(row, ["id", "tournament_id", "kiosk_id", "player_a_id", "player_b_id", "winner_player_id"]) : null;
  }

  private async listBoardsWith(db: SqlExecutor, tournamentId: string, clubId: string, lock = false): Promise<Record<string, unknown>[]> {
    const rows = await db.query<QueryResultRow>(
      `SELECT k.id,k.code,k.name,k.board_number,k.sponsor_label,k.scoring_mode,k.is_active,
              CASE WHEN tk.id IS NULL THEN 0 ELSE 1 END AS is_assigned_to_tournament,
              (SELECT m2.id FROM \`${this.prefix}matches\` m2 INNER JOIN \`${this.prefix}tournaments\` t2 ON t2.id=m2.tournament_id
                WHERE m2.kiosk_id=k.id AND m2.status IN ('assigned','in_progress') AND t2.club_id=?
                ORDER BY FIELD(m2.status,'in_progress','assigned'),m2.id ASC LIMIT 1) AS busy_match_id,
              (SELECT m3.status FROM \`${this.prefix}matches\` m3 INNER JOIN \`${this.prefix}tournaments\` t3 ON t3.id=m3.tournament_id
                WHERE m3.kiosk_id=k.id AND m3.status IN ('assigned','in_progress') AND t3.club_id=?
                ORDER BY FIELD(m3.status,'in_progress','assigned'),m3.id ASC LIMIT 1) AS busy_match_status
       FROM \`${this.prefix}kiosks\` k
       LEFT JOIN \`${this.prefix}tournament_kiosks\` tk ON tk.kiosk_id=k.id AND tk.tournament_id=?
       WHERE k.club_id=? ORDER BY k.board_number ASC,k.id ASC${lock ? " FOR UPDATE" : ""}`,
      [clubId, clubId, tournamentId, clubId],
    );
    return rows.map((row) => ({
      ...normalizeIds(row, ["id", "busy_match_id"]),
      is_available: row.busy_match_id == null ? 1 : 0,
    }));
  }

  private async listQueueWith(db: SqlExecutor, tournamentId: string, clubId: string): Promise<Record<string, unknown>[]> {
    const rows = await db.query<QueryResultRow>(
      `SELECT m.id,m.kiosk_id,m.round_label,m.bracket_label,m.status,m.best_of_legs,m.legs_to_win,
              m.player_a_id,pa.display_name AS player_a_name,m.player_b_id,pb.display_name AS player_b_name,
              m.winner_player_id,pw.display_name AS winner_name,m.starts_at,m.finished_at,
              k.code AS kiosk_code,k.name AS kiosk_name,k.board_number
       FROM \`${this.prefix}matches\` m
       INNER JOIN \`${this.prefix}players\` pa ON pa.id=m.player_a_id
       INNER JOIN \`${this.prefix}players\` pb ON pb.id=m.player_b_id
       LEFT JOIN \`${this.prefix}players\` pw ON pw.id=m.winner_player_id
       LEFT JOIN \`${this.prefix}kiosks\` k ON k.id=m.kiosk_id
       WHERE m.tournament_id=?
       ORDER BY FIELD(m.status,'in_progress','assigned','pending','completed','cancelled'),m.id ASC`,
      [tournamentId],
    );
    const busyPlayers = await this.busyPlayerIdsWith(db, clubId);
    const checkedRows = await db.query<QueryResultRow>(
      `SELECT player_id FROM \`${this.prefix}tournament_players\` WHERE tournament_id=? AND status='checked_in'`,
      [tournamentId],
    );
    const checked = new Set(checkedRows.map((row) => requiredId(row.player_id, "player_id")));
    return rows.map((row) => {
      const normalized = normalizeIds(row, ["id", "kiosk_id", "player_a_id", "player_b_id", "winner_player_id"]);
      const a = requiredId(normalized.player_a_id, "player_a_id");
      const b = requiredId(normalized.player_b_id, "player_b_id");
      return { ...normalized, players_available: !busyPlayers.has(a) && !busyPlayers.has(b), players_checked_in: checked.has(a) && checked.has(b) };
    });
  }

  private async busyPlayerIdsWith(db: SqlExecutor, clubId: string): Promise<Set<string>> {
    const rows = await db.query<QueryResultRow>(
      `SELECT DISTINCT player_id FROM (
         SELECT m.player_a_id AS player_id FROM \`${this.prefix}matches\` m INNER JOIN \`${this.prefix}tournaments\` t ON t.id=m.tournament_id
          WHERE t.club_id=? AND m.status IN ('assigned','in_progress')
         UNION ALL
         SELECT m.player_b_id AS player_id FROM \`${this.prefix}matches\` m INNER JOIN \`${this.prefix}tournaments\` t ON t.id=m.tournament_id
          WHERE t.club_id=? AND m.status IN ('assigned','in_progress')
       ) busy`,
      [clubId, clubId],
    );
    return new Set(rows.map((row) => requiredId(row.player_id, "player_id")));
  }

  private async assertPlayersRegisteredWith(db: SqlExecutor, tournamentId: string, playerAId: string, playerBId: string): Promise<void> {
    const rows = await db.query<QueryResultRow>(
      `SELECT COUNT(*) AS total FROM \`${this.prefix}tournament_players\`
       WHERE tournament_id=? AND status<>'withdrawn' AND player_id IN (?,?)`,
      [tournamentId, playerAId, playerBId],
    );
    if (Number(rows[0]?.total ?? 0) !== 2) {
      throw new DomainValidationError("players_not_registered_for_tournament", "Both players must be registered in the selected tournament before you can create a match.", 422);
    }
  }

  private async assertPlayersCheckedInWith(db: SqlExecutor, tournamentId: string, playerAId: string, playerBId: string): Promise<void> {
    const rows = await db.query<QueryResultRow>(
      `SELECT COUNT(*) AS total FROM \`${this.prefix}tournament_players\`
       WHERE tournament_id=? AND status='checked_in' AND player_id IN (?,?)`,
      [tournamentId, playerAId, playerBId],
    );
    if (Number(rows[0]?.total ?? 0) !== 2) {
      throw new DomainValidationError("players_not_checked_in_for_tournament", "Both players must be checked in on the arena before the match can be assigned to a board.", 422);
    }
  }

  private async assertKioskCanBeUsedWith(
    db: SqlExecutor,
    tournamentId: string,
    clubId: string,
    kioskId: string,
    excludeMatchId: string | null,
    playerAId: string,
    playerBId: string,
  ): Promise<void> {
    const kioskRows = await db.query<QueryResultRow>(`SELECT id FROM \`${this.prefix}kiosks\` WHERE id=? AND club_id=? LIMIT 1`, [kioskId, clubId]);
    if (kioskRows.length === 0) throw new DomainValidationError("kiosk_not_in_club", "The selected board does not belong to this club.", 422);
    const selected = await db.query<QueryResultRow>(`SELECT id FROM \`${this.prefix}tournament_kiosks\` WHERE tournament_id=? AND kiosk_id=? LIMIT 1`, [tournamentId, kioskId]);
    if (selected.length === 0) throw new DomainValidationError("kiosk_not_assigned_to_tournament", "The selected board is not assigned to this tournament.", 422);

    const busy = await db.query<QueryResultRow>(
      `SELECT m.id FROM \`${this.prefix}matches\` m INNER JOIN \`${this.prefix}tournaments\` t ON t.id=m.tournament_id
       WHERE m.kiosk_id=? AND m.status IN ('assigned','in_progress') AND t.club_id=? AND (? IS NULL OR m.id<>?) LIMIT 1 FOR UPDATE`,
      [kioskId, clubId, excludeMatchId, excludeMatchId],
    );
    if (busy.length > 0) throw new DomainValidationError("kiosk_busy", "The selected board is already running or holding another active match.", 422);

    const playersBusy = await db.query<QueryResultRow>(
      `SELECT m.id FROM \`${this.prefix}matches\` m INNER JOIN \`${this.prefix}tournaments\` t ON t.id=m.tournament_id
       WHERE t.club_id=? AND m.status IN ('assigned','in_progress') AND (? IS NULL OR m.id<>?)
         AND (m.player_a_id IN (?,?) OR m.player_b_id IN (?,?)) LIMIT 1 FOR UPDATE`,
      [clubId, excludeMatchId, excludeMatchId, playerAId, playerBId, playerAId, playerBId],
    );
    if (playersBusy.length > 0) throw new DomainValidationError("players_not_available", "One or both players are already in another assigned or active match.", 422);
  }
}

function requiredId(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new DomainValidationError("invalid_id", `${field} must be a positive decimal id.`, 422);
  return normalized;
}

function optionalId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}

function nullableString(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized === "" ? null : normalized;
}

function positiveIntOrDefault(value: unknown, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeIds(row: QueryResultRow, fields: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = { ...row };
  for (const field of fields) result[field] = optionalId(row[field]);
  return result;
}
