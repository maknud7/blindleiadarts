import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, TablePrefix } from "./contracts.js";
import { MySqlClubPlayerReadRepository } from "./club-player-read-repository.js";
import { MySqlTournamentOperationsRepository } from "./tournament-operations-repository.js";
import { MySqlTournamentPlayoffRepository } from "./tournament-playoff-repository.js";
import { MySqlTournamentPublicReadRepository } from "./tournament-public-read-repository.js";

/**
 * Public spectator reads. Every method in this repository is deliberately
 * side-effect free: no screen heartbeat, check-in code generation, snapshot
 * repair or tournament lifecycle mutation is allowed from a GET route.
 */
export class MySqlPublicLiveReadRepository {
  private readonly operations: MySqlTournamentOperationsRepository;
  private readonly publicReads: MySqlTournamentPublicReadRepository;
  private readonly playoffs: MySqlTournamentPlayoffRepository;
  private readonly clubPlayers: MySqlClubPlayerReadRepository;

  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly prefix: TablePrefix,
  ) {
    this.operations = new MySqlTournamentOperationsRepository(sessions, prefix);
    this.publicReads = new MySqlTournamentPublicReadRepository(sessions, prefix);
    this.playoffs = new MySqlTournamentPlayoffRepository(sessions, prefix);
    this.clubPlayers = new MySqlClubPlayerReadRepository(sessions, prefix);
  }

  async liveByClubSlug(clubSlugInput: unknown): Promise<Record<string, unknown> | null> {
    const clubSlug = String(clubSlugInput ?? "").trim();
    if (clubSlug === "") return null;
    const tournamentId = await this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT t.id
           FROM \`${this.prefix}tournaments\` t
           INNER JOIN \`${this.prefix}clubs\` c ON c.id=t.club_id
          WHERE c.slug=? AND t.status IN ('in_progress','ready','completed')
          ORDER BY FIELD(t.status,'in_progress','ready','completed'),
                   CASE WHEN t.status='completed' THEN COALESCE(t.end_at,t.start_at) END DESC,
                   CASE WHEN t.status<>'completed' THEN COALESCE(t.start_at,'2999-12-31 23:59:59') END ASC,
                   t.id DESC
          LIMIT 1`,
        [clubSlug],
      );
      return decimalId(rows[0]?.id);
    });
    return tournamentId === null ? null : this.liveByTournamentId(tournamentId);
  }

  async liveByTournamentId(tournamentIdInput: unknown): Promise<Record<string, unknown> | null> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    const tournament = await this.operations.findTournament(tournamentId);
    if (tournament === null) return null;

    const ops = await this.operations.snapshot(tournamentId);
    const rawBoards = Array.isArray(ops.boards) ? ops.boards as Record<string, unknown>[] : [];
    const boards: Record<string, unknown>[] = [];
    for (const rawBoard of rawBoards) {
      const board: Record<string, unknown> = { ...rawBoard };
      const activeMatchId = decimalId(board.active_match_id);
      board.live_match = activeMatchId === null ? null : await this.liveMatch(activeMatchId);
      boards.push(board);
    }

    const queue = asRecord(ops.queue);
    const queueItems = Array.isArray(queue?.items) ? queue.items as Record<string, unknown>[] : [];
    const nextMatches = queueItems.filter((match) => String(match.status ?? "") === "pending").slice(0, 10);
    const clubId = requiredId(tournament.club_id, "club_id");
    const currentElo = await this.clubPlayers.listEloTable(clubId);
    const eloRows = await this.decorateEloRowsReadOnly(
      tournamentId,
      currentElo,
      String(tournament.status ?? "") === "completed",
    );

    const tables = await this.publicReads.tournamentTables(tournamentId);
    const playoff = await this.playoffWithScores(tournamentId);

    return {
      club: {
        id: tournament.club_id,
        name: tournament.club_name ?? null,
        slug: tournament.club_slug ?? null,
      },
      tournament,
      progress: ops.progress ?? {},
      boards,
      next_matches: nextMatches,
      recent_results: Array.isArray(ops.recent_results) ? ops.recent_results : [],
      qualifiers_per_group: await this.qualifiersPerGroup(tournamentId),
      tables: tables ?? { tournament, groups: [] },
      playoff,
      elo: eloRows,
      highlights: await this.highlights(tournamentId),
      updated_at: new Date().toISOString(),
    };
  }

  async publicCheckinDisplay(input: {
    readonly screenToken?: unknown;
    readonly clubSlug?: unknown;
  }): Promise<Record<string, unknown>> {
    const screenToken = String(input.screenToken ?? "").trim();
    const clubSlug = String(input.clubSlug ?? "").trim();
    let clubId: string;

    if (screenToken !== "") {
      const resolved = await this.sessions.withConnection(async (db) => {
        const rows = await db.query<QueryResultRow>(
          `SELECT club_id FROM \`${this.prefix}screen_devices\`
            WHERE access_token=? AND is_active=1 LIMIT 1`,
          [screenToken],
        );
        return decimalId(rows[0]?.club_id);
      });
      if (resolved === null) {
        throw new DomainValidationError("screen_token_invalid", "Skjermtoken er ugyldig.", 401);
      }
      clubId = resolved;
    } else if (clubSlug !== "") {
      const resolved = await this.sessions.withConnection(async (db) => {
        const rows = await db.query<QueryResultRow>(
          `SELECT id FROM \`${this.prefix}clubs\` WHERE slug=? LIMIT 1`,
          [clubSlug],
        );
        return decimalId(rows[0]?.id);
      });
      if (resolved === null) {
        throw new DomainValidationError("club_not_found", "Klubben ble ikke funnet.", 404);
      }
      clubId = resolved;
    } else {
      throw new DomainValidationError(
        "checkin_display_context_required",
        "Oppgi skjermtoken eller klubb.",
        422,
      );
    }

    const display = await this.publicDisplayForClub(clubId);
    return { active: display !== null, checkin: display };
  }

  private async publicDisplayForClub(clubId: string): Promise<Record<string, unknown> | null> {
    const candidates = await this.sessions.withConnection((db) => db.query<QueryResultRow>(
      `SELECT t.id,t.name,t.start_at,t.checkin_code,
              COALESCE(t.checkin_method,ccs.default_method,'admin_or_code') AS effective_method,
              COALESCE(
                t.checkin_opens_at,
                DATE_SUB(t.start_at, INTERVAL COALESCE(ccs.opens_minutes_before_start,60) MINUTE)
              ) AS effective_checkin_opens_at
         FROM \`${this.prefix}tournaments\` t
         LEFT JOIN \`${this.prefix}club_checkin_settings\` ccs ON ccs.club_id=t.club_id
        WHERE t.club_id=? AND t.status='draft' AND t.start_at IS NOT NULL
          AND t.start_at BETWEEN DATE_SUB(NOW(), INTERVAL 8 HOUR) AND DATE_ADD(NOW(), INTERVAL 24 HOUR)
          AND NOW(3) >= COALESCE(
            t.checkin_opens_at,
            DATE_SUB(t.start_at, INTERVAL COALESCE(ccs.opens_minutes_before_start,60) MINUTE)
          )
        ORDER BY ABS(TIMESTAMPDIFF(SECOND,NOW(),t.start_at)),t.id ASC`,
      [clubId],
    ));

    for (const candidate of candidates) {
      const tournamentId = decimalId(candidate.id);
      if (tournamentId === null) continue;
      const method = normalizeCheckinMethod(candidate.effective_method);
      if (!methodUsesCode(method)) continue;
      const code = normalizePersistedCode(candidate.checkin_code);
      // Missing code must be fixed by an explicit mutation. Public polling must
      // never generate or persist a code as a read-side self-heal.
      if (code === null) continue;

      const participants = await this.sessions.withConnection(async (db) => {
        const rows = await db.query<QueryResultRow>(
          `SELECT p.id AS player_id,p.display_name,tp.status,tp.checked_in_at
             FROM \`${this.prefix}tournament_players\` tp
             INNER JOIN \`${this.prefix}players\` p ON p.id=tp.player_id
            WHERE tp.tournament_id=? AND tp.status IN ('checked_in','registered','waitlisted')
            ORDER BY FIELD(tp.status,'checked_in','registered','waitlisted'),p.display_name ASC`,
          [tournamentId],
        );
        return rows.map((row) => ({
          player_id: requiredId(row.player_id, "player_id"),
          display_name: String(row.display_name ?? ""),
          status: String(row.status ?? ""),
          checked_in_at: row.checked_in_at ?? null,
        }));
      });

      let checkedIn = 0;
      let registered = 0;
      let waitlisted = 0;
      for (const participant of participants) {
        if (participant.status === "checked_in") checkedIn += 1;
        else if (participant.status === "registered") registered += 1;
        else if (participant.status === "waitlisted") waitlisted += 1;
      }

      return {
        tournament_id: tournamentId,
        tournament_name: String(candidate.name ?? ""),
        start_at: candidate.start_at ?? null,
        code,
        opens_at: candidate.effective_checkin_opens_at ?? null,
        closes_at: null,
        method,
        participants,
        participant_count: checkedIn + registered,
        checked_in_count: checkedIn,
        registered_count: registered,
        waitlisted_count: waitlisted,
      };
    }

    return null;
  }

  private async decorateEloRowsReadOnly(
    tournamentId: string,
    rows: Record<string, unknown>[],
    completed: boolean,
  ): Promise<Record<string, unknown>[]> {
    const snapshots = await this.sessions.withConnection((db) => db.query<QueryResultRow>(
      `SELECT s.player_id,s.elo_before,s.elo_after,s.rank_before,s.rank_after,s.rank_baseline_kind,p.display_name
         FROM \`${this.prefix}tournament_elo_snapshots\` s
         INNER JOIN \`${this.prefix}players\` p ON p.id=s.player_id
        WHERE s.tournament_id=? ORDER BY p.display_name ASC,p.id ASC`,
      [tournamentId],
    ));
    if (snapshots.length === 0) return rows;

    const participants = new Set(await this.sessions.withConnection(async (db) => {
      const participantRows = await db.query<QueryResultRow>(
        `SELECT player_id FROM \`${this.prefix}tournament_players\`
          WHERE tournament_id=? AND status NOT IN ('withdrawn','no_show')`,
        [tournamentId],
      );
      return participantRows.map((row) => decimalId(row.player_id)).filter((id): id is string => id !== null);
    }));

    const byPlayer = new Map<string, QueryResultRow>();
    const byName = new Map<string, QueryResultRow | null>();
    for (const snapshot of snapshots) {
      const playerId = decimalId(snapshot.player_id);
      if (playerId !== null) byPlayer.set(playerId, snapshot);
      const key = nameKey(snapshot.display_name);
      if (key === "") continue;
      byName.set(key, byName.has(key) ? null : snapshot);
    }

    const decorated: Record<string, unknown>[] = rows.map((raw): Record<string, unknown> => {
      const row: Record<string, unknown> = { ...raw };
      const playerId = decimalId(row.id);
      const snapshot = (playerId === null ? null : byPlayer.get(playerId)) ?? byName.get(nameKey(row.display_name)) ?? null;
      if (snapshot === null) {
        return {
          ...row,
          tournament_elo_before: null,
          tournament_elo_after: null,
          tournament_elo_delta: null,
          tournament_elo_participant: false,
          tournament_rank_before: null,
          tournament_rank_after: null,
          tournament_rank_delta: null,
          tournament_rank_baseline_kind: null,
          tournament_rank_is_new: false,
        };
      }

      const snapshotPlayerId = requiredId(snapshot.player_id, "snapshot_player_id");
      const before = numberValue(snapshot.elo_before, 1000);
      const after = nullableNumber(snapshot.elo_after);
      const rating = completed && after !== null ? after : numberValue(row.elo_rating, before);
      const participant = participants.has(snapshotPlayerId);
      return {
        ...row,
        elo_rating: rating,
        tournament_elo_before: before,
        tournament_elo_after: after,
        tournament_elo_delta: participant ? rating - before : null,
        tournament_elo_participant: participant,
        tournament_rank_before: nullableInteger(snapshot.rank_before),
        tournament_rank_after: nullableInteger(snapshot.rank_after),
        tournament_rank_delta: null,
        tournament_rank_baseline_kind: String(snapshot.rank_baseline_kind ?? "start"),
        tournament_rank_is_new: false,
      };
    });

    decorated.sort((a, b) => {
      const rating = numberValue(b.elo_rating, 1000) - numberValue(a.elo_rating, 1000);
      if (rating !== 0) return rating;
      return String(a.display_name ?? "").localeCompare(String(b.display_name ?? ""), "nb-NO", { sensitivity: "base" });
    });
    return decorated.map((raw, index): Record<string, unknown> => {
      const row: Record<string, unknown> = { ...raw, position: index + 1 };
      if (row.tournament_rank_baseline_kind === null) return row;
      const before = nullableInteger(row.tournament_rank_before);
      const after = nullableInteger(row.tournament_rank_after);
      const current = completed && after !== null ? after : index + 1;
      if (before === null) {
        row.tournament_rank_delta = null;
        row.tournament_rank_is_new = true;
        return row;
      }
      const delta = before - current;
      row.tournament_rank_delta = delta;
      row.tournament_rank_is_new = row.tournament_rank_baseline_kind === "entry" && delta === 0;
      return row;
    });
  }

  private async liveMatch(matchId: string): Promise<Record<string, unknown> | null> {
    return this.sessions.withConnection(async (db) => {
      const matches = await db.query<QueryResultRow>(
        `SELECT m.id,m.status,m.round_label,m.bracket_label,m.best_of_legs,m.legs_to_win,
                m.player_a_id,pa.display_name AS player_a_name,
                m.player_b_id,pb.display_name AS player_b_name,
                l.id AS leg_id,l.leg_number,l.starting_player_id,l.start_score
           FROM \`${this.prefix}matches\` m
           INNER JOIN \`${this.prefix}players\` pa ON pa.id=m.player_a_id
           INNER JOIN \`${this.prefix}players\` pb ON pb.id=m.player_b_id
           LEFT JOIN \`${this.prefix}legs\` l ON l.id=(
             SELECT l2.id FROM \`${this.prefix}legs\` l2
              WHERE l2.match_id=m.id AND l2.status IN ('pending','in_progress')
              ORDER BY l2.leg_number DESC LIMIT 1
           )
          WHERE m.id=? LIMIT 1`,
        [matchId],
      );
      const match = matches[0];
      if (match === undefined) return null;

      const a = requiredId(match.player_a_id, "player_a_id");
      const b = requiredId(match.player_b_id, "player_b_id");
      const wins = await this.legWinsWith(db, matchId, a, b);
      const startScore = integer(match.start_score, 501);
      const remaining = new Map<string, number>([[a, startScore], [b, startScore]]);
      let currentPlayerId: string | null = null;
      const legId = decimalId(match.leg_id);
      if (legId !== null) {
        const visits = await db.query<QueryResultRow>(
          `SELECT player_id,score,is_bust FROM \`${this.prefix}visits\` WHERE leg_id=? ORDER BY id ASC`,
          [legId],
        );
        for (const visit of visits) {
          if (integer(visit.is_bust) !== 0) continue;
          const playerId = requiredId(visit.player_id, "visit_player_id");
          remaining.set(playerId, (remaining.get(playerId) ?? startScore) - integer(visit.score));
        }
        const starter = decimalId(match.starting_player_id) ?? a;
        const other = starter === a ? b : a;
        currentPlayerId = visits.length % 2 === 0 ? starter : other;
      }

      return {
        id: matchId,
        status: String(match.status ?? ""),
        round_label: match.round_label ?? null,
        bracket_label: match.bracket_label ?? null,
        best_of_legs: integer(match.best_of_legs),
        leg_number: nullableInteger(match.leg_number),
        current_player_id: currentPlayerId,
        player_a: {
          id: a,
          display_name: String(match.player_a_name ?? ""),
          remaining: remaining.get(a) ?? startScore,
          legs_won: wins.get(a) ?? 0,
        },
        player_b: {
          id: b,
          display_name: String(match.player_b_name ?? ""),
          remaining: remaining.get(b) ?? startScore,
          legs_won: wins.get(b) ?? 0,
        },
      };
    });
  }

  private async playoffWithScores(tournamentId: string): Promise<Record<string, unknown> | null> {
    const bracket = await this.playoffs.getBracket(tournamentId);
    if (bracket === null) return null;
    const rounds = Array.isArray(bracket.rounds) ? bracket.rounds as Record<string, unknown>[] : [];
    const decoratedRounds: Record<string, unknown>[] = [];
    for (const rawRound of rounds) {
      const round: Record<string, unknown> = { ...rawRound };
      const nodes = Array.isArray(round.nodes) ? round.nodes as Record<string, unknown>[] : [];
      const decoratedNodes: Record<string, unknown>[] = [];
      for (const rawNode of nodes) {
        const node: Record<string, unknown> = { ...rawNode, legs_a: 0, legs_b: 0 };
        const matchId = decimalId(node.match_id);
        const playerA = decimalId(node.player_a_id);
        const playerB = decimalId(node.player_b_id);
        if (matchId !== null && playerA !== null && playerB !== null) {
          const wins = await this.legWins(matchId, playerA, playerB);
          node.legs_a = wins.get(playerA) ?? 0;
          node.legs_b = wins.get(playerB) ?? 0;
        }
        decoratedNodes.push(node);
      }
      round.nodes = decoratedNodes;
      decoratedRounds.push(round);
    }
    return { ...bracket, rounds: decoratedRounds };
  }

  private async legWins(matchId: string, a: string, b: string): Promise<Map<string, number>> {
    return this.sessions.withConnection((db) => this.legWinsWith(db, matchId, a, b));
  }

  private async legWinsWith(
    db: { query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<readonly T[]> },
    matchId: string,
    a: string,
    b: string,
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>([[a, 0], [b, 0]]);
    const rows = await db.query<QueryResultRow>(
      `SELECT winner_player_id,COUNT(*) AS c FROM \`${this.prefix}legs\`
        WHERE match_id=? AND status='completed' AND winner_player_id IS NOT NULL
        GROUP BY winner_player_id`,
      [matchId],
    );
    for (const row of rows) {
      const playerId = decimalId(row.winner_player_id);
      if (playerId !== null) counts.set(playerId, integer(row.c));
    }
    return counts;
  }

  private async qualifiersPerGroup(tournamentId: string): Promise<number | null> {
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT COALESCE(po.qualifiers_per_group,t.planned_qualifiers_per_group) AS qualifiers_per_group
           FROM \`${this.prefix}tournaments\` t
           LEFT JOIN \`${this.prefix}tournament_playoffs\` po ON po.tournament_id=t.id
          WHERE t.id=? LIMIT 1`,
        [tournamentId],
      );
      return nullableInteger(rows[0]?.qualifiers_per_group);
    });
  }

  private async highlights(tournamentId: string): Promise<Record<string, unknown>> {
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT COALESCE(MAX(ms.highest_checkout),0) AS highest_checkout,
                COALESCE(SUM(ms.score_180),0) AS score_180,
                COALESCE(MAX(ms.average),0) AS best_average
           FROM \`${this.prefix}match_statistics\` ms
           INNER JOIN \`${this.prefix}matches\` m ON m.id=ms.match_id
          WHERE m.tournament_id=?`,
        [tournamentId],
      );
      const row = rows[0] ?? {};
      return {
        highest_checkout: integer(row.highest_checkout),
        score_180: integer(row.score_180),
        best_average: round(numberValue(row.best_average), 2),
      };
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function decimalId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}

function requiredId(value: unknown, name: string): string {
  const id = decimalId(value);
  if (id === null) throw new DomainValidationError("invalid_id", `${name} must be a positive decimal id.`);
  return id;
}

function integer(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function normalizeCheckinMethod(value: unknown): string {
  const method = String(value ?? "").trim().toLowerCase();
  return ["admin_or_code", "admin_only", "code"].includes(method) ? method : "admin_or_code";
}

function methodUsesCode(method: string): boolean {
  return method === "admin_or_code" || method === "code";
}

function normalizePersistedCode(value: unknown): string | null {
  const code = String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return code.length >= 3 && code.length <= 12 ? code : null;
}

function nameKey(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase("nb-NO");
}
