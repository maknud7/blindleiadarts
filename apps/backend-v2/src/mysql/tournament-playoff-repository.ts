import { DomainValidationError } from "../domain/errors.js";
import { SingleEliminationService, type PlayoffQualifier } from "../service/single-elimination-service.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

interface PlayoffRow extends QueryResultRow {
  id: unknown;
  tournament_id: unknown;
  qualifiers_per_group: unknown;
  bracket_size: unknown;
  best_of_legs: unknown;
  status: unknown;
  champion_player_id: unknown;
  club_id: unknown;
  tournament_name: unknown;
  tournament_status: unknown;
}

interface GroupRow extends QueryResultRow {
  id: unknown;
  name: unknown;
  sort_order: unknown;
}

interface StandingRow extends Record<string, unknown> {
  player_id: string;
  display_name: string;
  seed_number: number | null;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  legs_won: number;
  legs_lost: number;
  three_dart_average: number;
  points: number;
  leg_diff: number;
  head_to_head_points: number;
  position?: number;
}

export class MySqlTournamentPlayoffRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly prefix: TablePrefix,
    private readonly bracket = new SingleEliminationService(),
  ) {}

  async getBracket(tournamentIdInput: unknown): Promise<Record<string, unknown> | null> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withConnection((db) => this.getBracketWith(db, tournamentId));
  }

  async generateFromGroups(
    tournamentIdInput: unknown,
    qualifiersPerGroupInput: unknown,
    bestOfLegsInput: unknown,
  ): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    const qualifiersPerGroup = positiveInt(qualifiersPerGroupInput, "qualifiers_per_group");
    const bestOfLegs = positiveInt(bestOfLegsInput, "best_of_legs");
    if (qualifiersPerGroup > 16) {
      throw new DomainValidationError("invalid_qualifiers_per_group", "Antall videre per gruppe må være mellom 1 og 16.");
    }
    if (bestOfLegs > 21 || bestOfLegs % 2 === 0) {
      throw new DomainValidationError("invalid_best_of_legs", "Best of legs må være et oddetall mellom 1 og 21.");
    }

    await this.sessions.withTransaction(async (db) => {
      await this.requireTournamentWith(db, tournamentId);
      if (await this.findByTournamentIdWith(db, tournamentId)) {
        throw new DomainValidationError("playoff_already_exists", "Sluttspillet er allerede opprettet for denne turneringen.", 409);
      }

      const countRows = await db.query<QueryResultRow>(
        `SELECT COUNT(*) AS total,SUM(CASE WHEN status<>'completed' THEN 1 ELSE 0 END) AS open_count
           FROM \`${this.prefix}matches\` WHERE tournament_id=? AND tournament_group_id IS NOT NULL`,
        [tournamentId],
      );
      const total = numberValue(countRows[0]?.total);
      const open = numberValue(countRows[0]?.open_count);
      if (total < 1) {
        throw new DomainValidationError("group_matches_required", "Gruppespill må være generert før sluttspill kan opprettes.", 409);
      }
      if (open > 0) {
        throw new DomainValidationError("group_stage_not_completed", "Alle gruppekamper må være ferdige før sluttspillet kan opprettes.", 409);
      }

      const groups = await db.query<GroupRow>(
        `SELECT id,name,sort_order FROM \`${this.prefix}tournament_groups\` WHERE tournament_id=? ORDER BY sort_order,id`,
        [tournamentId],
      );
      if (groups.length === 0) {
        throw new DomainValidationError("group_tables_required", "Fant ingen gruppetabeller for turneringen.", 409);
      }

      const qualifiers: PlayoffQualifier[] = [];
      for (const group of groups) {
        const groupId = requiredId(group.id, "group_id");
        const standings = await this.groupStandingsWith(db, tournamentId, groupId);
        if (standings.length < qualifiersPerGroup) {
          throw new DomainValidationError(
            "not_enough_players_in_group",
            `${String(group.name ?? "Gruppen")} har bare ${standings.length} spillere og kan ikke sende ${qualifiersPerGroup} videre.`,
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
            source_group_name: String(group.name ?? ""),
            source_group_position: index + 1,
            points: row.points,
            leg_diff: row.leg_diff,
            legs_won: row.legs_won,
          });
        }
      }

      const seeded = this.bracket.seedQualifiers(qualifiers);
      const bracketSize = this.bracket.bracketSize(seeded.length);
      const roundCount = this.bracket.roundCount(bracketSize);
      const insert = await db.execute(
        `INSERT INTO \`${this.prefix}tournament_playoffs\`
          (tournament_id,qualifiers_per_group,bracket_size,best_of_legs,status)
         VALUES (?,?,?,?,'ready')`,
        [tournamentId, qualifiersPerGroup, bracketSize, bestOfLegs],
      );
      const playoffId = requiredId(insert.insertId, "playoff_id");

      for (const qualifier of seeded) {
        await db.execute(
          `INSERT INTO \`${this.prefix}tournament_playoff_entries\`
            (playoff_id,player_id,seed_number,source_group_id,source_group_position,source_points,source_leg_diff,source_legs_won)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            playoffId,
            qualifier.player_id,
            qualifier.playoff_seed!,
            qualifier.source_group_id,
            qualifier.source_group_position,
            qualifier.points,
            qualifier.leg_diff,
            qualifier.legs_won,
          ],
        );
      }

      for (let round = 1; round <= roundCount; round += 1) {
        const matchesInRound = bracketSize / (2 ** round);
        const label = this.bracket.roundLabel(bracketSize, round);
        for (let position = 1; position <= matchesInRound; position += 1) {
          await db.execute(
            `INSERT INTO \`${this.prefix}tournament_playoff_nodes\`
              (playoff_id,round_number,position,round_label,status) VALUES (?,?,?,?,'waiting')`,
            [playoffId, round, position, label],
          );
        }
      }

      const bySeed = new Map<number, string>();
      for (const qualifier of seeded) bySeed.set(qualifier.playoff_seed!, qualifier.player_id);
      const order = this.bracket.seedOrder(bracketSize);
      for (let position = 1; position <= bracketSize / 2; position += 1) {
        const a = bySeed.get(order[(position - 1) * 2]!) ?? null;
        const b = bySeed.get(order[((position - 1) * 2) + 1]!) ?? null;
        await db.execute(
          `UPDATE \`${this.prefix}tournament_playoff_nodes\`
              SET player_a_id=?,player_b_id=? WHERE playoff_id=? AND round_number=1 AND position=?`,
          [a, b, playoffId, position],
        );
      }

      await this.materializeFirstRoundWith(db, playoffId, tournamentId, bestOfLegs, bracketSize);
      await this.propagateResolvedNodesWith(db, playoffId, tournamentId, bestOfLegs, bracketSize);
      await this.markNonQualifiersEliminatedWith(db, tournamentId, seeded.map((qualifier) => qualifier.player_id));
      await db.execute(
        `UPDATE \`${this.prefix}tournaments\` SET status='in_progress',end_at=NULL WHERE id=?`,
        [tournamentId],
      );
    });

    return (await this.getBracket(tournamentId)) ?? {
      tournament: { id: tournamentId },
      playoff: null,
      entries: [],
      rounds: [],
    };
  }

  async reconcileTournament(tournamentIdInput: unknown): Promise<Record<string, unknown> | null> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    const found = await this.sessions.withTransaction(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT * FROM \`${this.prefix}tournament_playoffs\` WHERE tournament_id=? FOR UPDATE`,
        [tournamentId],
      );
      const playoff = rows[0];
      if (!playoff) return false;
      const playoffId = requiredId(playoff.id, "playoff_id");
      const bestOfLegs = positiveInt(playoff.best_of_legs, "best_of_legs");
      const bracketSize = positiveInt(playoff.bracket_size, "bracket_size");
      await this.syncCompletedMatchesWith(db, playoffId);
      await this.propagateResolvedNodesWith(db, playoffId, tournamentId, bestOfLegs, bracketSize);
      await this.markPlayoffLosersEliminatedWith(db, playoffId, tournamentId);
      await this.updatePlayoffLifecycleWith(db, playoffId, tournamentId);
      return true;
    });
    return found ? this.getBracket(tournamentId) : null;
  }

  private async getBracketWith(db: SqlExecutor, tournamentId: string): Promise<Record<string, unknown> | null> {
    const playoff = await this.findByTournamentIdWith(db, tournamentId);
    if (!playoff) return null;
    const playoffId = requiredId(playoff.id, "playoff_id");
    const entries = await db.query<QueryResultRow>(
      `SELECT e.player_id,p.display_name,p.nickname,e.seed_number,e.source_group_id,g.name AS source_group_name,
              e.source_group_position,e.source_points AS points,e.source_leg_diff AS leg_diff,e.source_legs_won AS legs_won
         FROM \`${this.prefix}tournament_playoff_entries\` e
         INNER JOIN \`${this.prefix}players\` p ON p.id=e.player_id
         INNER JOIN \`${this.prefix}tournament_groups\` g ON g.id=e.source_group_id
        WHERE e.playoff_id=? ORDER BY e.seed_number`,
      [playoffId],
    );
    const nodes = await db.query<QueryResultRow>(
      `SELECT n.id,n.round_number,n.position,n.round_label,n.status AS node_status,
              n.player_a_id,pa.display_name AS player_a_name,n.player_b_id,pb.display_name AS player_b_name,
              n.match_id,m.status AS match_status,m.kiosk_id,k.board_number,n.winner_player_id,winner.display_name AS winner_name
         FROM \`${this.prefix}tournament_playoff_nodes\` n
         LEFT JOIN \`${this.prefix}players\` pa ON pa.id=n.player_a_id
         LEFT JOIN \`${this.prefix}players\` pb ON pb.id=n.player_b_id
         LEFT JOIN \`${this.prefix}matches\` m ON m.id=n.match_id
         LEFT JOIN \`${this.prefix}kiosks\` k ON k.id=m.kiosk_id
         LEFT JOIN \`${this.prefix}players\` winner ON winner.id=n.winner_player_id
        WHERE n.playoff_id=? ORDER BY n.round_number,n.position`,
      [playoffId],
    );
    const rounds = new Map<number, { round_number: number; label: string; nodes: Record<string, unknown>[] }>();
    for (const node of nodes) {
      const roundNumber = numberValue(node.round_number);
      let round = rounds.get(roundNumber);
      if (!round) {
        round = { round_number: roundNumber, label: String(node.round_label ?? ""), nodes: [] };
        rounds.set(roundNumber, round);
      }
      round.nodes.push({
        ...node,
        id: requiredId(node.id, "playoff_node_id"),
        round_number: roundNumber,
        position: numberValue(node.position),
        player_a_id: nullableId(node.player_a_id),
        player_b_id: nullableId(node.player_b_id),
        match_id: nullableId(node.match_id),
        kiosk_id: nullableId(node.kiosk_id),
        board_number: nullableNumber(node.board_number),
        winner_player_id: nullableId(node.winner_player_id),
        status: node.match_status ? String(node.match_status) : String(node.node_status ?? ""),
        match_status: undefined,
        node_status: undefined,
      });
    }
    return {
      tournament: {
        id: tournamentId,
        club_id: requiredId(playoff.club_id, "club_id"),
        name: String(playoff.tournament_name ?? ""),
        status: String(playoff.tournament_status ?? ""),
      },
      playoff: {
        ...playoff,
        id: playoffId,
        tournament_id: tournamentId,
        qualifiers_per_group: numberValue(playoff.qualifiers_per_group),
        bracket_size: numberValue(playoff.bracket_size),
        best_of_legs: numberValue(playoff.best_of_legs),
        club_id: requiredId(playoff.club_id, "club_id"),
        champion_player_id: nullableId(playoff.champion_player_id),
      },
      entries: entries.map((entry) => ({
        ...entry,
        player_id: requiredId(entry.player_id, "player_id"),
        seed_number: numberValue(entry.seed_number),
        source_group_id: requiredId(entry.source_group_id, "group_id"),
        source_group_position: numberValue(entry.source_group_position),
        points: numberValue(entry.points),
        leg_diff: numberValue(entry.leg_diff),
        legs_won: numberValue(entry.legs_won),
      })),
      rounds: [...rounds.values()],
    };
  }

  private async findByTournamentIdWith(db: SqlExecutor, tournamentId: string): Promise<PlayoffRow | null> {
    const rows = await db.query<PlayoffRow>(
      `SELECT po.id,po.tournament_id,po.format,po.qualifiers_per_group,po.bracket_size,po.best_of_legs,po.status,
              po.champion_player_id,champion.display_name AS champion_name,po.created_at,po.updated_at,
              t.club_id,t.name AS tournament_name,t.status AS tournament_status
         FROM \`${this.prefix}tournament_playoffs\` po
         INNER JOIN \`${this.prefix}tournaments\` t ON t.id=po.tournament_id
         LEFT JOIN \`${this.prefix}players\` champion ON champion.id=po.champion_player_id
        WHERE po.tournament_id=? LIMIT 1`,
      [tournamentId],
    );
    return rows[0] ?? null;
  }

  private async requireTournamentWith(db: SqlExecutor, tournamentId: string): Promise<QueryResultRow> {
    const rows = await db.query<QueryResultRow>(
      `SELECT id,club_id,name,status FROM \`${this.prefix}tournaments\` WHERE id=? LIMIT 1`,
      [tournamentId],
    );
    if (!rows[0]) throw new DomainValidationError("tournament_not_found", "Turneringen finnes ikke.", 404);
    return rows[0];
  }

  private async groupStandingsWith(db: SqlExecutor, tournamentId: string, groupId: string): Promise<StandingRow[]> {
    const rows = await db.query<QueryResultRow>(
      `SELECT p.id AS player_id,p.display_name,gp.seed_number,
              COUNT(DISTINCT CASE WHEN m.status='completed' THEN m.id END) AS played,
              COUNT(DISTINCT CASE WHEN m.status='completed' AND m.winner_player_id=p.id THEN m.id END) AS wins,
              COUNT(DISTINCT CASE WHEN m.status='completed' AND m.winner_player_id IS NULL THEN m.id END) AS draws,
              COUNT(DISTINCT CASE WHEN m.status='completed' AND m.winner_player_id IS NOT NULL AND m.winner_player_id<>p.id THEN m.id END) AS losses,
              COUNT(DISTINCT CASE WHEN l.winner_player_id=p.id THEN l.id END) AS legs_won,
              COUNT(DISTINCT CASE WHEN l.winner_player_id IS NOT NULL AND l.winner_player_id<>p.id THEN l.id END) AS legs_lost,
              COALESCE((SELECT ROUND(COALESCE(SUM(ms.average*COALESCE(ms.darts_thrown,0))/NULLIF(SUM(COALESCE(ms.darts_thrown,0)),0),AVG(ms.average)),2)
                FROM \`${this.prefix}match_statistics\` ms INNER JOIN \`${this.prefix}matches\` sm ON sm.id=ms.match_id
               WHERE ms.player_id=p.id AND sm.tournament_id=? AND sm.tournament_group_id=? AND sm.status='completed' AND ms.average IS NOT NULL),0) AS three_dart_average
         FROM \`${this.prefix}tournament_group_players\` gp
         INNER JOIN \`${this.prefix}tournament_players\` tp ON tp.id=gp.tournament_player_id
         INNER JOIN \`${this.prefix}players\` p ON p.id=tp.player_id
         LEFT JOIN \`${this.prefix}matches\` m ON m.tournament_id=? AND m.tournament_group_id=? AND (m.player_a_id=p.id OR m.player_b_id=p.id)
         LEFT JOIN \`${this.prefix}legs\` l ON l.match_id=m.id
        WHERE gp.group_id=? GROUP BY p.id,p.display_name,gp.seed_number`,
      [tournamentId, groupId, tournamentId, groupId, groupId],
    );
    const standings: StandingRow[] = rows.map((row) => {
      const wins = numberValue(row.wins);
      const draws = numberValue(row.draws);
      const legsWon = numberValue(row.legs_won);
      const legsLost = numberValue(row.legs_lost);
      return {
        ...row,
        player_id: requiredId(row.player_id, "player_id"),
        display_name: String(row.display_name ?? ""),
        seed_number: nullableNumber(row.seed_number),
        played: numberValue(row.played),
        wins,
        draws,
        losses: numberValue(row.losses),
        legs_won: legsWon,
        legs_lost: legsLost,
        three_dart_average: numberValue(row.three_dart_average),
        points: (wins * 2) + draws,
        leg_diff: legsWon - legsLost,
        head_to_head_points: 0,
      };
    });
    standings.sort(baseStandingSort);

    const ranked: StandingRow[] = [];
    for (let index = 0; index < standings.length;) {
      let cursor = index + 1;
      while (cursor < standings.length && standings[cursor]!.points === standings[index]!.points && standings[cursor]!.leg_diff === standings[index]!.leg_diff) cursor += 1;
      const bucket = standings.slice(index, cursor);
      if (bucket.length > 1) {
        const headToHead = await this.headToHeadPointsWith(db, tournamentId, groupId, bucket.map((row) => row.player_id));
        for (const row of bucket) row.head_to_head_points = headToHead.get(row.player_id) ?? 0;
        bucket.sort((a, b) =>
          b.head_to_head_points - a.head_to_head_points ||
          b.three_dart_average - a.three_dart_average ||
          a.display_name.localeCompare(b.display_name, "nb", { sensitivity: "base" }),
        );
      }
      ranked.push(...bucket);
      index = cursor;
    }
    ranked.forEach((row, index) => { row.position = index + 1; });
    return ranked;
  }

  private async headToHeadPointsWith(db: SqlExecutor, tournamentId: string, groupId: string, playerIds: readonly string[]): Promise<Map<string, number>> {
    const points = new Map(playerIds.map((id) => [id, 0]));
    if (playerIds.length < 2) return points;
    const placeholders = playerIds.map(() => "?").join(",");
    const rows = await db.query<QueryResultRow>(
      `SELECT player_a_id,player_b_id,winner_player_id FROM \`${this.prefix}matches\`
        WHERE tournament_id=? AND tournament_group_id=? AND status='completed'
          AND player_a_id IN (${placeholders}) AND player_b_id IN (${placeholders})`,
      [tournamentId, groupId, ...playerIds, ...playerIds],
    );
    for (const row of rows) {
      const a = requiredId(row.player_a_id, "player_id");
      const b = requiredId(row.player_b_id, "player_id");
      const winner = nullableId(row.winner_player_id);
      if (winner === null) {
        points.set(a, (points.get(a) ?? 0) + 1);
        points.set(b, (points.get(b) ?? 0) + 1);
      } else {
        points.set(winner, (points.get(winner) ?? 0) + 2);
      }
    }
    return points;
  }

  private async materializeFirstRoundWith(db: SqlExecutor, playoffId: string, tournamentId: string, bestOfLegs: number, bracketSize: number): Promise<void> {
    const nodes = await this.nodesForRoundWith(db, playoffId, 1);
    for (const node of nodes) {
      const a = nullableId(node.player_a_id);
      const b = nullableId(node.player_b_id);
      const nodeId = requiredId(node.id, "playoff_node_id");
      if (a && b) {
        const matchId = await this.createPlayoffMatchWith(db, tournamentId, bestOfLegs, bracketSize, 1, numberValue(node.position), a, b);
        await db.execute(
          `UPDATE \`${this.prefix}tournament_playoff_nodes\` SET match_id=?,status='ready' WHERE id=?`,
          [matchId, nodeId],
        );
      } else if (a || b) {
        await db.execute(
          `UPDATE \`${this.prefix}tournament_playoff_nodes\` SET winner_player_id=?,status='bye' WHERE id=?`,
          [a ?? b, nodeId],
        );
      }
    }
  }

  private async propagateResolvedNodesWith(db: SqlExecutor, playoffId: string, tournamentId: string, bestOfLegs: number, bracketSize: number): Promise<void> {
    const roundCount = this.bracket.roundCount(bracketSize);
    for (let round = 2; round <= roundCount; round += 1) {
      const nodes = await this.nodesForRoundWith(db, playoffId, round);
      for (const node of nodes) {
        if (nullableId(node.match_id)) continue;
        const position = numberValue(node.position);
        const left = await this.nodeByPositionWith(db, playoffId, round - 1, ((position - 1) * 2) + 1);
        const right = await this.nodeByPositionWith(db, playoffId, round - 1, ((position - 1) * 2) + 2);
        const a = nullableId(left?.winner_player_id);
        const b = nullableId(right?.winner_player_id);
        if (!a || !b) continue;
        const matchId = await this.createPlayoffMatchWith(db, tournamentId, bestOfLegs, bracketSize, round, position, a, b);
        await db.execute(
          `UPDATE \`${this.prefix}tournament_playoff_nodes\`
              SET player_a_id=?,player_b_id=?,match_id=?,status='ready' WHERE id=?`,
          [a, b, matchId, requiredId(node.id, "playoff_node_id")],
        );
      }
    }
  }

  private async createPlayoffMatchWith(
    db: SqlExecutor,
    tournamentId: string,
    bestOfLegs: number,
    bracketSize: number,
    round: number,
    position: number,
    playerA: string,
    playerB: string,
  ): Promise<string> {
    const label = this.bracket.roundLabel(bracketSize, round);
    const matchesInRound = bracketSize / (2 ** round);
    const roundLabel = matchesInRound > 1 ? `${label} ${position}` : label;
    const result = await db.execute(
      `INSERT INTO \`${this.prefix}matches\`
        (tournament_id,tournament_group_id,round_label,round_number,bracket_label,status,best_of_legs,legs_to_win,player_a_id,player_b_id)
       VALUES (?,NULL,?,?,?,'pending',?,?,?,?)`,
      [tournamentId, roundLabel, 100 + round, "Sluttspill", bestOfLegs, Math.floor(bestOfLegs / 2) + 1, playerA, playerB],
    );
    return requiredId(result.insertId, "match_id");
  }

  private async nodesForRoundWith(db: SqlExecutor, playoffId: string, round: number): Promise<readonly QueryResultRow[]> {
    return db.query<QueryResultRow>(
      `SELECT * FROM \`${this.prefix}tournament_playoff_nodes\` WHERE playoff_id=? AND round_number=? ORDER BY position`,
      [playoffId, round],
    );
  }

  private async nodeByPositionWith(db: SqlExecutor, playoffId: string, round: number, position: number): Promise<QueryResultRow | null> {
    const rows = await db.query<QueryResultRow>(
      `SELECT * FROM \`${this.prefix}tournament_playoff_nodes\` WHERE playoff_id=? AND round_number=? AND position=? LIMIT 1`,
      [playoffId, round, position],
    );
    return rows[0] ?? null;
  }

  private async syncCompletedMatchesWith(db: SqlExecutor, playoffId: string): Promise<void> {
    const rows = await db.query<QueryResultRow>(
      `SELECT n.id,n.winner_player_id AS node_winner,m.status AS match_status,m.winner_player_id AS match_winner
         FROM \`${this.prefix}tournament_playoff_nodes\` n INNER JOIN \`${this.prefix}matches\` m ON m.id=n.match_id
        WHERE n.playoff_id=?`,
      [playoffId],
    );
    for (const row of rows) {
      if (row.match_status === "completed" && nullableId(row.match_winner)) {
        await db.execute(
          `UPDATE \`${this.prefix}tournament_playoff_nodes\` SET winner_player_id=?,status='completed' WHERE id=?`,
          [requiredId(row.match_winner, "winner_player_id"), requiredId(row.id, "playoff_node_id")],
        );
      }
    }
  }

  private async markNonQualifiersEliminatedWith(db: SqlExecutor, tournamentId: string, qualifiedPlayerIds: readonly string[]): Promise<void> {
    if (qualifiedPlayerIds.length === 0) return;
    const placeholders = qualifiedPlayerIds.map(() => "?").join(",");
    await db.execute(
      `UPDATE \`${this.prefix}tournament_players\` SET status='eliminated'
        WHERE tournament_id=? AND player_id NOT IN (${placeholders}) AND status IN ('registered','checked_in','paused')`,
      [tournamentId, ...qualifiedPlayerIds],
    );
  }

  private async markPlayoffLosersEliminatedWith(db: SqlExecutor, playoffId: string, tournamentId: string): Promise<void> {
    const rows = await db.query<QueryResultRow>(
      `SELECT m.player_a_id,m.player_b_id,m.winner_player_id
         FROM \`${this.prefix}tournament_playoff_nodes\` n INNER JOIN \`${this.prefix}matches\` m ON m.id=n.match_id
        WHERE n.playoff_id=? AND m.status='completed' AND m.winner_player_id IS NOT NULL`,
      [playoffId],
    );
    for (const row of rows) {
      const a = requiredId(row.player_a_id, "player_id");
      const b = requiredId(row.player_b_id, "player_id");
      const winner = requiredId(row.winner_player_id, "winner_player_id");
      const loser = winner === a ? b : a;
      await db.execute(
        `UPDATE \`${this.prefix}tournament_players\` SET status='eliminated' WHERE tournament_id=? AND player_id=?`,
        [tournamentId, loser],
      );
    }
  }

  private async updatePlayoffLifecycleWith(db: SqlExecutor, playoffId: string, tournamentId: string): Promise<void> {
    const rows = await db.query<QueryResultRow>(
      `SELECT winner_player_id FROM \`${this.prefix}tournament_playoff_nodes\`
        WHERE playoff_id=? ORDER BY round_number DESC,position ASC LIMIT 1`,
      [playoffId],
    );
    const champion = nullableId(rows[0]?.winner_player_id);
    if (champion) {
      await db.execute(
        `UPDATE \`${this.prefix}tournament_playoffs\` SET status='completed',champion_player_id=? WHERE id=?`,
        [champion, playoffId],
      );
      await db.execute(
        `UPDATE \`${this.prefix}tournaments\` SET status='completed',end_at=COALESCE(end_at,NOW()) WHERE id=?`,
        [tournamentId],
      );
      return;
    }
    await db.execute(
      `UPDATE \`${this.prefix}tournament_playoffs\` SET status='in_progress',champion_player_id=NULL WHERE id=?`,
      [playoffId],
    );
    await db.execute(
      `UPDATE \`${this.prefix}tournaments\` SET status='in_progress',end_at=NULL WHERE id=?`,
      [tournamentId],
    );
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

function positiveInt(value: unknown, field: string): number {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) throw new DomainValidationError(`invalid_${field}`, `${field} must be a positive integer.`);
  return normalized;
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

function baseStandingSort(a: StandingRow, b: StandingRow): number {
  return b.points - a.points || b.leg_diff - a.leg_diff || a.display_name.localeCompare(b.display_name, "nb", { sensitivity: "base" });
}
