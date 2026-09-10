import type { RecordVisitCommand } from "../contracts/canonical-scoring.js";
import { asDbId, type DbId, type EvaluatedVisit, type VisitInput } from "../contracts/scoring.js";
import { evaluateVisit } from "../domain/dart501.js";
import { DomainValidationError } from "../domain/errors.js";
import type {
  MySqlSessionProvider,
  QueryResultRow,
  SqlExecutor,
  TablePrefix,
} from "./contracts.js";

export type RecordVisitWriteResult =
  | { readonly kind: "duplicate" }
  | {
      readonly kind: "recorded";
      readonly match_id: DbId;
      readonly leg_id: DbId;
      readonly player_id: DbId;
      readonly evaluation: EvaluatedVisit;
      readonly match_completed: boolean;
    };

interface MatchDbRow extends QueryResultRow {
  readonly id: unknown;
  readonly status: unknown;
  readonly legs_to_win: unknown;
  readonly player_a_id: unknown;
  readonly player_b_id: unknown;
}

interface LegDbRow extends QueryResultRow {
  readonly id: unknown;
  readonly match_id: unknown;
  readonly leg_number: unknown;
  readonly starting_player_id: unknown;
  readonly status: unknown;
  readonly start_score: unknown;
  readonly winner_player_id?: unknown;
}

interface CurrentPlayerDbRow extends QueryResultRow {
  readonly starting_player_id: unknown;
  readonly total_visits: unknown;
}

interface VisitScoreDbRow extends QueryResultRow {
  readonly player_id: unknown;
  readonly score: unknown;
  readonly is_bust: unknown;
}

interface NumberDbRow extends QueryResultRow {
  readonly n?: unknown;
  readonly c?: unknown;
}

interface MatchPlayersDbRow extends QueryResultRow {
  readonly player_a_id: unknown;
  readonly player_b_id: unknown;
}

interface AggregateDbRow extends QueryResultRow {
  readonly effective_score?: unknown;
  readonly darts_thrown?: unknown;
  readonly highest_checkout?: unknown;
  readonly score_100_plus?: unknown;
  readonly score_140_plus?: unknown;
  readonly score_180?: unknown;
}

/**
 * MySQL-backed canonical scoring repository, expressed only through the scarce-
 * connection session contract. No driver or pool is owned here.
 *
 * This intentionally mirrors today's PHP MatchScoringRepository transaction
 * boundary. The cheap request-key retry check happens before the transaction,
 * then is repeated inside the transaction before any match row is locked.
 */
export class MySqlCanonicalScoringRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
  ) {}

  async recordVisit(command: RecordVisitCommand): Promise<RecordVisitWriteResult> {
    const requestKey = normalizeRequestKey(command.payload);
    if (requestKey.length > 80) {
      throw new DomainValidationError("request_id_too_long", "request_id er for lang.");
    }

    if (requestKey !== "") {
      const duplicate = await this.sessions.withConnection((connection) =>
        this.visitRequestAlreadyExists(connection, requestKey),
      );
      if (duplicate) {
        return { kind: "duplicate" };
      }
    }

    return this.sessions.withTransaction(async (transaction) => {
      if (requestKey !== "" && await this.visitRequestAlreadyExists(transaction, requestKey)) {
        return { kind: "duplicate" };
      }

      const match = await this.findActiveMatchForKiosk(transaction, command.kiosk_id);
      if (match === null) {
        throw new DomainValidationError(
          "match_not_available",
          "Det finnes ingen kamp klar på denne skiven.",
          409,
        );
      }

      if (match.status === "assigned") {
        await transaction.execute(
          `UPDATE ${this.table("matches")} SET status="in_progress", starts_at=COALESCE(starts_at, NOW()) WHERE id=?`,
          [match.id],
        );
        match.status = "in_progress";
      }

      const leg = await this.ensureCurrentLeg(transaction, match);
      const currentPlayerId = await this.determineCurrentPlayerId(transaction, match, leg.id);
      const remaining = await this.calculateRemainingScores(transaction, match, leg);
      const remainingBefore = remaining.get(currentPlayerId) ?? leg.start_score;
      const evaluation = evaluateVisit(remainingBefore, command.payload);
      const visitNumber = await this.nextVisitNumberForPlayer(transaction, leg.id, currentPlayerId);

      await this.insertVisit(
        transaction,
        match.id,
        leg.id,
        currentPlayerId,
        visitNumber,
        evaluation,
        requestKey === "" ? null : requestKey,
      );

      let matchCompleted = false;
      if (evaluation.is_checkout) {
        matchCompleted = await this.completeLeg(transaction, match, leg, currentPlayerId);
      }

      await this.rebuildMatchStatistics(transaction, match.id);

      return {
        kind: "recorded",
        match_id: match.id,
        leg_id: leg.id,
        player_id: currentPlayerId,
        evaluation,
        match_completed: matchCompleted,
      };
    });
  }

  private async findActiveMatchForKiosk(
    sql: SqlExecutor,
    kioskId: DbId,
  ): Promise<MutableMatch | null> {
    const rows = await sql.query<MatchDbRow>(
      `SELECT id, tournament_id, kiosk_id, status, best_of_legs, legs_to_win,
              player_a_id, player_b_id, winner_player_id, starts_at, finished_at
       FROM ${this.table("matches")}
       WHERE kiosk_id=? AND status IN ("in_progress","assigned")
       ORDER BY
          FIELD(status,"in_progress","assigned","completed"),
          CASE WHEN status="completed" THEN id END DESC,
          CASE WHEN status<>"completed" THEN id END ASC
       LIMIT 1 FOR UPDATE`,
      [kioskId],
    );
    const row = rows[0];
    if (!row) return null;

    const status = dbString(row.status);
    if (status !== "assigned" && status !== "in_progress") {
      throw new Error(`Unexpected active match status: ${status}`);
    }

    return {
      id: dbId(row.id, "matches.id"),
      status,
      legs_to_win: dbInt(row.legs_to_win, "matches.legs_to_win"),
      player_a_id: dbId(row.player_a_id, "matches.player_a_id"),
      player_b_id: dbId(row.player_b_id, "matches.player_b_id"),
    };
  }

  private async ensureCurrentLeg(sql: SqlExecutor, match: MutableMatch): Promise<CanonicalLeg> {
    const open = await this.findOpenLeg(sql, match.id);
    if (open !== null) {
      if (open.status === "pending") {
        await sql.execute(
          `UPDATE ${this.table("legs")} SET status="in_progress" WHERE id=?`,
          [open.id],
        );
        return { ...open, status: "in_progress" };
      }
      return open;
    }

    const latest = await this.findLatestLeg(sql, match.id);
    const legNumber = latest === null ? 1 : latest.leg_number + 1;
    let startingPlayerId = match.player_a_id;
    if (latest !== null) {
      startingPlayerId = latest.starting_player_id === match.player_a_id
        ? match.player_b_id
        : match.player_a_id;
    }

    const startScore = 501;
    const insert = await sql.execute(
      `INSERT INTO ${this.table("legs")} (match_id, leg_number, starting_player_id, status, start_score)
       VALUES (?, ?, ?, "in_progress", ?)`,
      [match.id, legNumber, startingPlayerId, startScore],
    );
    if (insert.insertId === undefined) {
      throw new Error("MySQL leg insert did not return a BIGINT string insertId.");
    }

    return {
      id: insert.insertId,
      match_id: match.id,
      leg_number: legNumber,
      starting_player_id: startingPlayerId,
      status: "in_progress",
      start_score: startScore,
    };
  }

  private async findOpenLeg(sql: SqlExecutor, matchId: DbId): Promise<CanonicalLeg | null> {
    const rows = await sql.query<LegDbRow>(
      `SELECT id, match_id, leg_number, starting_player_id, status, start_score
       FROM ${this.table("legs")}
       WHERE match_id=? AND status IN ("pending","in_progress")
       ORDER BY leg_number DESC LIMIT 1 FOR UPDATE`,
      [matchId],
    );
    return rows[0] ? normalizeLeg(rows[0]) : null;
  }

  private async findLatestLeg(sql: SqlExecutor, matchId: DbId): Promise<CanonicalLeg | null> {
    const rows = await sql.query<LegDbRow>(
      `SELECT id, match_id, leg_number, starting_player_id, status, start_score, winner_player_id
       FROM ${this.table("legs")} WHERE match_id=? ORDER BY leg_number DESC LIMIT 1 FOR UPDATE`,
      [matchId],
    );
    return rows[0] ? normalizeLeg(rows[0]) : null;
  }

  private async determineCurrentPlayerId(
    sql: SqlExecutor,
    match: MutableMatch,
    legId: DbId,
  ): Promise<DbId> {
    const rows = await sql.query<CurrentPlayerDbRow>(
      `SELECT l.starting_player_id, COUNT(v.id) AS total_visits
       FROM ${this.table("legs")} l
       LEFT JOIN ${this.table("visits")} v ON v.leg_id=l.id
       WHERE l.id=? GROUP BY l.id, l.starting_player_id`,
      [legId],
    );
    const row = rows[0];
    if (!row) {
      throw new DomainValidationError("leg_not_found", "Aktivt leg ble ikke funnet.", 409);
    }

    const starter = dbId(row.starting_player_id, "legs.starting_player_id");
    const other = starter === match.player_a_id ? match.player_b_id : match.player_a_id;
    return dbInt(row.total_visits, "total_visits") % 2 === 0 ? starter : other;
  }

  private async calculateRemainingScores(
    sql: SqlExecutor,
    match: MutableMatch,
    leg: CanonicalLeg,
  ): Promise<Map<DbId, number>> {
    const remaining = new Map<DbId, number>([
      [match.player_a_id, leg.start_score],
      [match.player_b_id, leg.start_score],
    ]);
    const rows = await sql.query<VisitScoreDbRow>(
      `SELECT player_id, score, is_bust FROM ${this.table("visits")} WHERE leg_id=? ORDER BY id ASC`,
      [leg.id],
    );

    for (const row of rows) {
      if (dbInt(row.is_bust, "visits.is_bust") === 1) continue;
      const playerId = dbId(row.player_id, "visits.player_id");
      const current = remaining.get(playerId) ?? leg.start_score;
      remaining.set(playerId, current - dbInt(row.score, "visits.score"));
    }
    return remaining;
  }

  private async nextVisitNumberForPlayer(
    sql: SqlExecutor,
    legId: DbId,
    playerId: DbId,
  ): Promise<number> {
    const rows = await sql.query<NumberDbRow>(
      `SELECT COALESCE(MAX(visit_number),0) AS n FROM ${this.table("visits")} WHERE leg_id=? AND player_id=?`,
      [legId, playerId],
    );
    return dbInt(rows[0]?.n ?? 0, "visit_number") + 1;
  }

  private async insertVisit(
    sql: SqlExecutor,
    matchId: DbId,
    legId: DbId,
    playerId: DbId,
    visitNumber: number,
    visit: EvaluatedVisit,
    requestKey: string | null,
  ): Promise<void> {
    const dartsJson = visit.darts.length > 0 ? JSON.stringify(visit.darts) : null;
    await sql.execute(
      `INSERT INTO ${this.table("visits")}
       (match_id, leg_id, player_id, visit_number, score, darts_used, input_mode, darts_json, is_bust, remaining_after, request_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        matchId,
        legId,
        playerId,
        visitNumber,
        visit.score,
        visit.darts_used,
        visit.input_mode,
        dartsJson,
        visit.is_bust ? 1 : 0,
        visit.remaining_after,
        requestKey,
      ],
    );
  }

  private async completeLeg(
    sql: SqlExecutor,
    match: MutableMatch,
    leg: CanonicalLeg,
    winnerPlayerId: DbId,
  ): Promise<boolean> {
    await sql.execute(
      `UPDATE ${this.table("legs")} SET winner_player_id=?, status="completed", finished_at=NOW() WHERE id=?`,
      [winnerPlayerId, leg.id],
    );

    const wins = await this.countLegWins(sql, match.id, winnerPlayerId);
    if (wins >= match.legs_to_win) {
      await sql.execute(
        `UPDATE ${this.table("matches")} SET status="completed", winner_player_id=?, finished_at=NOW() WHERE id=?`,
        [winnerPlayerId, match.id],
      );
      return true;
    }

    await this.ensureCurrentLeg(sql, match);
    return false;
  }

  private async countLegWins(sql: SqlExecutor, matchId: DbId, playerId: DbId): Promise<number> {
    const rows = await sql.query<NumberDbRow>(
      `SELECT COUNT(*) AS c FROM ${this.table("legs")} WHERE match_id=? AND winner_player_id=?`,
      [matchId, playerId],
    );
    return dbInt(rows[0]?.c ?? 0, "leg_wins");
  }

  private async visitRequestAlreadyExists(sql: SqlExecutor, requestKey: string): Promise<boolean> {
    const rows = await sql.query<QueryResultRow>(
      `SELECT id FROM ${this.table("visits")} WHERE request_key=? LIMIT 1`,
      [requestKey],
    );
    return rows.length > 0;
  }

  private async rebuildMatchStatistics(sql: SqlExecutor, matchId: DbId): Promise<void> {
    const matchRows = await sql.query<MatchPlayersDbRow>(
      `SELECT player_a_id, player_b_id FROM ${this.table("matches")} WHERE id=? LIMIT 1`,
      [matchId],
    );
    const match = matchRows[0];
    if (!match) return;

    const playerIds = [
      dbId(match.player_a_id, "matches.player_a_id"),
      dbId(match.player_b_id, "matches.player_b_id"),
    ] as const;

    for (const playerId of playerIds) {
      const aggregateRows = await sql.query<AggregateDbRow>(
        `SELECT
            COALESCE(SUM(CASE WHEN is_bust=0 THEN score ELSE 0 END),0) AS effective_score,
            COALESCE(SUM(darts_used),0) AS darts_thrown,
            COALESCE(MAX(CASE WHEN is_bust=0 AND remaining_after=0 THEN score END),0) AS highest_checkout,
            SUM(CASE WHEN is_bust=0 AND score>=100 AND score<140 THEN 1 ELSE 0 END) AS score_100_plus,
            SUM(CASE WHEN is_bust=0 AND score>=140 AND score<180 THEN 1 ELSE 0 END) AS score_140_plus,
            SUM(CASE WHEN is_bust=0 AND score=180 THEN 1 ELSE 0 END) AS score_180
         FROM ${this.table("visits")} WHERE match_id=? AND player_id=?`,
        [matchId, playerId],
      );
      const row = aggregateRows[0] ?? {};

      const legsRows = await sql.query<NumberDbRow>(
        `SELECT COUNT(*) AS c FROM ${this.table("legs")} WHERE match_id=? AND winner_player_id=?`,
        [matchId, playerId],
      );
      const legsWon = dbInt(legsRows[0]?.c ?? 0, "legs_won");
      const dartsThrown = dbInt(row.darts_thrown ?? 0, "darts_thrown");
      const effectiveScore = dbInt(row.effective_score ?? 0, "effective_score");
      const average = dartsThrown > 0 ? round2((effectiveScore / dartsThrown) * 3) : null;

      await sql.execute(
        `INSERT INTO ${this.table("match_statistics")}
         (match_id, player_id, legs_won, average, darts_thrown, checkout_hits, checkout_attempts,
          highest_checkout, score_100_plus, score_140_plus, score_180)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            legs_won=VALUES(legs_won), average=VALUES(average), darts_thrown=VALUES(darts_thrown),
            checkout_hits=VALUES(checkout_hits), checkout_attempts=VALUES(checkout_attempts),
            highest_checkout=VALUES(highest_checkout), score_100_plus=VALUES(score_100_plus),
            score_140_plus=VALUES(score_140_plus), score_180=VALUES(score_180), updated_at=NOW()`,
        [
          matchId,
          playerId,
          legsWon,
          average,
          dartsThrown,
          legsWon,
          null,
          dbInt(row.highest_checkout ?? 0, "highest_checkout"),
          dbInt(row.score_100_plus ?? 0, "score_100_plus"),
          dbInt(row.score_140_plus ?? 0, "score_140_plus"),
          dbInt(row.score_180 ?? 0, "score_180"),
        ],
      );
    }
  }

  private table(name: "matches" | "legs" | "visits" | "match_statistics"): string {
    return `\`${this.runtimePrefix}${name}\``;
  }
}

interface MutableMatch {
  readonly id: DbId;
  status: "assigned" | "in_progress";
  readonly legs_to_win: number;
  readonly player_a_id: DbId;
  readonly player_b_id: DbId;
}

interface CanonicalLeg {
  readonly id: DbId;
  readonly match_id: DbId;
  readonly leg_number: number;
  readonly starting_player_id: DbId;
  readonly status: "pending" | "in_progress" | "completed";
  readonly start_score: number;
}

function normalizeLeg(row: LegDbRow): CanonicalLeg {
  const status = dbString(row.status);
  if (status !== "pending" && status !== "in_progress" && status !== "completed") {
    throw new Error(`Unexpected leg status: ${status}`);
  }
  return {
    id: dbId(row.id, "legs.id"),
    match_id: dbId(row.match_id, "legs.match_id"),
    leg_number: dbInt(row.leg_number, "legs.leg_number"),
    starting_player_id: dbId(row.starting_player_id, "legs.starting_player_id"),
    status,
    start_score: dbInt(row.start_score, "legs.start_score"),
  };
}

function normalizeRequestKey(payload: VisitInput): string {
  const value = (payload as Record<string, unknown>).request_id;
  if (value === undefined || value === null || value === false) return "";
  if (value === true) return "1";
  return String(value).trim();
}

function dbId(value: unknown, field: string): DbId {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be returned from MySQL as a decimal string.`);
  }
  return asDbId(value);
}

function dbInt(value: unknown, field: string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numeric)) {
    throw new TypeError(`${field} must be an integer-compatible MySQL value.`);
  }
  return numeric;
}

function dbString(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
