import { DomainValidationError } from "../domain/errors.js";
import { TournamentGroupService, type TournamentSeedCandidate } from "../service/tournament-group-service.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

type RegistrationSource = "player" | "admin";

interface TournamentRow extends QueryResultRow {
  id: unknown;
  club_id: unknown;
  season_id: unknown;
  name: unknown;
  slug?: unknown;
  status: unknown;
  start_at: unknown;
  end_at: unknown;
  registration_opens_at: unknown;
  registration_closes_at: unknown;
  max_players: unknown;
  group_count: unknown;
  group_draw_mode: unknown;
  group_draw_seed?: unknown;
  group_drawn_at: unknown;
  registration_state?: unknown;
}

interface InternalGroup {
  id: string;
  name: string;
  players: Array<{ player_id: string }>;
}

export class MySqlTournamentRuntimeRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly prefix: TablePrefix,
    private readonly groupService = new TournamentGroupService(),
  ) {}

  async findTournament(tournamentIdInput: unknown): Promise<Record<string, unknown> | null> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withConnection(async (db) => {
      const tournament = await this.findTournamentWith(db, tournamentId);
      return tournament ? publicTournament(tournament) : null;
    });
  }

  async listRegistrationTournamentsByClubId(clubIdInput: unknown): Promise<Record<string, unknown>[]> {
    const clubId = requiredId(clubIdInput, "club_id");
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<TournamentRow>(
        `SELECT t.id, t.club_id, t.season_id, t.name, t.slug, t.status, t.start_at, t.end_at,
                t.registration_opens_at, t.registration_closes_at, t.max_players,
                t.group_count, t.group_draw_mode, t.group_drawn_at,
                COUNT(DISTINCT CASE WHEN tp.status IN ('registered','checked_in','paused') THEN tp.id END) AS registration_count,
                COUNT(DISTINCT CASE WHEN tp.status = 'waitlisted' THEN tp.id END) AS waitlist_count,
                ${registrationStateSql("t")} AS registration_state
           FROM \`${this.prefix}tournaments\` t
           LEFT JOIN \`${this.prefix}tournament_players\` tp ON tp.tournament_id=t.id
          WHERE t.club_id=? AND t.status <> 'archived'
          GROUP BY t.id, t.club_id, t.season_id, t.name, t.slug, t.status, t.start_at, t.end_at,
                   t.registration_opens_at, t.registration_closes_at, t.max_players,
                   t.group_count, t.group_draw_mode, t.group_drawn_at
          ORDER BY COALESCE(t.start_at, '2999-12-31 23:59:59') ASC, t.id DESC`,
        [clubId],
      );
      return rows.map((row) => ({
        ...publicTournament(row),
        registration_count: numberValue(row.registration_count),
        waitlist_count: numberValue(row.waitlist_count),
      }));
    });
  }

  async updateRegistrationSettings(
    tournamentIdInput: unknown,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withTransaction(async (db) => {
      const tournament = await this.requireTournamentWith(db, tournamentId);
      const opensAt = Object.prototype.hasOwnProperty.call(payload, "registration_opens_at")
        ? nullableDateTime(payload.registration_opens_at)
        : nullableString(tournament.registration_opens_at);
      const closesAt = Object.prototype.hasOwnProperty.call(payload, "registration_closes_at")
        ? nullableDateTime(payload.registration_closes_at)
        : nullableString(tournament.registration_closes_at);
      const maxPlayers = Object.prototype.hasOwnProperty.call(payload, "max_players")
        ? nullablePositiveInt(payload.max_players)
        : nullablePositiveInt(tournament.max_players);

      if (opensAt !== null && closesAt !== null && opensAt >= closesAt) {
        throw new DomainValidationError(
          "invalid_registration_window",
          "Registration closing time must be after opening time.",
        );
      }

      await db.execute(
        `UPDATE \`${this.prefix}tournaments\`
            SET registration_opens_at=?, registration_closes_at=?, max_players=?
          WHERE id=?`,
        [opensAt, closesAt, maxPlayers, tournamentId],
      );
      const updated = await this.requireTournamentWith(db, tournamentId);
      return publicTournament(updated);
    });
  }

  async registerPlayer(
    tournamentIdInput: unknown,
    playerIdInput: unknown,
    source: RegistrationSource = "player",
  ): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    const playerId = requiredId(playerIdInput, "player_id");
    if (source !== "player" && source !== "admin") throw new TypeError("Invalid registration source.");

    return this.sessions.withTransaction(async (db) => {
      const tournament = await this.requireTournamentWith(db, tournamentId);
      if ((await this.matchCountWith(db, tournamentId)) > 0) {
        throw new DomainValidationError(
          "registration_locked_by_matches",
          "Registration changes are locked after matches have been created.",
        );
      }
      if (source !== "admin") this.assertRegistrationOpen(tournament);

      const clubId = requiredId(tournament.club_id, "club_id");
      await this.assertPlayerBelongsToTournamentClubWith(db, playerId, clubId);

      const maxPlayers = nullablePositiveInt(tournament.max_players);
      let status = "registered";
      if (maxPlayers !== null) {
        const confirmed = await this.confirmedRegistrationCountWith(db, tournamentId, playerId);
        if (confirmed >= maxPlayers) status = "waitlisted";
      }

      await db.execute(
        `INSERT INTO \`${this.prefix}tournament_players\`
          (tournament_id, player_id, status, registration_source)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status=VALUES(status), registration_source=VALUES(registration_source),
                                 seed=NULL, seed_rating=NULL, seed_rating_source=NULL, updated_at=NOW()`,
        [tournamentId, playerId, status, source],
      );
      await this.invalidateGroupDrawWith(db, tournamentId);

      return {
        tournament_id: publicId(tournamentId),
        player_id: publicId(playerId),
        status,
        registration_source: source,
      };
    });
  }

  async checkInPlayer(tournamentIdInput: unknown, playerIdInput: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    const playerId = requiredId(playerIdInput, "player_id");
    return this.sessions.withTransaction(async (db) => {
      await this.requireTournamentWith(db, tournamentId);
      const rows = await db.query<QueryResultRow>(
        `SELECT id, status FROM \`${this.prefix}tournament_players\`
          WHERE tournament_id=? AND player_id=? LIMIT 1`,
        [tournamentId, playerId],
      );
      const registration = rows[0] ?? null;
      if (!registration) {
        throw new DomainValidationError(
          "registration_required_before_check_in",
          "Register for the tournament before checking in.",
        );
      }
      const status = String(registration.status ?? "");
      if (status === "waitlisted") {
        throw new DomainValidationError(
          "registration_waitlisted",
          "Waitlisted players cannot check in until they have a confirmed place.",
        );
      }
      if (status !== "registered" && status !== "checked_in") {
        throw new DomainValidationError(
          "registration_not_checkin_eligible",
          "This registration cannot be checked in.",
        );
      }
      if (status !== "checked_in") {
        const registrationId = requiredId(registration.id, "registration_id");
        await db.execute(
          `UPDATE \`${this.prefix}tournament_players\` SET status='checked_in' WHERE id=?`,
          [registrationId],
        );
      }
      return { tournament_id: publicId(tournamentId), player_id: publicId(playerId), status: "checked_in" };
    });
  }

  async withdrawPlayer(tournamentIdInput: unknown, playerIdInput: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    const playerId = requiredId(playerIdInput, "player_id");
    return this.sessions.withTransaction(async (db) => {
      await this.requireTournamentWith(db, tournamentId);
      if ((await this.matchCountWith(db, tournamentId)) > 0) {
        throw new DomainValidationError(
          "registration_locked_by_matches",
          "Registration changes are locked after matches have been created.",
        );
      }
      const result = await db.execute(
        `UPDATE \`${this.prefix}tournament_players\`
            SET status='withdrawn', seed=NULL, seed_rating=NULL, seed_rating_source=NULL
          WHERE tournament_id=? AND player_id=? AND status <> 'withdrawn'`,
        [tournamentId, playerId],
      );
      if (result.affectedRows === 0) {
        throw new DomainValidationError("registration_not_found", "Active registration was not found.", 404);
      }
      const promotedPlayerId = await this.promoteWaitlistedPlayerWith(db, tournamentId);
      await this.invalidateGroupDrawWith(db, tournamentId);
      return {
        tournament_id: publicId(tournamentId),
        player_id: publicId(playerId),
        status: "withdrawn",
        promoted_player_id: promotedPlayerId === null ? null : publicId(promotedPlayerId),
      };
    });
  }

  async drawGroups(
    tournamentIdInput: unknown,
    groupCountInput: unknown,
    modeInput: unknown,
    drawSeedInput: unknown = null,
  ): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    const groupCount = positiveInt(groupCountInput, "group_count");
    const mode = typeof modeInput === "string" ? modeInput : "elo_snake";

    return this.sessions.withTransaction(async (db) => {
      const tournament = await this.requireTournamentWith(db, tournamentId);
      if ((await this.matchCountWith(db, tournamentId)) > 0) {
        throw new DomainValidationError(
          "groups_locked_by_matches",
          "Groups cannot be redrawn after matches have been created.",
        );
      }
      const seasonId = decimalId(tournament.season_id);
      const registrations = await this.listSeedCandidatesWith(db, tournamentId, seasonId);
      const allocation = this.groupService.allocate(registrations, groupCount, mode, drawSeedInput);

      await db.execute(`DELETE FROM \`${this.prefix}tournament_groups\` WHERE tournament_id=?`, [tournamentId]);
      await db.execute(
        `UPDATE \`${this.prefix}tournament_players\`
            SET seed=NULL, seed_rating=NULL, seed_rating_source=NULL
          WHERE tournament_id=?`,
        [tournamentId],
      );

      for (const group of allocation.groups) {
        const inserted = await db.execute(
          `INSERT INTO \`${this.prefix}tournament_groups\` (tournament_id, name, sort_order, draw_mode, draw_seed)
           VALUES (?, ?, ?, ?, ?)`,
          [tournamentId, group.name, group.sort_order, allocation.mode, allocation.draw_seed],
        );
        const groupId = requiredId(inserted.insertId, "group_id");
        for (const player of group.players) {
          await db.execute(
            `INSERT INTO \`${this.prefix}tournament_group_players\`
              (group_id, tournament_player_id, position, seed_number, seed_rating, seed_rating_source)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              groupId,
              player.tournament_player_id,
              player.group_position,
              player.seed_number,
              player.seed_rating,
              player.elo_rating_source,
            ],
          );
          await db.execute(
            `UPDATE \`${this.prefix}tournament_players\`
                SET seed=?, seed_rating=?, seed_rating_source=?
              WHERE tournament_id=? AND id=?`,
            [
              player.seed_number,
              player.seed_rating,
              player.elo_rating_source,
              tournamentId,
              player.tournament_player_id,
            ],
          );
        }
      }

      await db.execute(
        `UPDATE \`${this.prefix}tournaments\`
            SET group_count=?, group_draw_mode=?, group_draw_seed=?, group_drawn_at=NOW()
          WHERE id=?`,
        [groupCount, allocation.mode, allocation.draw_seed, tournamentId],
      );
      return this.getGroupsWith(db, tournamentId);
    });
  }

  async generateRoundRobin(tournamentIdInput: unknown, bestOfLegsInput: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    const bestOfLegs = positiveInt(bestOfLegsInput, "best_of_legs");
    if (bestOfLegs > 21 || bestOfLegs % 2 === 0) {
      throw new DomainValidationError(
        "invalid_best_of_legs",
        "best_of_legs must be an odd number between 1 and 21.",
      );
    }

    return this.sessions.withTransaction(async (db) => {
      await this.requireTournamentWith(db, tournamentId);
      if ((await this.matchCountWith(db, tournamentId)) > 0) {
        throw new DomainValidationError(
          "matches_already_exist",
          "Round robin cannot be generated because this tournament already has matches.",
        );
      }
      const groups = await this.internalGroupsWith(db, tournamentId);
      if (groups.length === 0) {
        throw new DomainValidationError("groups_required", "Draw groups before generating round robin matches.");
      }
      const legsToWin = Math.floor(bestOfLegs / 2) + 1;
      let created = 0;
      for (const group of groups) {
        const rounds = this.groupService.roundRobin(group.players);
        for (let roundIndex = 0; roundIndex < rounds.length; roundIndex += 1) {
          const round = rounds[roundIndex] ?? [];
          for (const pair of round) {
            await db.execute(
              `INSERT INTO \`${this.prefix}matches\`
                (tournament_id, tournament_group_id, round_label, round_number, bracket_label, status,
                 best_of_legs, legs_to_win, player_a_id, player_b_id)
               VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
              [
                tournamentId,
                group.id,
                `${group.name} · Runde ${roundIndex + 1}`,
                roundIndex + 1,
                group.name,
                bestOfLegs,
                legsToWin,
                pair.player_a_id,
                pair.player_b_id,
              ],
            );
            created += 1;
          }
        }
      }
      return {
        tournament_id: publicId(tournamentId),
        created_match_count: created,
        best_of_legs: bestOfLegs,
      };
    });
  }

  async getGroups(tournamentIdInput: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withConnection((db) => this.getGroupsWith(db, tournamentId));
  }

  private async getGroupsWith(db: SqlExecutor, tournamentId: string): Promise<Record<string, unknown>> {
    const tournament = await this.requireTournamentWith(db, tournamentId);
    const rows = await db.query<QueryResultRow>(
      `SELECT g.id AS group_id, g.name AS group_name, g.sort_order, g.draw_mode, g.draw_seed, g.generated_at,
              gp.position, gp.seed_number, gp.seed_rating, gp.seed_rating_source,
              tp.id AS tournament_player_id, tp.status AS registration_status,
              p.id AS player_id, p.display_name, p.nickname
         FROM \`${this.prefix}tournament_groups\` g
         LEFT JOIN \`${this.prefix}tournament_group_players\` gp ON gp.group_id=g.id
         LEFT JOIN \`${this.prefix}tournament_players\` tp ON tp.id=gp.tournament_player_id
         LEFT JOIN \`${this.prefix}players\` p ON p.id=tp.player_id
        WHERE g.tournament_id=?
        ORDER BY g.sort_order ASC, gp.position ASC`,
      [tournamentId],
    );
    const groups = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const groupId = requiredId(row.group_id, "group_id");
      let group = groups.get(groupId);
      if (!group) {
        const drawSeed = decimalId(row.draw_seed);
        group = {
          id: publicId(groupId),
          name: row.group_name ?? null,
          sort_order: numberValue(row.sort_order),
          draw_mode: row.draw_mode ?? null,
          draw_seed: drawSeed === null ? null : publicId(drawSeed),
          generated_at: row.generated_at ?? null,
          players: [],
        };
        groups.set(groupId, group);
      }
      const playerId = decimalId(row.player_id);
      if (playerId !== null) {
        (group.players as Record<string, unknown>[]).push({
          tournament_player_id: publicId(requiredId(row.tournament_player_id, "tournament_player_id")),
          player_id: publicId(playerId),
          display_name: row.display_name ?? null,
          nickname: row.nickname ?? null,
          registration_status: row.registration_status ?? null,
          position: numberValue(row.position),
          seed_number: row.seed_number == null ? null : numberValue(row.seed_number),
          seed_rating: row.seed_rating == null ? null : Number(row.seed_rating),
          seed_rating_source: row.seed_rating_source ?? null,
        });
      }
    }
    return { tournament: publicTournament(tournament), groups: [...groups.values()] };
  }

  private async internalGroupsWith(db: SqlExecutor, tournamentId: string): Promise<InternalGroup[]> {
    const rows = await db.query<QueryResultRow>(
      `SELECT g.id AS group_id, g.name AS group_name, p.id AS player_id
         FROM \`${this.prefix}tournament_groups\` g
         LEFT JOIN \`${this.prefix}tournament_group_players\` gp ON gp.group_id=g.id
         LEFT JOIN \`${this.prefix}tournament_players\` tp ON tp.id=gp.tournament_player_id
         LEFT JOIN \`${this.prefix}players\` p ON p.id=tp.player_id
        WHERE g.tournament_id=?
        ORDER BY g.sort_order ASC, gp.position ASC`,
      [tournamentId],
    );
    const groups = new Map<string, InternalGroup>();
    for (const row of rows) {
      const groupId = requiredId(row.group_id, "group_id");
      let group = groups.get(groupId);
      if (!group) {
        group = { id: groupId, name: String(row.group_name ?? ""), players: [] };
        groups.set(groupId, group);
      }
      const playerId = decimalId(row.player_id);
      if (playerId !== null) group.players.push({ player_id: playerId });
    }
    return [...groups.values()];
  }

  private async listSeedCandidatesWith(
    db: SqlExecutor,
    tournamentId: string,
    seasonId: string | null,
  ): Promise<TournamentSeedCandidate[]> {
    const rows = await db.query<QueryResultRow>(
      `SELECT tp.id AS tournament_player_id, tp.player_id, p.display_name, p.nickname,
              (SELECT rs.points FROM \`${this.prefix}ranking_snapshots\` rs
                WHERE rs.player_id=p.id AND rs.ranking_type='elo'
                  AND (? IS NULL OR rs.season_id=? OR rs.season_id IS NULL)
                ORDER BY CASE WHEN rs.season_id <=> ? THEN 0 ELSE 1 END, rs.calculated_at DESC, rs.id DESC
                LIMIT 1) AS elo_rating
         FROM \`${this.prefix}tournament_players\` tp
         INNER JOIN \`${this.prefix}players\` p ON p.id=tp.player_id
        WHERE tp.tournament_id=? AND tp.status IN ('registered','checked_in')
        ORDER BY p.display_name ASC`,
      [seasonId, seasonId, seasonId, tournamentId],
    );
    return rows.map((row) => {
      const displayName = String(row.display_name ?? "");
      const snapshotRating = row.elo_rating == null ? null : Number(row.elo_rating);
      const baseline = ELO_BASELINE.get(displayName.trim().toLocaleLowerCase("nb-NO"));
      const rating = snapshotRating !== null && Number.isFinite(snapshotRating)
        ? snapshotRating
        : baseline ?? 1000;
      return {
        tournament_player_id: requiredId(row.tournament_player_id, "tournament_player_id"),
        player_id: requiredId(row.player_id, "player_id"),
        display_name: displayName,
        nickname: row.nickname == null ? null : String(row.nickname),
        elo_rating: rating,
        elo_rating_source: snapshotRating !== null && Number.isFinite(snapshotRating)
          ? "ranking_snapshot"
          : baseline !== undefined
            ? "mandagsserien_2026_08_24"
            : "default_1000",
      };
    });
  }

  private async findTournamentWith(db: SqlExecutor, tournamentId: string): Promise<TournamentRow | null> {
    const rows = await db.query<TournamentRow>(
      `SELECT t.id, t.club_id, t.season_id, t.name, t.slug, t.status, t.start_at, t.end_at,
              t.registration_opens_at, t.registration_closes_at, t.max_players,
              t.group_count, t.group_draw_mode, t.group_draw_seed, t.group_drawn_at,
              ${registrationStateSql("t")} AS registration_state
         FROM \`${this.prefix}tournaments\` t WHERE t.id=? LIMIT 1`,
      [tournamentId],
    );
    return rows[0] ?? null;
  }

  private async requireTournamentWith(db: SqlExecutor, tournamentId: string): Promise<TournamentRow> {
    const tournament = await this.findTournamentWith(db, tournamentId);
    if (!tournament) throw new DomainValidationError("tournament_not_found", "Tournament was not found.", 404);
    return tournament;
  }

  private assertRegistrationOpen(tournament: TournamentRow): void {
    const state = String(tournament.registration_state ?? "open");
    if (state === "not_open") {
      throw new DomainValidationError("registration_not_open", "Registration has not opened yet.");
    }
    if (state === "closed") {
      throw new DomainValidationError("registration_closed", "Registration is closed.");
    }
  }

  private async matchCountWith(db: SqlExecutor, tournamentId: string): Promise<number> {
    const rows = await db.query<QueryResultRow>(
      `SELECT COUNT(*) AS cnt FROM \`${this.prefix}matches\` WHERE tournament_id=?`,
      [tournamentId],
    );
    return numberValue(rows[0]?.cnt);
  }

  private async confirmedRegistrationCountWith(db: SqlExecutor, tournamentId: string, excludePlayerId: string): Promise<number> {
    const rows = await db.query<QueryResultRow>(
      `SELECT COUNT(*) AS cnt FROM \`${this.prefix}tournament_players\`
        WHERE tournament_id=? AND status IN ('registered','checked_in','paused') AND (?='0' OR player_id<>?)`,
      [tournamentId, excludePlayerId, excludePlayerId],
    );
    return numberValue(rows[0]?.cnt);
  }

  private async assertPlayerBelongsToTournamentClubWith(db: SqlExecutor, playerId: string, clubId: string): Promise<void> {
    const rows = await db.query<QueryResultRow>(
      `SELECT club_id FROM \`${this.prefix}players\` WHERE id=? LIMIT 1`,
      [playerId],
    );
    const row = rows[0];
    if (!row) throw new DomainValidationError("player_not_in_club", "Player does not belong to the tournament club.");
    const playerClubId = decimalId(row.club_id);
    if (row.club_id !== null && playerClubId !== clubId) {
      throw new DomainValidationError("player_not_in_club", "Player does not belong to the tournament club.");
    }
  }

  private async promoteWaitlistedPlayerWith(db: SqlExecutor, tournamentId: string): Promise<string | null> {
    const tournament = await this.requireTournamentWith(db, tournamentId);
    const maxPlayers = nullablePositiveInt(tournament.max_players);
    if (maxPlayers === null || (await this.confirmedRegistrationCountWith(db, tournamentId, "0")) >= maxPlayers) {
      return null;
    }
    const rows = await db.query<QueryResultRow>(
      `SELECT id, player_id FROM \`${this.prefix}tournament_players\`
        WHERE tournament_id=? AND status='waitlisted'
        ORDER BY created_at ASC, id ASC LIMIT 1`,
      [tournamentId],
    );
    const row = rows[0];
    if (!row) return null;
    const registrationId = requiredId(row.id, "registration_id");
    const playerId = requiredId(row.player_id, "player_id");
    await db.execute(
      `UPDATE \`${this.prefix}tournament_players\` SET status='registered' WHERE id=?`,
      [registrationId],
    );
    return playerId;
  }

  private async invalidateGroupDrawWith(db: SqlExecutor, tournamentId: string): Promise<void> {
    await db.execute(`DELETE FROM \`${this.prefix}tournament_groups\` WHERE tournament_id=?`, [tournamentId]);
    await db.execute(
      `UPDATE \`${this.prefix}tournament_players\`
          SET seed=NULL, seed_rating=NULL, seed_rating_source=NULL
        WHERE tournament_id=?`,
      [tournamentId],
    );
    await db.execute(
      `UPDATE \`${this.prefix}tournaments\`
          SET group_count=NULL, group_draw_mode=NULL, group_draw_seed=NULL, group_drawn_at=NULL
        WHERE id=?`,
      [tournamentId],
    );
  }
}

const ELO_BASELINE = new Map<string, number>([
  ["andre kendrick", 1077.3],
  ["jon-henning næss", 1067.3],
  ["vetle ribe davidsen", 1035.2],
  ["thomas kildal", 1031.5],
  ["arild eidesund", 1024.9],
  ["hans øyvind reiersen", 1019.3],
  ["magnus knudsen", 1018.3],
  ["steffen madsen", 1001.7],
  ["kjell moyle", 1001.4],
  ["tormod haga", 992.3],
  ["andreas hasselgård", 986.3],
  ["tor egil olsen", 983.0],
  ["andreas tingstveit hansen", 974.3],
  ["leif atle franksson", 966.7],
  ["sven einar davidsen", 953.7],
  ["dan christian birkeland", 939.5],
  ["boye buckingham", 921.0],
]);

function registrationStateSql(alias: string): string {
  return `CASE
    WHEN ${alias}.status IN ('completed','archived') THEN 'closed'
    WHEN ${alias}.registration_opens_at IS NOT NULL AND ${alias}.registration_opens_at > NOW() THEN 'not_open'
    WHEN ${alias}.registration_closes_at IS NOT NULL AND ${alias}.registration_closes_at < NOW() THEN 'closed'
    ELSE 'open'
  END`;
}

function publicTournament(row: TournamentRow): Record<string, unknown> {
  return {
    id: publicId(requiredId(row.id, "tournament_id")),
    club_id: publicId(requiredId(row.club_id, "club_id")),
    season_id: optionalPublicId(row.season_id),
    name: row.name ?? null,
    ...(Object.prototype.hasOwnProperty.call(row, "slug") ? { slug: row.slug ?? null } : {}),
    status: row.status ?? null,
    start_at: row.start_at ?? null,
    end_at: row.end_at ?? null,
    registration_opens_at: row.registration_opens_at ?? null,
    registration_closes_at: row.registration_closes_at ?? null,
    max_players: row.max_players == null ? null : numberValue(row.max_players),
    group_count: row.group_count == null ? null : numberValue(row.group_count),
    group_draw_mode: row.group_draw_mode ?? null,
    ...(Object.prototype.hasOwnProperty.call(row, "group_draw_seed")
      ? { group_draw_seed: optionalPublicId(row.group_draw_seed) }
      : {}),
    group_drawn_at: row.group_drawn_at ?? null,
    registration_state: row.registration_state ?? null,
  };
}

function nullableDateTime(value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const raw = String(value).trim();
  const mysql = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2}))?)?$/.exec(raw);
  if (mysql) return `${mysql[1]} ${mysql[2] ?? "00:00"}:${mysql[3] ?? "00"}`;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new DomainValidationError("invalid_datetime", "Invalid date/time value.");
  return new Date(parsed).toISOString().slice(0, 19).replace("T", " ");
}

function nullablePositiveInt(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const normalized = String(value).trim();
  if (!/^[0-9]+$/.test(normalized)) {
    throw new DomainValidationError("invalid_max_players", "max_players must be at least 2 when set.");
  }
  const number = Number(normalized);
  if (!Number.isSafeInteger(number) || number < 2) {
    throw new DomainValidationError("invalid_max_players", "max_players must be at least 2 when set.");
  }
  return number;
}

function positiveInt(value: unknown, name: string): number {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new DomainValidationError(`invalid_${name}`, `${name} must be a positive integer.`);
  }
  const number = Number(normalized);
  if (!Number.isSafeInteger(number)) {
    throw new DomainValidationError(`invalid_${name}`, `${name} is too large.`);
  }
  return number;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

function requiredId(value: unknown, name: string): string {
  const normalized = decimalId(value);
  if (normalized === null) throw new DomainValidationError("invalid_id", `${name} must be a positive decimal id.`, 400);
  return normalized;
}

function decimalId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}

function publicId(value: string): number | string {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

function optionalPublicId(value: unknown): number | string | null {
  const id = decimalId(value);
  return id === null ? null : publicId(id);
}

function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}
