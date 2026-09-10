import type { DbId } from "../contracts/scoring.js";
import { asDbId } from "../contracts/scoring.js";
import { EloCalculator, type EloCalculation } from "../domain/elo.js";
import type { CanonicalEloPort } from "../service/canonical-scoring-service.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

interface MatchRow extends QueryResultRow {
  readonly id?: unknown;
  readonly tournament_id?: unknown;
  readonly status?: unknown;
  readonly player_a_id?: unknown;
  readonly player_b_id?: unknown;
  readonly winner_player_id?: unknown;
  readonly club_id?: unknown;
  readonly season_id?: unknown;
  readonly start_at?: unknown;
  readonly elo_enabled?: unknown;
  readonly player_a_name?: unknown;
  readonly player_a_member_id?: unknown;
  readonly player_b_name?: unknown;
  readonly player_b_member_id?: unknown;
}

interface EventRow extends MatchRow {
  readonly match_id?: unknown;
  readonly score_a?: unknown;
  readonly score_b?: unknown;
  readonly event_status?: unknown;
  readonly applied_at?: unknown;
  readonly occurred_at?: unknown;
  readonly phase_order?: unknown;
  readonly logical_round?: unknown;
}

interface RawEventRow extends QueryResultRow {
  readonly id?: unknown;
  readonly match_id?: unknown;
  readonly tournament_id?: unknown;
  readonly season_id?: unknown;
  readonly club_id?: unknown;
  readonly player_a_id?: unknown;
  readonly player_b_id?: unknown;
  readonly winner_player_id?: unknown;
  readonly score_a?: unknown;
  readonly score_b?: unknown;
  readonly status?: unknown;
  readonly applied_at?: unknown;
  readonly player_a_name?: unknown;
  readonly player_a_member_id?: unknown;
  readonly player_b_name?: unknown;
  readonly player_b_member_id?: unknown;
  readonly occurred_at?: unknown;
  readonly phase_order?: unknown;
  readonly logical_round?: unknown;
}

interface EloState {
  readonly rating: number;
  readonly played: number;
  readonly lastEventId: DbId | null;
}

interface ReplayEvent {
  readonly id: DbId;
  readonly matchId: DbId;
  readonly tournamentId: DbId;
  readonly seasonId: DbId;
  readonly clubId: DbId;
  readonly playerAId: DbId;
  readonly playerBId: DbId;
  readonly scoreA: number;
  readonly scoreB: number;
  readonly appliedAt: string;
  readonly occurredAt: string;
  readonly playerAName: string;
  readonly playerAMemberId: DbId | null;
  readonly playerBName: string;
  readonly playerBMemberId: DbId | null;
  readonly phaseOrder: number;
  readonly logicalRound: number;
}

interface TimelineEntry {
  readonly event: ReplayEvent;
  readonly calculation: EloCalculation;
}

/**
 * Canonical ELO side effect for scoring.
 *
 * This is a behavioral port of PHP EloLedgerRepository's apply/revert path:
 * completed ELO-enabled season matches become durable elo_match_events and the
 * complete applied season timeline is replayed in deterministic tournament /
 * phase / round order. Guest matches remain ELO-neutral and historical player
 * aliases resolve through canonical member_id exactly as PHP does.
 *
 * Backend-v2 intentionally wraps each apply/revert + replay in one short season
 * transaction. That is stricter than the legacy mysqli call sequence and means
 * current ratings, event calculations and ranking snapshots cannot expose a
 * partially rebuilt season if the process loses its database connection.
 */
export class MySqlCanonicalEloLedger implements CanonicalEloPort {
  private readonly calculator: EloCalculator;

  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
    calculator: EloCalculator = new EloCalculator(),
  ) {
    this.calculator = calculator;
  }

  async applyCompletedMatch(matchId: DbId): Promise<void> {
    await this.sessions.withTransaction(async (sql) => {
      const match = await this.findMatch(sql, matchId);
      if (
        match === null
        || dbString(match.status) !== "completed"
        || dbInt(match.elo_enabled, "tournaments.elo_enabled") !== 1
        || match.season_id === null
        || match.season_id === undefined
      ) {
        return;
      }

      const seasonId = dbId(match.season_id, "tournaments.season_id");
      await this.lockSeason(sql, seasonId);
      const existing = await this.findEventByMatchId(sql, matchId);

      if (!matchHasEligibleMembers(match)) {
        if (existing !== null && dbString(existing.status) === "applied") {
          await this.markMatchReverted(sql, matchId);
          await this.rebuildSeason(sql, seasonId);
        }
        return;
      }

      const winnerId = optionalDbId(match.winner_player_id, "matches.winner_player_id");
      if (
        existing !== null
        && dbString(existing.status) === "applied"
        && optionalDbId(existing.winner_player_id, "elo_match_events.winner_player_id") === winnerId
      ) {
        return;
      }

      const playerAId = dbId(match.player_a_id, "matches.player_a_id");
      const playerBId = dbId(match.player_b_id, "matches.player_b_id");
      const tournamentId = dbId(match.tournament_id, "matches.tournament_id");
      const clubId = dbId(match.club_id, "tournaments.club_id");
      const scoreA = winnerId === null ? 0.5 : winnerId === playerAId ? 1 : 0;
      const scoreB = 1 - scoreA;

      await sql.execute(
        `INSERT INTO ${this.table("elo_match_events")}
         (match_id, tournament_id, season_id, club_id, player_a_id, player_b_id, winner_player_id,
          score_a, score_b, status, applied_at, reverted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, "applied", CURRENT_TIMESTAMP(6), NULL)
         ON DUPLICATE KEY UPDATE
            tournament_id=VALUES(tournament_id), season_id=VALUES(season_id), club_id=VALUES(club_id),
            player_a_id=VALUES(player_a_id), player_b_id=VALUES(player_b_id), winner_player_id=VALUES(winner_player_id),
            score_a=VALUES(score_a), score_b=VALUES(score_b), status="applied",
            applied_at=CURRENT_TIMESTAMP(6), reverted_at=NULL, updated_at=NOW()`,
        [matchId, tournamentId, seasonId, clubId, playerAId, playerBId, winnerId, scoreA, scoreB],
      );

      await this.rebuildSeason(sql, seasonId);
    });
  }

  async revertMatch(matchId: DbId): Promise<void> {
    await this.sessions.withTransaction(async (sql) => {
      const event = await this.findEventByMatchId(sql, matchId);
      if (event === null || dbString(event.status) !== "applied") return;

      const seasonId = dbId(event.season_id, "elo_match_events.season_id");
      await this.lockSeason(sql, seasonId);
      // Recheck after the season lock so concurrent retry/revert decisions are
      // made against the state serialized for this season.
      const lockedEvent = await this.findEventByMatchId(sql, matchId, true);
      if (lockedEvent === null || dbString(lockedEvent.status) !== "applied") return;

      await this.markMatchReverted(sql, matchId);
      await this.rebuildSeason(sql, seasonId);
    });
  }

  private async findMatch(sql: SqlExecutor, matchId: DbId): Promise<MatchRow | null> {
    const rows = await sql.query<MatchRow>(
      `SELECT m.id, m.tournament_id, m.status, m.player_a_id, m.player_b_id, m.winner_player_id,
              t.club_id, t.season_id, t.start_at, t.elo_enabled,
              pa.display_name AS player_a_name,
              COALESCE(pa.member_id, (
                  SELECT CASE WHEN COUNT(DISTINCT pa2.member_id)=1 THEN MIN(pa2.member_id) ELSE NULL END
                  FROM ${this.table("players")} pa2
                  WHERE pa2.club_id=t.club_id AND COALESCE(pa2.member_id,0)>0
                    AND LOWER(TRIM(pa2.display_name))=LOWER(TRIM(pa.display_name))
              )) AS player_a_member_id,
              pb.display_name AS player_b_name,
              COALESCE(pb.member_id, (
                  SELECT CASE WHEN COUNT(DISTINCT pb2.member_id)=1 THEN MIN(pb2.member_id) ELSE NULL END
                  FROM ${this.table("players")} pb2
                  WHERE pb2.club_id=t.club_id AND COALESCE(pb2.member_id,0)>0
                    AND LOWER(TRIM(pb2.display_name))=LOWER(TRIM(pb.display_name))
              )) AS player_b_member_id
       FROM ${this.table("matches")} m
       INNER JOIN ${this.table("tournaments")} t ON t.id=m.tournament_id
       INNER JOIN ${this.table("players")} pa ON pa.id=m.player_a_id
       INNER JOIN ${this.table("players")} pb ON pb.id=m.player_b_id
       WHERE m.id=? LIMIT 1`,
      [matchId],
    );
    return rows[0] ?? null;
  }

  private async findEventByMatchId(
    sql: SqlExecutor,
    matchId: DbId,
    forUpdate = false,
  ): Promise<RawEventRow | null> {
    const rows = await sql.query<RawEventRow>(
      `SELECT * FROM ${this.table("elo_match_events")} WHERE match_id=? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
      [matchId],
    );
    return rows[0] ?? null;
  }

  private async lockSeason(sql: SqlExecutor, seasonId: DbId): Promise<void> {
    await sql.query<QueryResultRow>(
      `SELECT id FROM ${this.table("seasons")} WHERE id=? FOR UPDATE`,
      [seasonId],
    );
  }

  private async markMatchReverted(sql: SqlExecutor, matchId: DbId): Promise<void> {
    await sql.execute(
      `UPDATE ${this.table("elo_match_events")}
       SET status="reverted", reverted_at=CURRENT_TIMESTAMP(6), updated_at=NOW()
       WHERE match_id=? AND status="applied"`,
      [matchId],
    );
  }

  private async rebuildSeason(sql: SqlExecutor, seasonId: DbId): Promise<void> {
    const events = (await this.listAppliedEvents(sql, seasonId)).filter(matchHasEligibleMembers);
    const identityByPlayer = buildIdentityMap(events);
    const state = new Map<string, EloState>();
    const aliases = new Map<string, Set<DbId>>();
    const timeline: TimelineEntry[] = [];

    for (const event of events) {
      const keyA = identityByPlayer.get(event.playerAId) ?? `player:${event.playerAId}`;
      const keyB = identityByPlayer.get(event.playerBId) ?? `player:${event.playerBId}`;
      if (keyA === keyB) {
        throw new Error(`ELO identity collision in match ${event.matchId}: both sides resolve to ${keyA}.`);
      }

      addAlias(aliases, keyA, event.playerAId);
      addAlias(aliases, keyB, event.playerBId);
      const stateA = state.get(keyA) ?? { rating: 1000, played: 0, lastEventId: null };
      const stateB = state.get(keyB) ?? { rating: 1000, played: 0, lastEventId: null };
      const calculation = this.calculator.calculate(
        stateA.rating,
        stateB.rating,
        stateA.played,
        stateB.played,
        event.scoreA,
      );

      await this.updateEventCalculation(sql, event.id, calculation);
      state.set(keyA, {
        rating: calculation.rating_a_after,
        played: calculation.matches_after_a,
        lastEventId: event.id,
      });
      state.set(keyB, {
        rating: calculation.rating_b_after,
        played: calculation.matches_after_b,
        lastEventId: event.id,
      });
      timeline.push({ event, calculation });
    }

    const rawState = new Map<DbId, EloState>();
    for (const [identityKey, playerIds] of aliases) {
      const identityState = state.get(identityKey);
      if (!identityState) continue;
      for (const playerId of playerIds) rawState.set(playerId, identityState);
    }

    await this.replaceCurrentRatings(sql, seasonId, rawState);
    await this.replaceLedgerSnapshots(sql, seasonId, timeline);
  }

  private async listAppliedEvents(sql: SqlExecutor, seasonId: DbId): Promise<readonly ReplayEvent[]> {
    const rows = await sql.query<RawEventRow>(
      `SELECT e.*,
              t.start_at AS tournament_start_at,
              m.round_label, m.round_number, m.bracket_label, m.tournament_group_id,
              COALESCE(m.finished_at, m.starts_at, t.start_at, m.created_at, e.applied_at) AS occurred_at,
              pa.display_name AS player_a_name,
              COALESCE(pa.member_id, (
                  SELECT CASE WHEN COUNT(DISTINCT pa2.member_id)=1 THEN MIN(pa2.member_id) ELSE NULL END
                  FROM ${this.table("players")} pa2
                  WHERE pa2.club_id=e.club_id AND COALESCE(pa2.member_id,0)>0
                    AND LOWER(TRIM(pa2.display_name))=LOWER(TRIM(pa.display_name))
              )) AS player_a_member_id,
              pb.display_name AS player_b_name,
              COALESCE(pb.member_id, (
                  SELECT CASE WHEN COUNT(DISTINCT pb2.member_id)=1 THEN MIN(pb2.member_id) ELSE NULL END
                  FROM ${this.table("players")} pb2
                  WHERE pb2.club_id=e.club_id AND COALESCE(pb2.member_id,0)>0
                    AND LOWER(TRIM(pb2.display_name))=LOWER(TRIM(pb.display_name))
              )) AS player_b_member_id,
              CASE
                  WHEN m.tournament_group_id IS NOT NULL OR LOWER(COALESCE(m.bracket_label, ""))="group" THEN 0
                  WHEN pn.id IS NOT NULL OR LOWER(COALESCE(m.bracket_label, "")) IN ("single_elimination","playoff","knockout") THEN 2
                  ELSE 1
              END AS phase_order,
              CASE
                  WHEN m.tournament_group_id IS NOT NULL OR LOWER(COALESCE(m.bracket_label, ""))="group"
                      THEN COALESCE(m.round_number, 32767)
                  WHEN pn.id IS NOT NULL
                      THEN COALESCE(pn.round_number, m.round_number, 32767)
                  ELSE COALESCE(m.round_number, 32767)
              END AS logical_round,
              COALESCE(tg.sort_order, 0) AS group_order,
              COALESCE(pn.position, 0) AS playoff_position
       FROM ${this.table("elo_match_events")} e
       INNER JOIN ${this.table("matches")} m ON m.id=e.match_id
       INNER JOIN ${this.table("tournaments")} t ON t.id=e.tournament_id
       INNER JOIN ${this.table("players")} pa ON pa.id=e.player_a_id
       INNER JOIN ${this.table("players")} pb ON pb.id=e.player_b_id
       LEFT JOIN ${this.table("tournament_groups")} tg ON tg.id=m.tournament_group_id
       LEFT JOIN ${this.table("tournament_playoff_nodes")} pn ON pn.match_id=m.id
       WHERE e.season_id=? AND e.status="applied"
       ORDER BY COALESCE(t.start_at, m.created_at, e.applied_at) ASC,
                t.id ASC,
                phase_order ASC,
                logical_round ASC,
                group_order ASC,
                playoff_position ASC,
                occurred_at ASC,
                m.id ASC,
                e.id ASC`,
      [seasonId],
    );
    return rows.map(normalizeReplayEvent);
  }

  private async updateEventCalculation(
    sql: SqlExecutor,
    eventId: DbId,
    calc: EloCalculation,
  ): Promise<void> {
    await sql.execute(
      `UPDATE ${this.table("elo_match_events")}
       SET rating_a_before=?, rating_b_before=?, rating_a_after=?, rating_b_after=?,
           delta_a=?, delta_b=?, matches_before_a=?, matches_before_b=?, k_a=?, k_b=?, updated_at=NOW()
       WHERE id=?`,
      [
        calc.rating_a_before,
        calc.rating_b_before,
        calc.rating_a_after,
        calc.rating_b_after,
        calc.delta_a,
        calc.delta_b,
        calc.matches_before_a,
        calc.matches_before_b,
        calc.k_a,
        calc.k_b,
        eventId,
      ],
    );
  }

  private async replaceCurrentRatings(
    sql: SqlExecutor,
    seasonId: DbId,
    state: ReadonlyMap<DbId, EloState>,
  ): Promise<void> {
    await sql.execute(
      `DELETE FROM ${this.table("elo_current_ratings")} WHERE season_id=?`,
      [seasonId],
    );
    if (state.size === 0) return;

    const playerIds = [...state.keys()].sort(compareDecimalIds);
    for (const playerId of playerIds) {
      const row = state.get(playerId);
      if (!row) continue;
      await sql.execute(
        `INSERT INTO ${this.table("elo_current_ratings")} (season_id, player_id, rating, matches_played, last_event_id)
         VALUES (?, ?, ?, ?, ?)`,
        [seasonId, playerId, row.rating, row.played, row.lastEventId],
      );
    }
  }

  private async replaceLedgerSnapshots(
    sql: SqlExecutor,
    seasonId: DbId,
    timeline: readonly TimelineEntry[],
  ): Promise<void> {
    await sql.execute(
      `DELETE FROM ${this.table("ranking_snapshots")}
       WHERE season_id=? AND ranking_type="elo"
         AND JSON_UNQUOTE(JSON_EXTRACT(context_json, "$.source"))="elo_ledger"`,
      [seasonId],
    );
    if (timeline.length === 0) return;

    for (const { event, calculation } of timeline) {
      const calculatedAt = (event.occurredAt || event.appliedAt).slice(0, 19);
      for (const player of [
        {
          playerId: event.playerAId,
          points: calculation.rating_a_after,
          delta: calculation.delta_a,
          before: calculation.rating_a_before,
          matchesBefore: calculation.matches_before_a,
          matchesAfter: calculation.matches_after_a,
          k: calculation.k_a,
        },
        {
          playerId: event.playerBId,
          points: calculation.rating_b_after,
          delta: calculation.delta_b,
          before: calculation.rating_b_before,
          matchesBefore: calculation.matches_before_b,
          matchesAfter: calculation.matches_after_b,
          k: calculation.k_b,
        },
      ] as const) {
        const context = JSON.stringify({
          source: "elo_ledger",
          event_id: event.id,
          match_id: event.matchId,
          rating_before: player.before,
          rating_after: player.points,
          delta: player.delta,
          matches_before: player.matchesBefore,
          matches_after: player.matchesAfter,
          k: player.k,
          phase_order: event.phaseOrder,
          logical_round: event.logicalRound,
        });
        await sql.execute(
          `INSERT INTO ${this.table("ranking_snapshots")}
           (season_id, tournament_id, player_id, ranking_type, scope_type, points, position, context_json, calculated_at)
           VALUES (?, ?, ?, "elo", "season", ?, NULL, ?, ?)`,
          [seasonId, event.tournamentId, player.playerId, player.points, context, calculatedAt],
        );
      }
    }
  }

  private table(name: RuntimeEloTable): string {
    return `\`${this.runtimePrefix}${name}\``;
  }
}

type RuntimeEloTable =
  | "matches"
  | "tournaments"
  | "players"
  | "seasons"
  | "elo_match_events"
  | "elo_current_ratings"
  | "ranking_snapshots"
  | "tournament_groups"
  | "tournament_playoff_nodes";

function normalizeReplayEvent(row: RawEventRow): ReplayEvent {
  return {
    id: dbId(row.id, "elo_match_events.id"),
    matchId: dbId(row.match_id, "elo_match_events.match_id"),
    tournamentId: dbId(row.tournament_id, "elo_match_events.tournament_id"),
    seasonId: dbId(row.season_id, "elo_match_events.season_id"),
    clubId: dbId(row.club_id, "elo_match_events.club_id"),
    playerAId: dbId(row.player_a_id, "elo_match_events.player_a_id"),
    playerBId: dbId(row.player_b_id, "elo_match_events.player_b_id"),
    scoreA: dbFloat(row.score_a, "elo_match_events.score_a"),
    scoreB: dbFloat(row.score_b, "elo_match_events.score_b"),
    appliedAt: dbString(row.applied_at),
    occurredAt: dbString(row.occurred_at),
    playerAName: dbString(row.player_a_name),
    playerAMemberId: optionalDbId(row.player_a_member_id, "players.member_id"),
    playerBName: dbString(row.player_b_name),
    playerBMemberId: optionalDbId(row.player_b_member_id, "players.member_id"),
    phaseOrder: dbInt(row.phase_order ?? 1, "phase_order"),
    logicalRound: dbInt(row.logical_round ?? 0, "logical_round"),
  };
}

function matchHasEligibleMembers(row: MatchRow | RawEventRow | ReplayEvent): boolean {
  if ("playerAMemberId" in row) {
    return row.playerAMemberId !== null && row.playerBMemberId !== null;
  }
  return optionalDbId(row.player_a_member_id, "players.member_id") !== null
    && optionalDbId(row.player_b_member_id, "players.member_id") !== null;
}

function buildIdentityMap(events: readonly ReplayEvent[]): ReadonlyMap<DbId, string> {
  const groups = new Map<string, Map<DbId, DbId | null>>();
  for (const event of events) {
    for (const side of [
      { playerId: event.playerAId, memberId: event.playerAMemberId, name: event.playerAName },
      { playerId: event.playerBId, memberId: event.playerBMemberId, name: event.playerBName },
    ]) {
      const name = side.name.trim().toLocaleLowerCase();
      const groupKey = name !== "" ? `${event.clubId}:${name}` : `player:${side.playerId}`;
      let players = groups.get(groupKey);
      if (!players) {
        players = new Map();
        groups.set(groupKey, players);
      }
      players.set(side.playerId, side.memberId);
    }
  }

  const result = new Map<DbId, string>();
  for (const [groupKey, players] of groups) {
    const distinctMembers = new Set<DbId>();
    for (const memberId of players.values()) if (memberId !== null) distinctMembers.add(memberId);
    const singleMemberId = distinctMembers.size === 1 ? [...distinctMembers][0] ?? null : null;

    for (const [playerId, memberId] of players) {
      if (memberId !== null) {
        result.set(playerId, `member:${memberId}`);
      } else if (singleMemberId !== null) {
        result.set(playerId, `member:${singleMemberId}`);
      } else if (distinctMembers.size === 0) {
        result.set(playerId, `name:${groupKey}`);
      } else {
        result.set(playerId, `player:${playerId}`);
      }
    }
  }
  return result;
}

function addAlias(aliases: Map<string, Set<DbId>>, key: string, playerId: DbId): void {
  let values = aliases.get(key);
  if (!values) {
    values = new Set();
    aliases.set(key, values);
  }
  values.add(playerId);
}

function dbId(value: unknown, field: string): DbId {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be returned from MySQL as a decimal string.`);
  }
  return asDbId(value);
}

function optionalDbId(value: unknown, field: string): DbId | null {
  if (value === null || value === undefined || value === "" || value === "0" || value === 0) return null;
  return dbId(value, field);
}

function dbString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function dbInt(value: unknown, field: string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numeric)) throw new TypeError(`${field} must be an integer-compatible MySQL value.`);
  return numeric;
}

function dbFloat(value: unknown, field: string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) throw new TypeError(`${field} must be a finite MySQL numeric value.`);
  return numeric;
}

function compareDecimalIds(left: DbId, right: DbId): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
