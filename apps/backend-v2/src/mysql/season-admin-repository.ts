import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";
import { MySqlSeasonPublicReadRepository } from "./season-public-read-repository.js";

interface SeasonCoreRow extends QueryResultRow {
  readonly id?: unknown;
  readonly club_id?: unknown;
  readonly name?: unknown;
  readonly starts_on?: unknown;
  readonly ends_on?: unknown;
  readonly is_active?: unknown;
  readonly status?: unknown;
  readonly ranking_method?: unknown;
  readonly points_win?: unknown;
  readonly points_draw?: unknown;
  readonly points_loss?: unknown;
}

export class MySqlSeasonAdminRepository {
  private readonly publicReads: MySqlSeasonPublicReadRepository;

  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly prefix: TablePrefix,
  ) {
    this.publicReads = new MySqlSeasonPublicReadRepository(sessions, prefix);
  }

  async find(seasonIdInput: unknown): Promise<Record<string, unknown> | null> {
    return this.publicReads.find(requiredId(seasonIdInput, "season_id"));
  }

  async create(clubIdInput: unknown, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const clubId = requiredId(clubIdInput, "club_id");
    const values = createValues(payload);
    const seasonId = await this.sessions.withTransaction(async (db) => {
      const inserted = await db.execute(
        `INSERT INTO \`${this.prefix}seasons\`
          (club_id,name,starts_on,ends_on,is_active,status,ranking_method,points_win,points_draw,points_loss)
         VALUES (?,?,?, ?,0,'draft',?,?,?,?)`,
        [
          clubId,
          values.name,
          values.startsOn,
          values.endsOn,
          values.rankingMethod,
          values.pointsWin,
          values.pointsDraw,
          values.pointsLoss,
        ],
      );
      const id = requiredId(inserted.insertId, "season_id");
      if (payload.activate === true) await this.activateWith(db, id, clubId);
      return id;
    });
    return this.requirePublicSeason(seasonId);
  }

  async update(seasonIdInput: unknown, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const seasonId = requiredId(seasonIdInput, "season_id");
    await this.sessions.withTransaction(async (db) => {
      const current = await this.requireCoreWith(db, seasonId, true);
      if (String(current.status ?? "") === "completed") {
        throw new DomainValidationError("season_completed", "En avsluttet sesong er låst.", 409);
      }

      const name = Object.prototype.hasOwnProperty.call(payload, "name")
        ? requiredName(payload.name)
        : requiredName(current.name);
      const startsOn = Object.prototype.hasOwnProperty.call(payload, "starts_on")
        ? dateOrNull(payload.starts_on)
        : nullableString(current.starts_on);
      const endsOn = Object.prototype.hasOwnProperty.call(payload, "ends_on")
        ? dateOrNull(payload.ends_on)
        : nullableString(current.ends_on);
      assertDateOrder(startsOn, endsOn);
      const rankingMethod = ranking(payload.ranking_method ?? current.ranking_method);
      const pointsWin = points(payload.points_win ?? current.points_win);
      const pointsDraw = points(payload.points_draw ?? current.points_draw);
      const pointsLoss = points(payload.points_loss ?? current.points_loss);

      await db.execute(
        `UPDATE \`${this.prefix}seasons\`
            SET name=?,starts_on=?,ends_on=?,ranking_method=?,points_win=?,points_draw=?,points_loss=?
          WHERE id=?`,
        [name, startsOn, endsOn, rankingMethod, pointsWin, pointsDraw, pointsLoss, seasonId],
      );
    });
    return this.requirePublicSeason(seasonId);
  }

  async activate(seasonIdInput: unknown): Promise<Record<string, unknown>> {
    const seasonId = requiredId(seasonIdInput, "season_id");
    await this.sessions.withTransaction(async (db) => {
      const season = await this.requireCoreWith(db, seasonId, true);
      if (String(season.status ?? "") === "completed") {
        throw new DomainValidationError(
          "season_completed",
          "En avsluttet sesong kan ikke aktiveres igjen.",
          409,
        );
      }
      await this.activateWith(db, seasonId, requiredId(season.club_id, "club_id"));
    });
    return this.requirePublicSeason(seasonId);
  }

  async complete(seasonIdInput: unknown): Promise<Record<string, unknown>> {
    const seasonId = requiredId(seasonIdInput, "season_id");
    const current = await this.publicReads.find(seasonId);
    if (current === null) throw seasonNotFound();
    if (String(current.status ?? "") === "completed") return current;

    const standing = await this.publicReads.standings(seasonId);
    if (standing === null) throw seasonNotFound();
    const champion = standing.items[0];
    if (champion === undefined) {
      throw new DomainValidationError(
        "season_has_no_results",
        "Sesongen har ingen resultater å kåre vinner fra.",
        409,
      );
    }
    const championId = requiredId(champion.id, "champion_player_id");

    await this.sessions.withTransaction(async (db) => {
      const locked = await this.requireCoreWith(db, seasonId, true);
      if (String(locked.status ?? "") === "completed") return;
      await db.execute(
        `UPDATE \`${this.prefix}seasons\`
            SET champion_player_id=?,status='completed',is_active=0,completed_at=NOW()
          WHERE id=?`,
        [championId, seasonId],
      );
    });
    return this.requirePublicSeason(seasonId);
  }

  private async activateWith(db: SqlExecutor, seasonId: string, clubId: string): Promise<void> {
    await db.execute(
      `UPDATE \`${this.prefix}seasons\`
          SET is_active=0,status=IF(status='active','draft',status)
        WHERE club_id=? AND id<>?`,
      [clubId, seasonId],
    );
    await db.execute(
      `UPDATE \`${this.prefix}seasons\` SET is_active=1,status='active' WHERE id=?`,
      [seasonId],
    );
  }

  private async requireCoreWith(db: SqlExecutor, seasonId: string, lock: boolean): Promise<SeasonCoreRow> {
    const rows = await db.query<SeasonCoreRow>(
      `SELECT id,club_id,name,starts_on,ends_on,is_active,status,ranking_method,points_win,points_draw,points_loss
         FROM \`${this.prefix}seasons\` WHERE id=? LIMIT 1${lock ? " FOR UPDATE" : ""}`,
      [seasonId],
    );
    const row = rows[0];
    if (!row) throw seasonNotFound();
    return row;
  }

  private async requirePublicSeason(seasonId: string): Promise<Record<string, unknown>> {
    const season = await this.publicReads.find(seasonId);
    if (season === null) throw seasonNotFound();
    return season;
  }
}

function createValues(payload: Record<string, unknown>): {
  name: string;
  startsOn: string | null;
  endsOn: string | null;
  rankingMethod: string;
  pointsWin: number;
  pointsDraw: number;
  pointsLoss: number;
} {
  const name = requiredName(payload.name);
  const startsOn = dateOrNull(payload.starts_on);
  const endsOn = dateOrNull(payload.ends_on);
  assertDateOrder(startsOn, endsOn);
  return {
    name,
    startsOn,
    endsOn,
    rankingMethod: ranking(payload.ranking_method ?? "match_points"),
    pointsWin: points(payload.points_win ?? 2),
    pointsDraw: points(payload.points_draw ?? 1),
    pointsLoss: points(payload.points_loss ?? 0),
  };
}

function requiredName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (name === "") validation("Sesongen må ha et navn.");
  return name;
}

function ranking(value: unknown): string {
  const method = String(value ?? "").trim();
  if (method !== "match_points" && method !== "linear" && method !== "elo") {
    validation("Ugyldig metode for sesongtabellen.");
  }
  return method;
}

function points(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") validation("Sesongpoeng må være et tall.");
  const raw = typeof value === "string" ? value.trim() : String(value);
  if (raw === "" || !Number.isFinite(Number(raw))) validation("Sesongpoeng må være et tall.");
  const parsed = Number(raw);
  if (parsed < 0 || parsed > 1000) validation("Sesongpoeng må være mellom 0 og 1000.");
  return parsed;
}

function dateOrNull(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) validation("Dato må være på formatet ÅÅÅÅ-MM-DD.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    validation("Dato må være på formatet ÅÅÅÅ-MM-DD.");
  }
  return raw;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function assertDateOrder(startsOn: string | null, endsOn: string | null): void {
  if (startsOn !== null && endsOn !== null && endsOn < startsOn) {
    validation("Sluttdato kan ikke være før startdato.");
  }
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

function requiredId(value: unknown, name: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new DomainValidationError("invalid_id", `${name} must be a positive decimal id.`, 400);
  }
  return normalized;
}

function validation(message: string): never {
  throw new DomainValidationError("season_validation_failed", message, 422);
}

function seasonNotFound(): DomainValidationError {
  return new DomainValidationError("season_not_found", "Sesongen ble ikke funnet.", 404);
}
