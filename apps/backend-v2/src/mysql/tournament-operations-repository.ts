import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

interface TournamentRow extends QueryResultRow {
  id: unknown;
  club_id: unknown;
  season_id: unknown;
  name: unknown;
  slug: unknown;
  status: unknown;
  start_at: unknown;
  end_at: unknown;
  auto_assign_enabled: unknown;
  club_name: unknown;
  club_slug: unknown;
}

const RESULT_HOLD_SECONDS = 30;

export class MySqlTournamentOperationsRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly prefix: TablePrefix,
  ) {}

  async findTournament(tournamentIdInput: unknown): Promise<Record<string, unknown> | null> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withConnection(async (db) => {
      const tournament = await this.findTournamentWith(db, tournamentId);
      return tournament ? publicTournament(tournament) : null;
    });
  }

  async snapshot(tournamentIdInput: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withConnection((db) => this.snapshotWith(db, tournamentId));
  }

  async updateAutoAssignEnabled(tournamentIdInput: unknown, enabledInput: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    if (typeof enabledInput !== "boolean") {
      throw new DomainValidationError("auto_assign_enabled_required", "auto_assign_enabled is required.");
    }
    return this.sessions.withTransaction(async (db) => {
      await this.requireTournamentWith(db, tournamentId);
      await db.execute(
        `UPDATE \`${this.prefix}tournaments\` SET auto_assign_enabled=? WHERE id=?`,
        [enabledInput ? 1 : 0, tournamentId],
      );
      return this.snapshotWith(db, tournamentId);
    });
  }

  async listBoardSelection(tournamentIdInput: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withConnection((db) => this.listBoardSelectionWith(db, tournamentId));
  }

  async replaceBoardSelection(tournamentIdInput: unknown, rawKioskIds: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    if (!Array.isArray(rawKioskIds)) {
      throw new DomainValidationError("tournament_boards_required", "kiosk_ids must be an array.");
    }
    const kioskIds = [...new Set(rawKioskIds.map((value) => requiredId(value, "kiosk_id")))];
    if (kioskIds.length === 0) {
      throw new DomainValidationError("tournament_board_required", "Velg minst én aktiv skive til turneringen.");
    }

    return this.sessions.withTransaction(async (db) => {
      const tournament = await this.requireTournamentWith(db, tournamentId);
      if (["completed", "archived"].includes(String(tournament.status ?? ""))) {
        throw new DomainValidationError("tournament_boards_locked", "Skiver kan ikke endres etter at turneringen er avsluttet.", 409);
      }
      const clubId = requiredId(tournament.club_id, "club_id");
      const clubBoards = await db.query<QueryResultRow>(
        `SELECT id, board_number, is_active FROM \`${this.prefix}kiosks\` WHERE club_id=? ORDER BY board_number,id`,
        [clubId],
      );
      const boards = new Map(clubBoards.map((row) => [requiredId(row.id, "kiosk_id"), row]));
      for (const kioskId of kioskIds) {
        const board = boards.get(kioskId);
        if (!board || numberValue(board.is_active) !== 1) {
          throw new DomainValidationError(
            "invalid_tournament_board",
            "En valgt skive finnes ikke i klubben eller er deaktivert.",
          );
        }
      }

      const currentRows = await db.query<QueryResultRow>(
        `SELECT kiosk_id FROM \`${this.prefix}tournament_kiosks\` WHERE tournament_id=? ORDER BY sort_order,kiosk_id`,
        [tournamentId],
      );
      const current = currentRows.map((row) => requiredId(row.kiosk_id, "kiosk_id"));
      const removed = current.filter((id) => !kioskIds.includes(id));
      for (const kioskId of removed) {
        const blocked = await db.query<QueryResultRow>(
          `SELECT id FROM \`${this.prefix}matches\`
            WHERE tournament_id=? AND kiosk_id=? AND status IN ('assigned','in_progress') LIMIT 1 FOR UPDATE`,
          [tournamentId, kioskId],
        );
        if (blocked.length > 0) {
          const number = numberValue(boards.get(kioskId)?.board_number);
          throw new DomainValidationError(
            "tournament_board_in_use",
            number > 0 ? `Skive ${number} har en aktiv kamp. Flytt kampen før skiven fjernes.` : "Skiven har en aktiv kamp. Flytt kampen før skiven fjernes.",
            409,
          );
        }
        await db.execute(
          `DELETE FROM \`${this.prefix}tournament_board_reservations\` WHERE tournament_id=? AND kiosk_id=?`,
          [tournamentId, kioskId],
        );
        await db.execute(
          `DELETE FROM \`${this.prefix}tournament_kiosks\` WHERE tournament_id=? AND kiosk_id=?`,
          [tournamentId, kioskId],
        );
      }

      for (let index = 0; index < kioskIds.length; index += 1) {
        await db.execute(
          `INSERT INTO \`${this.prefix}tournament_kiosks\` (tournament_id,kiosk_id,sort_order)
           VALUES (?,?,?) ON DUPLICATE KEY UPDATE sort_order=VALUES(sort_order)`,
          [tournamentId, kioskIds[index]!, index + 1],
        );
      }
      return this.listBoardSelectionWith(db, tournamentId);
    });
  }

  async moveMatch(
    tournamentIdInput: unknown,
    matchIdInput: unknown,
    targetKioskIdInput: unknown,
    confirmInProgress: boolean,
  ): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    const matchId = requiredId(matchIdInput, "match_id");
    const targetKioskId = requiredId(targetKioskIdInput, "kiosk_id");

    return this.sessions.withTransaction(async (db) => {
      const matchRows = await db.query<QueryResultRow>(
        `SELECT m.id,m.tournament_id,m.status,m.kiosk_id,m.player_a_id,m.player_b_id,
                pa.display_name AS player_a_name,pb.display_name AS player_b_name
           FROM \`${this.prefix}matches\` m
           LEFT JOIN \`${this.prefix}players\` pa ON pa.id=m.player_a_id
           LEFT JOIN \`${this.prefix}players\` pb ON pb.id=m.player_b_id
          WHERE m.id=? AND m.tournament_id=? LIMIT 1 FOR UPDATE`,
        [matchId, tournamentId],
      );
      const match = matchRows[0];
      if (!match) throw new DomainValidationError("match_not_found", "Kampen finnes ikke i denne turneringen.", 404);
      const status = String(match.status ?? "");
      if (!["pending", "assigned", "in_progress"].includes(status)) {
        throw new DomainValidationError("match_not_movable", "Bare ventende, oppkalte eller pågående kamper kan flyttes.", 409);
      }
      if (status === "in_progress" && !confirmInProgress) {
        throw new DomainValidationError("match_move_confirmation_required", "Kampen pågår. Bekreft eksplisitt at den skal flyttes.", 409);
      }

      const boardRows = await db.query<QueryResultRow>(
        `SELECT k.id,k.board_number,k.name
           FROM \`${this.prefix}kiosks\` k
           INNER JOIN \`${this.prefix}tournament_kiosks\` tk ON tk.kiosk_id=k.id AND tk.tournament_id=?
           INNER JOIN \`${this.prefix}tournaments\` t ON t.id=tk.tournament_id AND t.club_id=k.club_id
          WHERE k.id=? AND k.is_active=1 LIMIT 1 FOR UPDATE`,
        [tournamentId, targetKioskId],
      );
      const board = boardRows[0];
      if (!board) {
        throw new DomainValidationError("target_board_unavailable", "Målskiven er ikke en aktiv, valgt skive for turneringen.", 409);
      }
      const currentKioskId = nullableId(match.kiosk_id);
      if (currentKioskId === targetKioskId && status !== "pending") {
        return {
          moved: false,
          match_id: publicId(matchId),
          status,
          kiosk_id: publicId(targetKioskId),
          board_number: numberValue(board.board_number),
        };
      }

      const busy = await db.query<QueryResultRow>(
        `SELECT id FROM \`${this.prefix}matches\`
          WHERE kiosk_id=? AND id<>? AND status IN ('assigned','in_progress') LIMIT 1 FOR UPDATE`,
        [targetKioskId, matchId],
      );
      if (busy.length > 0) throw new DomainValidationError("target_board_busy", "Målskiven har allerede en aktiv kamp.", 409);

      const reservations = await db.query<QueryResultRow>(
        `SELECT match_id FROM \`${this.prefix}tournament_board_reservations\` WHERE kiosk_id=? LIMIT 1 FOR UPDATE`,
        [targetKioskId],
      );
      const reservedMatchId = nullableId(reservations[0]?.match_id);
      if (reservedMatchId !== null && reservedMatchId !== matchId) {
        throw new DomainValidationError("target_board_reserved", "Målskiven er reservert for en annen kamp.", 409);
      }

      await db.execute(
        `DELETE FROM \`${this.prefix}tournament_board_reservations\`
          WHERE tournament_id=? AND (match_id=? OR kiosk_id=?)`,
        [tournamentId, matchId, targetKioskId],
      );
      if (status === "pending") {
        await db.execute(
          `UPDATE \`${this.prefix}matches\` SET kiosk_id=?,status='assigned',updated_at=NOW() WHERE id=? AND tournament_id=?`,
          [targetKioskId, matchId, tournamentId],
        );
      } else {
        await db.execute(
          `UPDATE \`${this.prefix}matches\` SET kiosk_id=?,updated_at=NOW() WHERE id=? AND tournament_id=?`,
          [targetKioskId, matchId, tournamentId],
        );
      }

      const affectedKiosks = [...new Set([currentKioskId, targetKioskId].filter((value): value is string => value !== null))];
      for (const kioskId of affectedKiosks) {
        await db.execute(`DELETE FROM \`${this.prefix}scolia_visit_buffers\` WHERE kiosk_id=?`, [kioskId]);
        await db.execute(
          `INSERT INTO \`${this.prefix}scolia_board_runtime\` (kiosk_id,turn_locked_until_takeout) VALUES (?,0)
           ON DUPLICATE KEY UPDATE turn_locked_until_takeout=0`,
          [kioskId],
        );
      }

      return {
        moved: true,
        match_id: publicId(matchId),
        status: status === "pending" ? "assigned" : status,
        from_kiosk_id: currentKioskId === null ? null : publicId(currentKioskId),
        kiosk_id: publicId(targetKioskId),
        board_number: numberValue(board.board_number),
        player_a_name: String(match.player_a_name ?? ""),
        player_b_name: String(match.player_b_name ?? ""),
      };
    });
  }

  async reconcileTournament(tournamentIdInput: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    const assignment = await this.sessions.withTransaction(async (db) => {
      const tournamentRows = await db.query<QueryResultRow>(
        `SELECT id,club_id,status,auto_assign_enabled FROM \`${this.prefix}tournaments\` WHERE id=? LIMIT 1 FOR UPDATE`,
        [tournamentId],
      );
      const tournament = tournamentRows[0];
      if (!tournament) throw new DomainValidationError("tournament_not_found", "Tournament was not found.", 404);
      if (numberValue(tournament.auto_assign_enabled) !== 1) return { assigned_count: 0, items: [] as Record<string, unknown>[] };

      let selection = await this.listBoardSelectionWith(db, tournamentId);
      if (selection.selection_initialized !== true) {
        const defaults = (selection.boards as Record<string, unknown>[])
          .filter((board) => board.selected === true)
          .map((board) => requiredId(board.id, "kiosk_id"));
        if (defaults.length > 0) {
          for (let index = 0; index < defaults.length; index += 1) {
            await db.execute(
              `INSERT INTO \`${this.prefix}tournament_kiosks\` (tournament_id,kiosk_id,sort_order) VALUES (?,?,?)
               ON DUPLICATE KEY UPDATE sort_order=VALUES(sort_order)`,
              [tournamentId, defaults[index]!, index + 1],
            );
          }
          selection = await this.listBoardSelectionWith(db, tournamentId);
        }
      }

      const clubId = requiredId(tournament.club_id, "club_id");
      const items: Record<string, unknown>[] = [];
      for (const board of selection.boards as Record<string, unknown>[]) {
        if (board.selected !== true || board.is_active !== true || board.is_busy === true || board.is_reserved === true) continue;
        const kioskId = requiredId(board.id, "kiosk_id");
        const candidate = await this.bestCandidateWith(db, tournamentId, clubId);
        if (!candidate) break;
        const matchId = requiredId(candidate.id, "match_id");
        const update = await db.execute(
          `UPDATE \`${this.prefix}matches\` SET kiosk_id=?,status='assigned',starts_at=NULL,finished_at=NULL
            WHERE id=? AND tournament_id=? AND status='pending' AND kiosk_id IS NULL`,
          [kioskId, matchId, tournamentId],
        );
        if (update.affectedRows !== 1) {
          throw new DomainValidationError("match_assignment_conflict", "Kampen kunne ikke tildeles skiven uten konflikt.", 409);
        }
        items.push({
          match_id: publicId(matchId),
          kiosk_id: publicId(kioskId),
          board_number: numberValue(board.board_number),
          players: `${String(candidate.player_a_name ?? "")} vs ${String(candidate.player_b_name ?? "")}`,
        });
      }
      await this.updateLifecycleWith(db, tournamentId);
      return { assigned_count: items.length, items };
    });

    const snapshot = await this.snapshot(tournamentId);
    snapshot.assignment = assignment;
    return snapshot;
  }

  private async snapshotWith(db: SqlExecutor, tournamentId: string): Promise<Record<string, unknown>> {
    const tournament = await this.requireTournamentWith(db, tournamentId);
    const clubId = requiredId(tournament.club_id, "club_id");
    const busyPlayers = await this.busyPlayerIdsWith(db, clubId);
    const reservations = await this.reservationsForTournamentWith(db, tournamentId);
    const reservedPlayers = new Set<string>();
    const reservationsByKiosk = new Map<string, Record<string, unknown>>();
    const reservationsByMatch = new Map<string, Record<string, unknown>>();
    for (const reservation of reservations) {
      const kioskId = requiredId(reservation.kiosk_id, "kiosk_id");
      const matchId = requiredId(reservation.match_id, "match_id");
      const formatted = formatReservation(reservation);
      reservationsByKiosk.set(kioskId, formatted);
      reservationsByMatch.set(matchId, formatted);
      const a = nullableId(reservation.player_a_id); if (a) reservedPlayers.add(a);
      const b = nullableId(reservation.player_b_id); if (b) reservedPlayers.add(b);
    }

    const boardRows = await db.query<QueryResultRow>(
      `SELECT k.id,k.code,k.name,k.board_number,k.scoring_mode,k.is_active,
              m.id AS active_match_id,m.status AS active_match_status,m.player_a_id,pa.display_name AS player_a_name,
              m.player_b_id,pb.display_name AS player_b_name,m.round_label,m.bracket_label
         FROM \`${this.prefix}tournament_kiosks\` tk
         INNER JOIN \`${this.prefix}kiosks\` k ON k.id=tk.kiosk_id
         LEFT JOIN \`${this.prefix}matches\` m ON m.id=(
           SELECT m2.id FROM \`${this.prefix}matches\` m2
           INNER JOIN \`${this.prefix}tournaments\` t2 ON t2.id=m2.tournament_id
           WHERE m2.kiosk_id=k.id AND t2.club_id=? AND m2.status IN ('assigned','in_progress')
           ORDER BY FIELD(m2.status,'in_progress','assigned'),m2.id ASC LIMIT 1)
         LEFT JOIN \`${this.prefix}players\` pa ON pa.id=m.player_a_id
         LEFT JOIN \`${this.prefix}players\` pb ON pb.id=m.player_b_id
        WHERE tk.tournament_id=? ORDER BY tk.sort_order,k.board_number,k.id`,
      [clubId, tournamentId],
    );
    const boards = boardRows.map((row) => {
      const id = requiredId(row.id, "kiosk_id");
      const reservation = reservationsByKiosk.get(id) ?? null;
      return {
        ...publicIds(row, ["id", "active_match_id", "player_a_id", "player_b_id"]),
        board_number: numberValue(row.board_number),
        is_active: numberValue(row.is_active),
        reservation,
        reserved_match_id: reservation?.match_id ?? null,
      };
    });

    const queueRows = await db.query<QueryResultRow>(
      `SELECT m.id,m.tournament_id,m.tournament_group_id,g.name AS group_name,g.sort_order AS group_sort_order,
              m.round_label,m.round_number,m.bracket_label,m.status,m.best_of_legs,
              m.player_a_id,pa.display_name AS player_a_name,tpa.status AS player_a_registration_status,
              m.player_b_id,pb.display_name AS player_b_name,tpb.status AS player_b_registration_status,
              m.kiosk_id,k.board_number
         FROM \`${this.prefix}matches\` m
         INNER JOIN \`${this.prefix}players\` pa ON pa.id=m.player_a_id
         INNER JOIN \`${this.prefix}players\` pb ON pb.id=m.player_b_id
         LEFT JOIN \`${this.prefix}tournament_groups\` g ON g.id=m.tournament_group_id
         LEFT JOIN \`${this.prefix}tournament_players\` tpa ON tpa.tournament_id=m.tournament_id AND tpa.player_id=m.player_a_id
         LEFT JOIN \`${this.prefix}tournament_players\` tpb ON tpb.tournament_id=m.tournament_id AND tpb.player_id=m.player_b_id
         LEFT JOIN \`${this.prefix}kiosks\` k ON k.id=m.kiosk_id
        WHERE m.tournament_id=? AND m.status IN ('pending','assigned','in_progress')
        ORDER BY FIELD(m.status,'in_progress','assigned','pending'),COALESCE(m.round_number,9999),COALESCE(g.sort_order,9999),m.id`,
      [tournamentId],
    );
    let ready = 0;
    let blocked = 0;
    const queue = queueRows.map((row) => {
      const id = requiredId(row.id, "match_id");
      const a = requiredId(row.player_a_id, "player_a_id");
      const b = requiredId(row.player_b_id, "player_b_id");
      const checkedIn = row.player_a_registration_status === "checked_in" && row.player_b_registration_status === "checked_in";
      const available = !busyPlayers.has(a) && !busyPlayers.has(b) && !reservedPlayers.has(a) && !reservedPlayers.has(b);
      const reservation = reservationsByMatch.get(id) ?? null;
      if (row.status === "pending" && reservation === null) {
        if (checkedIn && available) ready += 1; else blocked += 1;
      }
      return {
        ...publicIds(row, ["id", "tournament_id", "tournament_group_id", "player_a_id", "player_b_id", "kiosk_id"]),
        round_number: nullableNumber(row.round_number),
        best_of_legs: numberValue(row.best_of_legs),
        board_number: nullableNumber(row.board_number),
        players_checked_in: checkedIn,
        players_available: available,
        reservation,
      };
    });

    const countRows = await db.query<QueryResultRow>(
      `SELECT status,COUNT(*) AS c FROM \`${this.prefix}matches\` WHERE tournament_id=? GROUP BY status`,
      [tournamentId],
    );
    const counts: Record<string, number> = { pending: 0, assigned: 0, in_progress: 0, completed: 0, cancelled: 0 };
    for (const row of countRows) counts[String(row.status ?? "")] = numberValue(row.c);
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

    const recentRows = await db.query<QueryResultRow>(
      `SELECT m.id,m.round_label,m.bracket_label,m.finished_at,pa.display_name AS player_a_name,
              pb.display_name AS player_b_name,pw.display_name AS winner_name,k.board_number,
              SUM(CASE WHEN l.winner_player_id=m.player_a_id THEN 1 ELSE 0 END) AS legs_a,
              SUM(CASE WHEN l.winner_player_id=m.player_b_id THEN 1 ELSE 0 END) AS legs_b
         FROM \`${this.prefix}matches\` m
         INNER JOIN \`${this.prefix}players\` pa ON pa.id=m.player_a_id
         INNER JOIN \`${this.prefix}players\` pb ON pb.id=m.player_b_id
         LEFT JOIN \`${this.prefix}players\` pw ON pw.id=m.winner_player_id
         LEFT JOIN \`${this.prefix}kiosks\` k ON k.id=m.kiosk_id
         LEFT JOIN \`${this.prefix}legs\` l ON l.match_id=m.id AND l.status='completed'
        WHERE m.tournament_id=? AND m.status='completed'
        GROUP BY m.id,m.round_label,m.bracket_label,m.finished_at,pa.display_name,pb.display_name,pw.display_name,k.board_number
        ORDER BY m.finished_at DESC,m.id DESC LIMIT 8`,
      [tournamentId],
    );

    return {
      tournament: publicTournament(tournament),
      progress: {
        total,
        completed: counts.completed ?? 0,
        pending: counts.pending ?? 0,
        assigned: counts.assigned ?? 0,
        in_progress: counts.in_progress ?? 0,
        cancelled: counts.cancelled ?? 0,
        percent: total > 0 ? Math.round(((counts.completed ?? 0) / total) * 1000) / 10 : 0,
      },
      queue: { ready_count: ready, blocked_count: blocked, items: queue },
      boards,
      recent_results: recentRows.map((row) => ({
        ...publicIds(row, ["id"]),
        board_number: nullableNumber(row.board_number),
        legs_a: numberValue(row.legs_a),
        legs_b: numberValue(row.legs_b),
      })),
      reservations: [...reservationsByKiosk.values()],
      updated_at: new Date().toISOString(),
    };
  }

  private async listBoardSelectionWith(db: SqlExecutor, tournamentId: string): Promise<Record<string, unknown>> {
    const tournament = await this.requireTournamentWith(db, tournamentId);
    const clubId = requiredId(tournament.club_id, "club_id");
    const selectedRows = await db.query<QueryResultRow>(
      `SELECT kiosk_id FROM \`${this.prefix}tournament_kiosks\` WHERE tournament_id=? ORDER BY sort_order,kiosk_id`,
      [tournamentId],
    );
    const selected = new Set(selectedRows.map((row) => requiredId(row.kiosk_id, "kiosk_id")));
    const initialized = selected.size > 0;
    const rows = await db.query<QueryResultRow>(
      `SELECT k.id,k.code,k.name,k.board_number,k.scoring_mode,k.is_active,
              EXISTS(SELECT 1 FROM \`${this.prefix}matches\` m WHERE m.kiosk_id=k.id AND m.status IN ('assigned','in_progress')) AS is_busy,
              EXISTS(SELECT 1 FROM \`${this.prefix}tournament_board_reservations\` r WHERE r.kiosk_id=k.id) AS is_reserved
         FROM \`${this.prefix}kiosks\` k WHERE k.club_id=? ORDER BY k.board_number,k.id`,
      [clubId],
    );
    const boards = rows.map((row) => {
      const id = requiredId(row.id, "kiosk_id");
      const active = numberValue(row.is_active) === 1;
      const busy = numberValue(row.is_busy) === 1;
      const reserved = numberValue(row.is_reserved) === 1;
      return {
        ...row,
        id: publicId(id),
        board_number: numberValue(row.board_number),
        is_active: active,
        is_busy: busy,
        is_reserved: reserved,
        selected: initialized ? selected.has(id) : active,
        can_remove: !busy && !reserved,
      };
    });
    return {
      tournament_id: publicId(tournamentId),
      tournament_status: String(tournament.status ?? ""),
      selection_initialized: initialized,
      boards,
      selected_count: boards.filter((board) => board.selected).length,
    };
  }

  private async bestCandidateWith(db: SqlExecutor, tournamentId: string, clubId: string): Promise<QueryResultRow | null> {
    const busyPlayers = await this.busyPlayerIdsWith(db, clubId);
    const progressRows = await db.query<QueryResultRow>(
      `SELECT m.tournament_group_id,
              SUM(CASE WHEN m.status IN ('assigned','in_progress','completed') OR r.id IS NOT NULL THEN 1 ELSE 0 END) AS dispatched_count,
              COUNT(*) AS total_count
         FROM \`${this.prefix}matches\` m
         LEFT JOIN \`${this.prefix}tournament_board_reservations\` r ON r.match_id=m.id
        WHERE m.tournament_id=? AND m.tournament_group_id IS NOT NULL GROUP BY m.tournament_group_id`,
      [tournamentId],
    );
    const progress = new Map(progressRows.map((row) => {
      const id = requiredId(row.tournament_group_id, "group_id");
      return [id, numberValue(row.dispatched_count) / Math.max(1, numberValue(row.total_count))] as const;
    }));
    const activityRows = await db.query<QueryResultRow>(
      `SELECT player_id,UNIX_TIMESTAMP(MAX(finished_at)) AS last_finished FROM (
         SELECT player_a_id AS player_id,finished_at FROM \`${this.prefix}matches\` WHERE tournament_id=? AND status='completed' AND finished_at IS NOT NULL
         UNION ALL
         SELECT player_b_id AS player_id,finished_at FROM \`${this.prefix}matches\` WHERE tournament_id=? AND status='completed' AND finished_at IS NOT NULL
       ) played GROUP BY player_id`,
      [tournamentId, tournamentId],
    );
    const lastFinished = new Map(activityRows.map((row) => [requiredId(row.player_id, "player_id"), numberValue(row.last_finished)]));
    const rows = await db.query<QueryResultRow>(
      `SELECT m.id,m.tournament_id,m.tournament_group_id,m.round_number,m.round_label,m.bracket_label,
              m.player_a_id,pa.display_name AS player_a_name,m.player_b_id,pb.display_name AS player_b_name,
              g.sort_order AS group_sort_order
         FROM \`${this.prefix}matches\` m
         INNER JOIN \`${this.prefix}players\` pa ON pa.id=m.player_a_id
         INNER JOIN \`${this.prefix}players\` pb ON pb.id=m.player_b_id
         LEFT JOIN \`${this.prefix}tournament_groups\` g ON g.id=m.tournament_group_id
         LEFT JOIN \`${this.prefix}tournament_players\` tpa ON tpa.tournament_id=m.tournament_id AND tpa.player_id=m.player_a_id
         LEFT JOIN \`${this.prefix}tournament_players\` tpb ON tpb.tournament_id=m.tournament_id AND tpb.player_id=m.player_b_id
         LEFT JOIN \`${this.prefix}tournament_board_reservations\` r ON r.match_id=m.id
        WHERE m.tournament_id=? AND m.status='pending' AND m.kiosk_id IS NULL AND r.id IS NULL
          AND tpa.status='checked_in' AND tpb.status='checked_in' ORDER BY m.id`,
      [tournamentId],
    );
    const nowSeconds = Math.floor(Date.now() / 1000);
    const eligible = rows.filter((row) => {
      const a = requiredId(row.player_a_id, "player_a_id");
      const b = requiredId(row.player_b_id, "player_b_id");
      return !busyPlayers.has(a) && !busyPlayers.has(b);
    }).map((row) => {
      const a = requiredId(row.player_a_id, "player_a_id");
      const b = requiredId(row.player_b_id, "player_b_id");
      const last = Math.max(lastFinished.get(a) ?? 0, lastFinished.get(b) ?? 0);
      const groupId = nullableId(row.tournament_group_id);
      return {
        row,
        recentPenalty: last > 0 && nowSeconds - last < 90 ? 1 : 0,
        groupProgress: groupId ? (progress.get(groupId) ?? 0) : 0,
        lastActivity: last,
        round: nullableNumber(row.round_number) ?? 9999,
        groupSort: nullableNumber(row.group_sort_order) ?? 9999,
        id: BigInt(requiredId(row.id, "match_id")),
      };
    });
    eligible.sort((a, b) =>
      a.recentPenalty - b.recentPenalty ||
      a.groupProgress - b.groupProgress ||
      a.lastActivity - b.lastActivity ||
      a.round - b.round ||
      a.groupSort - b.groupSort ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return eligible[0]?.row ?? null;
  }

  private async busyPlayerIdsWith(db: SqlExecutor, clubId: string): Promise<Set<string>> {
    const rows = await db.query<QueryResultRow>(
      `SELECT DISTINCT player_id FROM (
         SELECT m.player_a_id AS player_id FROM \`${this.prefix}matches\` m INNER JOIN \`${this.prefix}tournaments\` t ON t.id=m.tournament_id
          WHERE t.club_id=? AND m.status IN ('assigned','in_progress')
         UNION ALL
         SELECT m.player_b_id AS player_id FROM \`${this.prefix}matches\` m INNER JOIN \`${this.prefix}tournaments\` t ON t.id=m.tournament_id
          WHERE t.club_id=? AND m.status IN ('assigned','in_progress')
         UNION ALL
         SELECT m.player_a_id AS player_id FROM \`${this.prefix}tournament_board_reservations\` r INNER JOIN \`${this.prefix}matches\` m ON m.id=r.match_id
          INNER JOIN \`${this.prefix}tournaments\` t ON t.id=r.tournament_id WHERE t.club_id=?
         UNION ALL
         SELECT m.player_b_id AS player_id FROM \`${this.prefix}tournament_board_reservations\` r INNER JOIN \`${this.prefix}matches\` m ON m.id=r.match_id
          INNER JOIN \`${this.prefix}tournaments\` t ON t.id=r.tournament_id WHERE t.club_id=?
       ) busy`,
      [clubId, clubId, clubId, clubId],
    );
    return new Set(rows.map((row) => requiredId(row.player_id, "player_id")));
  }

  private async reservationsForTournamentWith(db: SqlExecutor, tournamentId: string): Promise<readonly QueryResultRow[]> {
    return db.query<QueryResultRow>(
      `SELECT r.id,r.tournament_id,r.kiosk_id,r.match_id,r.reserved_at,r.activates_at,
              GREATEST(0,TIMESTAMPDIFF(SECOND,NOW(),r.activates_at)) AS remaining_seconds,
              k.board_number,m.player_a_id,pa.display_name AS player_a_name,m.player_b_id,pb.display_name AS player_b_name
         FROM \`${this.prefix}tournament_board_reservations\` r
         INNER JOIN \`${this.prefix}kiosks\` k ON k.id=r.kiosk_id
         INNER JOIN \`${this.prefix}matches\` m ON m.id=r.match_id
         LEFT JOIN \`${this.prefix}players\` pa ON pa.id=m.player_a_id
         LEFT JOIN \`${this.prefix}players\` pb ON pb.id=m.player_b_id
        WHERE r.tournament_id=? ORDER BY k.board_number,r.id`,
      [tournamentId],
    );
  }

  private async updateLifecycleWith(db: SqlExecutor, tournamentId: string): Promise<void> {
    const rows = await db.query<QueryResultRow>(
      `SELECT status,COUNT(*) AS c FROM \`${this.prefix}matches\` WHERE tournament_id=? GROUP BY status`,
      [tournamentId],
    );
    const counts = new Map(rows.map((row) => [String(row.status ?? ""), numberValue(row.c)]));
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    const open = (counts.get("pending") ?? 0) + (counts.get("assigned") ?? 0) + (counts.get("in_progress") ?? 0);
    if (total > 0 && open === 0) {
      await db.execute(
        `UPDATE \`${this.prefix}tournaments\` SET status='completed',end_at=COALESCE(end_at,NOW()) WHERE id=? AND status<>'archived'`,
        [tournamentId],
      );
    } else if (total > 0 && ((counts.get("assigned") ?? 0) + (counts.get("in_progress") ?? 0) + (counts.get("completed") ?? 0)) > 0) {
      await db.execute(
        `UPDATE \`${this.prefix}tournaments\` SET status='in_progress' WHERE id=? AND status IN ('draft','ready')`,
        [tournamentId],
      );
    }
  }

  private async findTournamentWith(db: SqlExecutor, tournamentId: string): Promise<TournamentRow | null> {
    const rows = await db.query<TournamentRow>(
      `SELECT t.id,t.club_id,t.season_id,t.name,t.slug,t.status,t.start_at,t.end_at,t.auto_assign_enabled,
              c.name AS club_name,c.slug AS club_slug
         FROM \`${this.prefix}tournaments\` t INNER JOIN \`${this.prefix}clubs\` c ON c.id=t.club_id
        WHERE t.id=? LIMIT 1`,
      [tournamentId],
    );
    return rows[0] ?? null;
  }

  private async requireTournamentWith(db: SqlExecutor, tournamentId: string): Promise<TournamentRow> {
    const tournament = await this.findTournamentWith(db, tournamentId);
    if (!tournament) throw new DomainValidationError("tournament_not_found", "Tournament was not found.", 404);
    return tournament;
  }
}

function requiredId(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new DomainValidationError(`invalid_${field}`, `${field} must be a positive decimal id.`);
  return normalized;
}

function nullableId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}

function publicId(value: string): string | number {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : value;
}

function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function publicTournament(row: QueryResultRow): Record<string, unknown> {
  return {
    ...row,
    id: publicId(requiredId(row.id, "tournament_id")),
    club_id: publicId(requiredId(row.club_id, "club_id")),
    season_id: nullableId(row.season_id) ? publicId(nullableId(row.season_id)!) : null,
    auto_assign_enabled: numberValue(row.auto_assign_enabled) === 1,
  };
}

function publicIds(row: QueryResultRow, fields: readonly string[]): Record<string, unknown> {
  const output: Record<string, unknown> = { ...row };
  for (const field of fields) {
    const value = nullableId(row[field]);
    output[field] = value === null ? null : publicId(value);
  }
  return output;
}

function formatReservation(row: QueryResultRow): Record<string, unknown> {
  return {
    ...publicIds(row, ["id", "tournament_id", "kiosk_id", "match_id", "player_a_id", "player_b_id"]),
    board_number: numberValue(row.board_number),
    remaining_seconds: Math.max(0, numberValue(row.remaining_seconds)),
    result_display_seconds: RESULT_HOLD_SECONDS,
  };
}
