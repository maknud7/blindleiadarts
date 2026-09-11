import { asDbId, type DbId } from "../contracts/scoring.js";
import { DomainValidationError } from "../domain/errors.js";
import {
  bracketSize,
  roundCount,
  roundLabel,
  seedOrder,
  seedQualifiers,
  type PlayoffQualifier,
} from "../domain/single-elimination.js";
import type { CanonicalPlayoffPort } from "../service/canonical-scoring-service.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

interface MatchPlanRow extends QueryResultRow {
  readonly tournament_id?: unknown;
  readonly tournament_group_id?: unknown;
  readonly status?: unknown;
  readonly planned_tournament_format?: unknown;
  readonly planned_auto_create_playoff?: unknown;
  readonly planned_qualifiers_per_group?: unknown;
  readonly planned_playoff_best_of_legs?: unknown;
}

interface NodeRow extends QueryResultRow {
  readonly id?: unknown;
  readonly playoff_id?: unknown;
  readonly tournament_id?: unknown;
  readonly round_number?: unknown;
  readonly position?: unknown;
  readonly player_a_id?: unknown;
  readonly player_b_id?: unknown;
  readonly match_id?: unknown;
  readonly winner_player_id?: unknown;
  readonly status?: unknown;
  readonly match_status?: unknown;
  readonly kiosk_id?: unknown;
}

interface GroupStanding {
  readonly player_id: DbId;
  readonly display_name: string;
  readonly seed_number: number | null;
  readonly played: number;
  readonly wins: number;
  readonly draws: number;
  readonly losses: number;
  readonly legs_won: number;
  readonly legs_lost: number;
  readonly three_dart_average: number;
  readonly points: number;
  readonly leg_diff: number;
  readonly head_to_head_points: number;
}

/**
 * PHP-compatible native single-elimination side effects for canonical scoring.
 *
 * The public methods deliberately preserve the existing orchestration boundary:
 * undo eligibility is checked before the scoring mutation, while bracket state
 * is reconciled after the canonical scoring transaction commits.
 */
export class MySqlCanonicalPlayoffReconciliation implements CanonicalPlayoffPort {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
  ) {}

  async assertUndoAllowed(kioskId: DbId): Promise<DbId | null> {
    const matchId = await this.targetMatchIdForKiosk(kioskId, true);
    if (matchId !== null) await this.assertUndoAllowedForMatch(matchId);
    return matchId;
  }

  async afterMutation(matchId: DbId | null, wasUndo: boolean): Promise<void> {
    if (matchId === null) return;
    if (wasUndo) {
      await this.rewindAfterUndo(matchId);
      await this.restoreReopenedMatchParticipants(matchId);
    } else {
      await this.autoCreatePlannedPlayoff(matchId);
    }
    await this.reconcileByMatchId(matchId);
  }

  private async targetMatchIdForKiosk(kioskId: DbId, includeCompleted: boolean): Promise<DbId | null> {
    return this.sessions.withConnection(async (sql) => {
      const statuses = includeCompleted
        ? '("in_progress","assigned","completed")'
        : '("in_progress","assigned")';
      const rows = await sql.query<QueryResultRow>(
        `SELECT CAST(id AS CHAR) AS id FROM ${this.table("matches")}
         WHERE kiosk_id=? AND status IN ${statuses}
         ORDER BY FIELD(status,"in_progress","assigned","completed"),
                  CASE WHEN status="completed" THEN id END DESC,
                  CASE WHEN status<>"completed" THEN id END ASC
         LIMIT 1`,
        [kioskId],
      );
      return rows[0] ? dbId(rows[0].id, "matches.id") : null;
    });
  }

  private async assertUndoAllowedForMatch(matchId: DbId): Promise<void> {
    await this.sessions.withConnection(async (sql) => {
      const node = await this.nodeByMatchId(sql, matchId, false);
      if (node === null) return;
      const parent = await this.parentNode(
        sql,
        dbId(node.playoff_id, "playoff_node.playoff_id"),
        dbInt(node.round_number, "playoff_node.round_number"),
        dbInt(node.position, "playoff_node.position"),
      );
      if (parent === null || parent.match_id === null || parent.match_id === undefined) return;
      const status = dbString(parent.match_status);
      if (status === "pending" && nullableDbId(parent.kiosk_id, "parent.kiosk_id") === null) return;
      throw new DomainValidationError(
        "playoff_downstream_started",
        "Resultatet kan ikke angres fordi neste sluttspillkamp allerede er kalt opp eller startet.",
        409,
      );
    });
  }

  private async rewindAfterUndo(matchId: DbId): Promise<void> {
    await this.sessions.withTransaction(async (sql) => {
      const node = await this.nodeByMatchId(sql, matchId, true);
      if (node === null) return;
      const playoffId = dbId(node.playoff_id, "playoff_node.playoff_id");
      const tournamentId = dbId(node.tournament_id, "playoff_node.tournament_id");
      await this.invalidateAncestors(
        sql,
        playoffId,
        dbInt(node.round_number, "playoff_node.round_number"),
        dbInt(node.position, "playoff_node.position"),
      );
      await sql.execute(
        `UPDATE ${this.table("tournament_playoff_nodes")}
         SET winner_player_id=NULL,status=CASE WHEN match_id IS NULL THEN "waiting" ELSE "ready" END
         WHERE id=?`,
        [dbId(node.id, "playoff_node.id")],
      );
      await sql.execute(
        `UPDATE ${this.table("tournament_playoffs")}
         SET status="in_progress",champion_player_id=NULL WHERE id=?`,
        [playoffId],
      );
      await sql.execute(
        `UPDATE ${this.table("tournaments")} SET status="in_progress",end_at=NULL WHERE id=?`,
        [tournamentId],
      );
    });
  }

  private async restoreReopenedMatchParticipants(matchId: DbId): Promise<void> {
    await this.sessions.withConnection(async (sql) => {
      const rows = await sql.query<QueryResultRow>(
        `SELECT CAST(m.tournament_id AS CHAR) AS tournament_id,
                CAST(m.player_a_id AS CHAR) AS player_a_id,
                CAST(m.player_b_id AS CHAR) AS player_b_id,
                EXISTS(SELECT 1 FROM ${this.table("tournament_playoff_nodes")} n WHERE n.match_id=m.id) AS is_playoff
         FROM ${this.table("matches")} m WHERE m.id=? LIMIT 1`,
        [matchId],
      );
      const match = rows[0];
      if (!match || dbInt(match.is_playoff ?? 0, "matches.is_playoff") !== 1) return;
      const tournamentId = dbId(match.tournament_id, "matches.tournament_id");
      for (const playerId of [
        dbId(match.player_a_id, "matches.player_a_id"),
        dbId(match.player_b_id, "matches.player_b_id"),
      ]) {
        const breaks = await sql.query<QueryResultRow>(
          `SELECT 1 AS present FROM ${this.table("tournament_player_breaks")}
           WHERE tournament_id=? AND player_id=? AND status IN ("scheduled","active")
           ORDER BY id DESC LIMIT 1`,
          [tournamentId, playerId],
        );
        await sql.execute(
          `UPDATE ${this.table("tournament_players")} SET status=? WHERE tournament_id=? AND player_id=?`,
          [breaks.length > 0 ? "paused" : "checked_in", tournamentId, playerId],
        );
      }
    });
  }

  private async autoCreatePlannedPlayoff(matchId: DbId): Promise<void> {
    const plan = await this.sessions.withConnection(async (sql) => {
      const rows = await sql.query<MatchPlanRow>(
        `SELECT CAST(m.tournament_id AS CHAR) AS tournament_id,
                CAST(m.tournament_group_id AS CHAR) AS tournament_group_id,
                m.status,t.planned_tournament_format,t.planned_auto_create_playoff,
                t.planned_qualifiers_per_group,t.planned_playoff_best_of_legs
         FROM ${this.table("matches")} m
         INNER JOIN ${this.table("tournaments")} t ON t.id=m.tournament_id
         WHERE m.id=? LIMIT 1`,
        [matchId],
      );
      return rows[0] ?? null;
    });

    if (
      plan === null ||
      plan.tournament_group_id === null || plan.tournament_group_id === undefined ||
      dbString(plan.status) !== "completed" ||
      dbString(plan.planned_tournament_format) !== "groups_playoff" ||
      dbInt(plan.planned_auto_create_playoff ?? 0, "planned_auto_create_playoff") !== 1 ||
      plan.planned_qualifiers_per_group === null || plan.planned_qualifiers_per_group === undefined ||
      plan.planned_playoff_best_of_legs === null || plan.planned_playoff_best_of_legs === undefined
    ) return;

    const qualifiersPerGroup = dbInt(plan.planned_qualifiers_per_group, "planned_qualifiers_per_group");
    const bestOfLegs = dbInt(plan.planned_playoff_best_of_legs, "planned_playoff_best_of_legs");
    if (qualifiersPerGroup < 1 || qualifiersPerGroup > 16 || bestOfLegs < 1 || bestOfLegs > 21 || bestOfLegs % 2 === 0) return;
    await this.generateFromGroups(dbId(plan.tournament_id, "matches.tournament_id"), qualifiersPerGroup, bestOfLegs);
  }

  private async generateFromGroups(tournamentId: DbId, qualifiersPerGroup: number, bestOfLegs: number): Promise<void> {
    await this.sessions.withTransaction(async (sql) => {
      const tournament = await sql.query<QueryResultRow>(
        `SELECT CAST(id AS CHAR) AS id FROM ${this.table("tournaments")} WHERE id=? LIMIT 1 FOR UPDATE`,
        [tournamentId],
      );
      if (!tournament[0]) throw new DomainValidationError("tournament_not_found", "Turneringen finnes ikke.", 404);

      const existing = await sql.query<QueryResultRow>(
        `SELECT CAST(id AS CHAR) AS id FROM ${this.table("tournament_playoffs")} WHERE tournament_id=? LIMIT 1`,
        [tournamentId],
      );
      if (existing.length > 0) return;

      const counts = await this.groupMatchCounts(sql, tournamentId);
      if (counts.total < 1 || counts.open > 0) return;

      const groups = await sql.query<QueryResultRow>(
        `SELECT CAST(id AS CHAR) AS id,name,sort_order FROM ${this.table("tournament_groups")}
         WHERE tournament_id=? ORDER BY sort_order ASC`,
        [tournamentId],
      );
      if (groups.length === 0) {
        throw new DomainValidationError("group_tables_required", "Fant ingen gruppetabeller for turneringen.", 409);
      }

      const qualifiers: PlayoffQualifier[] = [];
      for (const group of groups) {
        const groupId = dbId(group.id, "tournament_groups.id");
        const standings = await this.groupStandings(sql, tournamentId, groupId);
        if (standings.length < qualifiersPerGroup) {
          throw new DomainValidationError(
            "not_enough_players_in_group",
            `${dbString(group.name)} har bare ${standings.length} spillere og kan ikke sende ${qualifiersPerGroup} videre.`,
            409,
          );
        }
        for (let index = 0; index < qualifiersPerGroup; index += 1) {
          const row = standings[index]!;
          qualifiers.push({
            player_id: row.player_id,
            display_name: row.display_name,
            seed_number: row.seed_number,
            source_group_id: groupId,
            source_group_name: dbString(group.name),
            source_group_position: index + 1,
            points: row.points,
            leg_diff: row.leg_diff,
            legs_won: row.legs_won,
          });
        }
      }

      const seeded = seedQualifiers(qualifiers);
      const size = bracketSize(seeded.length);
      const rounds = roundCount(size);
      const playoff = await sql.execute(
        `INSERT INTO ${this.table("tournament_playoffs")}
         (tournament_id,qualifiers_per_group,bracket_size,best_of_legs,status)
         VALUES (?,?,?, ?,"ready")`,
        [tournamentId, qualifiersPerGroup, size, bestOfLegs],
      );
      const playoffId = requireInsertId(playoff, "tournament_playoffs");

      for (const qualifier of seeded) {
        await sql.execute(
          `INSERT INTO ${this.table("tournament_playoff_entries")}
           (playoff_id,player_id,seed_number,source_group_id,source_group_position,source_points,source_leg_diff,source_legs_won)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            playoffId,
            qualifier.player_id,
            qualifier.playoff_seed,
            qualifier.source_group_id,
            qualifier.source_group_position,
            qualifier.points,
            qualifier.leg_diff,
            qualifier.legs_won,
          ],
        );
      }

      await this.insertNodes(sql, playoffId, size, rounds);
      await this.seedFirstRound(sql, playoffId, size, seeded);
      await this.materializeFirstRound(sql, playoffId, tournamentId, bestOfLegs, size);
      await this.propagateResolvedNodes(sql, playoffId, tournamentId, bestOfLegs, size);
      await this.markNonQualifiersEliminated(sql, tournamentId, seeded.map((row) => row.player_id));
      await sql.execute(
        `UPDATE ${this.table("tournaments")} SET status="in_progress",end_at=NULL WHERE id=?`,
        [tournamentId],
      );
    });
  }

  private async reconcileByMatchId(matchId: DbId): Promise<void> {
    const tournamentId = await this.sessions.withConnection(async (sql) => {
      const rows = await sql.query<QueryResultRow>(
        `SELECT CAST(po.tournament_id AS CHAR) AS tournament_id
         FROM ${this.table("tournament_playoff_nodes")} n
         INNER JOIN ${this.table("tournament_playoffs")} po ON po.id=n.playoff_id
         WHERE n.match_id=? LIMIT 1`,
        [matchId],
      );
      return rows[0] ? dbId(rows[0].tournament_id, "tournament_playoffs.tournament_id") : null;
    });
    if (tournamentId !== null) await this.reconcileTournament(tournamentId);
  }

  private async reconcileTournament(tournamentId: DbId): Promise<void> {
    await this.sessions.withTransaction(async (sql) => {
      const playoffs = await sql.query<QueryResultRow>(
        `SELECT CAST(id AS CHAR) AS id,best_of_legs,bracket_size
         FROM ${this.table("tournament_playoffs")} WHERE tournament_id=? FOR UPDATE`,
        [tournamentId],
      );
      const playoff = playoffs[0];
      if (!playoff) return;
      const playoffId = dbId(playoff.id, "tournament_playoffs.id");
      const bestOfLegs = dbInt(playoff.best_of_legs, "tournament_playoffs.best_of_legs");
      const size = dbInt(playoff.bracket_size, "tournament_playoffs.bracket_size");
      await this.syncCompletedMatches(sql, playoffId);
      await this.propagateResolvedNodes(sql, playoffId, tournamentId, bestOfLegs, size);
      await this.markPlayoffLosersEliminated(sql, playoffId, tournamentId);
      await this.updatePlayoffLifecycle(sql, playoffId, tournamentId);
    });
  }

  private async groupMatchCounts(sql: SqlExecutor, tournamentId: DbId): Promise<{ total: number; open: number }> {
    const rows = await sql.query<QueryResultRow>(
      `SELECT COUNT(*) AS total,SUM(CASE WHEN status<>"completed" THEN 1 ELSE 0 END) AS open_count
       FROM ${this.table("matches")} WHERE tournament_id=? AND tournament_group_id IS NOT NULL`,
      [tournamentId],
    );
    return {
      total: dbInt(rows[0]?.total ?? 0, "group_matches.total"),
      open: dbInt(rows[0]?.open_count ?? 0, "group_matches.open_count"),
    };
  }

  private async groupStandings(sql: SqlExecutor, tournamentId: DbId, groupId: DbId): Promise<GroupStanding[]> {
    const rows = await sql.query<QueryResultRow>(
      `SELECT CAST(p.id AS CHAR) AS player_id,p.display_name,gp.seed_number,
              COUNT(DISTINCT CASE WHEN m.status="completed" THEN m.id END) AS played,
              COUNT(DISTINCT CASE WHEN m.status="completed" AND m.winner_player_id=p.id THEN m.id END) AS wins,
              COUNT(DISTINCT CASE WHEN m.status="completed" AND m.winner_player_id IS NULL THEN m.id END) AS draws,
              COUNT(DISTINCT CASE WHEN m.status="completed" AND m.winner_player_id IS NOT NULL AND m.winner_player_id<>p.id THEN m.id END) AS losses,
              COUNT(DISTINCT CASE WHEN l.winner_player_id=p.id THEN l.id END) AS legs_won,
              COUNT(DISTINCT CASE WHEN l.winner_player_id IS NOT NULL AND l.winner_player_id<>p.id THEN l.id END) AS legs_lost,
              COALESCE((SELECT ROUND(COALESCE(
                SUM(ms.average * COALESCE(ms.darts_thrown,0)) / NULLIF(SUM(COALESCE(ms.darts_thrown,0)),0),AVG(ms.average)
              ),2)
                FROM ${this.table("match_statistics")} ms
                INNER JOIN ${this.table("matches")} sm ON sm.id=ms.match_id
                WHERE ms.player_id=p.id AND sm.tournament_id=? AND sm.tournament_group_id=?
                  AND sm.status="completed" AND ms.average IS NOT NULL),0) AS three_dart_average
       FROM ${this.table("tournament_group_players")} gp
       INNER JOIN ${this.table("tournament_players")} tp ON tp.id=gp.tournament_player_id
       INNER JOIN ${this.table("players")} p ON p.id=tp.player_id
       LEFT JOIN ${this.table("matches")} m ON m.tournament_id=? AND m.tournament_group_id=?
         AND (m.player_a_id=p.id OR m.player_b_id=p.id)
       LEFT JOIN ${this.table("legs")} l ON l.match_id=m.id
       WHERE gp.group_id=?
       GROUP BY p.id,p.display_name,gp.seed_number`,
      [tournamentId, groupId, tournamentId, groupId, groupId],
    );

    const normalized: GroupStanding[] = rows.map((row) => {
      const wins = dbInt(row.wins ?? 0, "standings.wins");
      const draws = dbInt(row.draws ?? 0, "standings.draws");
      const legsWon = dbInt(row.legs_won ?? 0, "standings.legs_won");
      const legsLost = dbInt(row.legs_lost ?? 0, "standings.legs_lost");
      return {
        player_id: dbId(row.player_id, "standings.player_id"),
        display_name: dbString(row.display_name),
        seed_number: nullableInt(row.seed_number, "standings.seed_number"),
        played: dbInt(row.played ?? 0, "standings.played"),
        wins,
        draws,
        losses: dbInt(row.losses ?? 0, "standings.losses"),
        legs_won: legsWon,
        legs_lost: legsLost,
        three_dart_average: dbNumber(row.three_dart_average ?? 0, "standings.three_dart_average"),
        points: (wins * 2) + draws,
        leg_diff: legsWon - legsLost,
        head_to_head_points: 0,
      };
    });

    normalized.sort(baseStandingOrder);
    const ranked: GroupStanding[] = [];
    for (let index = 0; index < normalized.length;) {
      const first = normalized[index]!;
      const bucket: GroupStanding[] = [first];
      let cursor = index + 1;
      while (
        cursor < normalized.length &&
        normalized[cursor]!.points === first.points &&
        normalized[cursor]!.leg_diff === first.leg_diff
      ) {
        bucket.push(normalized[cursor]!);
        cursor += 1;
      }
      if (bucket.length > 1) {
        const headToHead = await this.headToHeadPoints(sql, tournamentId, groupId, bucket.map((row) => row.player_id));
        const decorated = bucket.map((row) => ({ ...row, head_to_head_points: headToHead.get(row.player_id) ?? 0 }));
        decorated.sort(tiedStandingOrder);
        ranked.push(...decorated);
      } else {
        ranked.push(...bucket);
      }
      index = cursor;
    }
    return ranked;
  }

  private async headToHeadPoints(
    sql: SqlExecutor,
    tournamentId: DbId,
    groupId: DbId,
    playerIds: readonly DbId[],
  ): Promise<ReadonlyMap<DbId, number>> {
    if (playerIds.length < 2) return new Map();
    const placeholders = playerIds.map(() => "?").join(",");
    const rows = await sql.query<QueryResultRow>(
      `SELECT CAST(m.player_a_id AS CHAR) AS player_a_id,
              CAST(m.player_b_id AS CHAR) AS player_b_id,
              CAST(m.winner_player_id AS CHAR) AS winner_player_id
       FROM ${this.table("matches")} m
       WHERE m.tournament_id=? AND m.status="completed" AND m.tournament_group_id=?
         AND m.player_a_id IN (${placeholders}) AND m.player_b_id IN (${placeholders})`,
      [tournamentId, groupId, ...playerIds, ...playerIds],
    );
    const points = new Map<DbId, number>(playerIds.map((id) => [id, 0]));
    for (const row of rows) {
      const a = dbId(row.player_a_id, "head_to_head.player_a_id");
      const b = dbId(row.player_b_id, "head_to_head.player_b_id");
      const winner = nullableDbId(row.winner_player_id, "head_to_head.winner_player_id");
      if (winner === null) {
        points.set(a, (points.get(a) ?? 0) + 1);
        points.set(b, (points.get(b) ?? 0) + 1);
      } else {
        points.set(winner, (points.get(winner) ?? 0) + 2);
      }
    }
    return points;
  }

  private async insertNodes(sql: SqlExecutor, playoffId: DbId, size: number, rounds: number): Promise<void> {
    for (let round = 1; round <= rounds; round += 1) {
      const matchesInRound = Math.trunc(size / (2 ** round));
      const label = roundLabel(size, round);
      for (let position = 1; position <= matchesInRound; position += 1) {
        await sql.execute(
          `INSERT INTO ${this.table("tournament_playoff_nodes")}
           (playoff_id,round_number,position,round_label,status) VALUES (?,?,?, ?,"waiting")`,
          [playoffId, round, position, label],
        );
      }
    }
  }

  private async seedFirstRound(
    sql: SqlExecutor,
    playoffId: DbId,
    size: number,
    qualifiers: readonly PlayoffQualifier[],
  ): Promise<void> {
    const bySeed = new Map<number, DbId>();
    for (const qualifier of qualifiers) bySeed.set(qualifier.playoff_seed!, qualifier.player_id);
    const order = seedOrder(size);
    const pairs = Math.trunc(size / 2);
    for (let position = 1; position <= pairs; position += 1) {
      const a = bySeed.get(order[(position - 1) * 2]!) ?? null;
      const b = bySeed.get(order[((position - 1) * 2) + 1]!) ?? null;
      await sql.execute(
        `UPDATE ${this.table("tournament_playoff_nodes")}
         SET player_a_id=?,player_b_id=? WHERE playoff_id=? AND round_number=1 AND position=?`,
        [a, b, playoffId, position],
      );
    }
  }

  private async materializeFirstRound(
    sql: SqlExecutor,
    playoffId: DbId,
    tournamentId: DbId,
    bestOfLegs: number,
    size: number,
  ): Promise<void> {
    for (const node of await this.nodesForRound(sql, playoffId, 1)) {
      const a = nullableDbId(node.player_a_id, "playoff_node.player_a_id");
      const b = nullableDbId(node.player_b_id, "playoff_node.player_b_id");
      if (a !== null && b !== null) {
        const matchId = await this.createPlayoffMatch(
          sql,
          tournamentId,
          bestOfLegs,
          size,
          1,
          dbInt(node.position, "playoff_node.position"),
          a,
          b,
        );
        await sql.execute(
          `UPDATE ${this.table("tournament_playoff_nodes")} SET match_id=?,status="ready" WHERE id=?`,
          [matchId, dbId(node.id, "playoff_node.id")],
        );
      } else if (a !== null || b !== null) {
        await sql.execute(
          `UPDATE ${this.table("tournament_playoff_nodes")} SET winner_player_id=?,status="bye" WHERE id=?`,
          [a ?? b, dbId(node.id, "playoff_node.id")],
        );
      }
    }
  }

  private async propagateResolvedNodes(
    sql: SqlExecutor,
    playoffId: DbId,
    tournamentId: DbId,
    bestOfLegs: number,
    size: number,
  ): Promise<void> {
    const rounds = roundCount(size);
    for (let round = 2; round <= rounds; round += 1) {
      for (const node of await this.nodesForRound(sql, playoffId, round)) {
        const position = dbInt(node.position, "playoff_node.position");
        const left = await this.nodeByPosition(sql, playoffId, round - 1, ((position - 1) * 2) + 1);
        const right = await this.nodeByPosition(sql, playoffId, round - 1, ((position - 1) * 2) + 2);
        const a = left ? nullableDbId(left.winner_player_id, "left.winner_player_id") : null;
        const b = right ? nullableDbId(right.winner_player_id, "right.winner_player_id") : null;
        if (a === null || b === null || nullableDbId(node.match_id, "playoff_node.match_id") !== null) continue;
        const matchId = await this.createPlayoffMatch(sql, tournamentId, bestOfLegs, size, round, position, a, b);
        await sql.execute(
          `UPDATE ${this.table("tournament_playoff_nodes")}
           SET player_a_id=?,player_b_id=?,match_id=?,status="ready" WHERE id=?`,
          [a, b, matchId, dbId(node.id, "playoff_node.id")],
        );
      }
    }
  }

  private async createPlayoffMatch(
    sql: SqlExecutor,
    tournamentId: DbId,
    bestOfLegs: number,
    size: number,
    round: number,
    position: number,
    playerA: DbId,
    playerB: DbId,
  ): Promise<DbId> {
    const label = roundLabel(size, round);
    const matchesInRound = Math.trunc(size / (2 ** round));
    const concreteRoundLabel = matchesInRound > 1 ? `${label} ${position}` : label;
    const result = await sql.execute(
      `INSERT INTO ${this.table("matches")}
       (tournament_id,tournament_group_id,round_label,round_number,bracket_label,status,best_of_legs,legs_to_win,player_a_id,player_b_id)
       VALUES (?,NULL,?,?,"Sluttspill","pending",?,?,?,?)`,
      [tournamentId, concreteRoundLabel, 100 + round, bestOfLegs, Math.trunc(bestOfLegs / 2) + 1, playerA, playerB],
    );
    return requireInsertId(result, "playoff match");
  }

  private async nodesForRound(sql: SqlExecutor, playoffId: DbId, round: number): Promise<readonly NodeRow[]> {
    return sql.query<NodeRow>(
      `SELECT CAST(id AS CHAR) AS id,CAST(playoff_id AS CHAR) AS playoff_id,round_number,position,
              CAST(player_a_id AS CHAR) AS player_a_id,CAST(player_b_id AS CHAR) AS player_b_id,
              CAST(match_id AS CHAR) AS match_id,CAST(winner_player_id AS CHAR) AS winner_player_id,status
       FROM ${this.table("tournament_playoff_nodes")}
       WHERE playoff_id=? AND round_number=? ORDER BY position ASC`,
      [playoffId, round],
    );
  }

  private async nodeByPosition(
    sql: SqlExecutor,
    playoffId: DbId,
    round: number,
    position: number,
  ): Promise<NodeRow | null> {
    const rows = await sql.query<NodeRow>(
      `SELECT CAST(id AS CHAR) AS id,CAST(playoff_id AS CHAR) AS playoff_id,round_number,position,
              CAST(player_a_id AS CHAR) AS player_a_id,CAST(player_b_id AS CHAR) AS player_b_id,
              CAST(match_id AS CHAR) AS match_id,CAST(winner_player_id AS CHAR) AS winner_player_id,status
       FROM ${this.table("tournament_playoff_nodes")}
       WHERE playoff_id=? AND round_number=? AND position=? LIMIT 1`,
      [playoffId, round, position],
    );
    return rows[0] ?? null;
  }

  private async syncCompletedMatches(sql: SqlExecutor, playoffId: DbId): Promise<void> {
    const rows = await sql.query<NodeRow>(
      `SELECT CAST(n.id AS CHAR) AS id,n.round_number,n.position,
              CAST(n.winner_player_id AS CHAR) AS winner_player_id,
              m.status AS match_status,CAST(m.winner_player_id AS CHAR) AS match_winner
       FROM ${this.table("tournament_playoff_nodes")} n
       INNER JOIN ${this.table("matches")} m ON m.id=n.match_id
       WHERE n.playoff_id=?`,
      [playoffId],
    );
    for (const row of rows) {
      const nodeId = dbId(row.id, "playoff_node.id");
      const matchWinner = nullableDbId(row.match_winner, "matches.winner_player_id");
      if (dbString(row.match_status) === "completed" && matchWinner !== null) {
        await sql.execute(
          `UPDATE ${this.table("tournament_playoff_nodes")} SET winner_player_id=?,status="completed" WHERE id=?`,
          [matchWinner, nodeId],
        );
        continue;
      }
      if (nullableDbId(row.winner_player_id, "playoff_node.winner_player_id") !== null && dbString(row.match_status) !== "completed") {
        await this.invalidateAncestors(
          sql,
          playoffId,
          dbInt(row.round_number, "playoff_node.round_number"),
          dbInt(row.position, "playoff_node.position"),
        );
        await sql.execute(
          `UPDATE ${this.table("tournament_playoff_nodes")} SET winner_player_id=NULL,status="ready" WHERE id=?`,
          [nodeId],
        );
      }
    }
  }

  private async nodeByMatchId(sql: SqlExecutor, matchId: DbId, forUpdate: boolean): Promise<NodeRow | null> {
    const rows = await sql.query<NodeRow>(
      `SELECT CAST(n.id AS CHAR) AS id,CAST(n.playoff_id AS CHAR) AS playoff_id,
              CAST(po.tournament_id AS CHAR) AS tournament_id,n.round_number,n.position,
              CAST(n.match_id AS CHAR) AS match_id,CAST(n.winner_player_id AS CHAR) AS winner_player_id,n.status
       FROM ${this.table("tournament_playoff_nodes")} n
       INNER JOIN ${this.table("tournament_playoffs")} po ON po.id=n.playoff_id
       WHERE n.match_id=? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
      [matchId],
    );
    return rows[0] ?? null;
  }

  private async parentNode(sql: SqlExecutor, playoffId: DbId, round: number, position: number): Promise<NodeRow | null> {
    const rows = await sql.query<NodeRow>(
      `SELECT CAST(n.id AS CHAR) AS id,CAST(n.playoff_id AS CHAR) AS playoff_id,n.round_number,n.position,
              CAST(n.player_a_id AS CHAR) AS player_a_id,CAST(n.player_b_id AS CHAR) AS player_b_id,
              CAST(n.match_id AS CHAR) AS match_id,CAST(n.winner_player_id AS CHAR) AS winner_player_id,n.status,
              m.status AS match_status,CAST(m.kiosk_id AS CHAR) AS kiosk_id
       FROM ${this.table("tournament_playoff_nodes")} n
       LEFT JOIN ${this.table("matches")} m ON m.id=n.match_id
       WHERE n.playoff_id=? AND n.round_number=? AND n.position=? LIMIT 1`,
      [playoffId, round + 1, Math.trunc((position + 1) / 2)],
    );
    return rows[0] ?? null;
  }

  private async invalidateAncestors(
    sql: SqlExecutor,
    playoffId: DbId,
    round: number,
    position: number,
  ): Promise<void> {
    const parent = await this.parentNode(sql, playoffId, round, position);
    if (parent === null) return;
    const parentId = dbId(parent.id, "parent.id");
    const matchId = nullableDbId(parent.match_id, "parent.match_id");
    if (matchId !== null) {
      if (dbString(parent.match_status) !== "pending" || nullableDbId(parent.kiosk_id, "parent.kiosk_id") !== null) {
        throw new DomainValidationError(
          "playoff_downstream_started",
          "Kan ikke rulle tilbake sluttspillet fordi neste kamp allerede er kalt opp eller startet.",
          409,
        );
      }
      await sql.execute(
        `UPDATE ${this.table("tournament_playoff_nodes")}
         SET player_a_id=NULL,player_b_id=NULL,match_id=NULL,winner_player_id=NULL,status="waiting" WHERE id=?`,
        [parentId],
      );
      await sql.execute(
        `DELETE FROM ${this.table("matches")} WHERE id=? AND status="pending"`,
        [matchId],
      );
    } else {
      await sql.execute(
        `UPDATE ${this.table("tournament_playoff_nodes")}
         SET player_a_id=NULL,player_b_id=NULL,winner_player_id=NULL,status="waiting" WHERE id=?`,
        [parentId],
      );
    }
    await this.invalidateAncestors(
      sql,
      playoffId,
      dbInt(parent.round_number, "parent.round_number"),
      dbInt(parent.position, "parent.position"),
    );
  }

  private async markNonQualifiersEliminated(
    sql: SqlExecutor,
    tournamentId: DbId,
    qualifiedPlayerIds: readonly DbId[],
  ): Promise<void> {
    if (qualifiedPlayerIds.length === 0) return;
    const placeholders = qualifiedPlayerIds.map(() => "?").join(",");
    await sql.execute(
      `UPDATE ${this.table("tournament_players")} SET status="eliminated"
       WHERE tournament_id=? AND player_id NOT IN (${placeholders})
         AND status IN ("registered","checked_in","paused")`,
      [tournamentId, ...qualifiedPlayerIds],
    );
  }

  private async markPlayoffLosersEliminated(sql: SqlExecutor, playoffId: DbId, tournamentId: DbId): Promise<void> {
    const rows = await sql.query<QueryResultRow>(
      `SELECT CAST(m.player_a_id AS CHAR) AS player_a_id,CAST(m.player_b_id AS CHAR) AS player_b_id,
              CAST(m.winner_player_id AS CHAR) AS winner_player_id
       FROM ${this.table("tournament_playoff_nodes")} n
       INNER JOIN ${this.table("matches")} m ON m.id=n.match_id
       WHERE n.playoff_id=? AND m.status="completed" AND m.winner_player_id IS NOT NULL`,
      [playoffId],
    );
    for (const row of rows) {
      const winner = dbId(row.winner_player_id, "matches.winner_player_id");
      const a = dbId(row.player_a_id, "matches.player_a_id");
      const b = dbId(row.player_b_id, "matches.player_b_id");
      await sql.execute(
        `UPDATE ${this.table("tournament_players")} SET status="eliminated" WHERE tournament_id=? AND player_id=?`,
        [tournamentId, winner === a ? b : a],
      );
    }
  }

  private async updatePlayoffLifecycle(sql: SqlExecutor, playoffId: DbId, tournamentId: DbId): Promise<void> {
    const rows = await sql.query<QueryResultRow>(
      `SELECT CAST(winner_player_id AS CHAR) AS winner_player_id
       FROM ${this.table("tournament_playoff_nodes")}
       WHERE playoff_id=? ORDER BY round_number DESC,position ASC LIMIT 1`,
      [playoffId],
    );
    const champion = rows[0] ? nullableDbId(rows[0].winner_player_id, "final.winner_player_id") : null;
    if (champion !== null) {
      await sql.execute(
        `UPDATE ${this.table("tournament_playoffs")} SET status="completed",champion_player_id=? WHERE id=?`,
        [champion, playoffId],
      );
      await sql.execute(
        `UPDATE ${this.table("tournaments")} SET status="completed",end_at=COALESCE(end_at,NOW()) WHERE id=?`,
        [tournamentId],
      );
      return;
    }
    await sql.execute(
      `UPDATE ${this.table("tournament_playoffs")} SET status="in_progress",champion_player_id=NULL WHERE id=?`,
      [playoffId],
    );
    await sql.execute(
      `UPDATE ${this.table("tournaments")} SET status="in_progress",end_at=NULL WHERE id=?`,
      [tournamentId],
    );
  }

  private table(name: string): string {
    return `\`${this.runtimePrefix}${name}\``;
  }
}

function baseStandingOrder(a: GroupStanding, b: GroupStanding): number {
  let result = b.points - a.points;
  if (result !== 0) return result;
  result = b.leg_diff - a.leg_diff;
  return result !== 0 ? result : compareNames(a.display_name, b.display_name);
}

function tiedStandingOrder(a: GroupStanding, b: GroupStanding): number {
  let result = b.head_to_head_points - a.head_to_head_points;
  if (result !== 0) return result;
  result = b.three_dart_average - a.three_dart_average;
  return result !== 0 ? result : compareNames(a.display_name, b.display_name);
}

function compareNames(a: string, b: string): number {
  const left = a.toLocaleLowerCase("nb-NO");
  const right = b.toLocaleLowerCase("nb-NO");
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireInsertId(result: { insertId?: DbId }, name: string): DbId {
  if (!result.insertId) throw new Error(`${name} insert did not return an id`);
  return result.insertId;
}

function dbId(value: unknown, field: string): DbId {
  if (typeof value !== "string") throw new Error(`${field} must be returned from MySQL as a decimal string`);
  return asDbId(value);
}

function nullableDbId(value: unknown, field: string): DbId | null {
  if (value === null || value === undefined) return null;
  return dbId(value, field);
}

function dbInt(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} must be a safe integer`);
  return parsed;
}

function nullableInt(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return dbInt(value, field);
}

function dbNumber(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be numeric`);
  return parsed;
}

function dbString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}
