import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

interface WizardPlanRow extends QueryResultRow {
  id: unknown;
  club_id: unknown;
  name: unknown;
  status: unknown;
  start_at: unknown;
  planned_group_count: unknown;
  planned_group_draw_mode: unknown;
  planned_group_best_of_legs: unknown;
  planned_qualifiers_per_group: unknown;
  planned_playoff_best_of_legs: unknown;
  planned_auto_create_playoff: unknown;
  planned_tournament_format: unknown;
  planned_starting_score: unknown;
  group_count: unknown;
  group_draw_mode: unknown;
  group_drawn_at: unknown;
}

export class MySqlTournamentWizardRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly prefix: TablePrefix,
  ) {}

  async getPlan(tournamentIdInput: unknown): Promise<Record<string, unknown> | null> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withConnection((db) => this.getPlanWith(db, tournamentId));
  }

  async updatePlan(
    tournamentIdInput: unknown,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withTransaction(async (db) => {
      const current = await this.requirePlanWith(db, tournamentId);

      const format = textValue(
        Object.prototype.hasOwnProperty.call(payload, "tournament_format")
          ? payload.tournament_format
          : current.tournament_format,
      );
      if (!["groups_playoff", "groups_only", "single_elimination", "swiss"].includes(format)) {
        throw new DomainValidationError("invalid_tournament_format", "Ugyldig turneringsformat.");
      }

      const startingScore = integerValue(
        Object.prototype.hasOwnProperty.call(payload, "starting_score")
          ? payload.starting_score
          : current.starting_score,
      );
      if (![301, 501, 701, 1001].includes(startingScore)) {
        throw new DomainValidationError("invalid_starting_score", "Ugyldig startscore.");
      }

      const groupCount = clamp(
        integerValue(Object.prototype.hasOwnProperty.call(payload, "group_count") ? payload.group_count : current.group_count),
        1,
        32,
      );
      const drawMode = textValue(
        Object.prototype.hasOwnProperty.call(payload, "group_draw_mode")
          ? payload.group_draw_mode
          : current.group_draw_mode,
      );
      if (!["elo_snake", "elo_pots", "random"].includes(drawMode)) {
        throw new DomainValidationError("invalid_group_draw_mode", "Ugyldig gruppetrekkmodus.");
      }

      const groupBestOf = oddBestOf(
        Object.prototype.hasOwnProperty.call(payload, "group_best_of_legs")
          ? payload.group_best_of_legs
          : current.group_best_of_legs,
        "gruppespill",
      );
      const qualifiers = clamp(
        integerValue(
          Object.prototype.hasOwnProperty.call(payload, "qualifiers_per_group")
            ? payload.qualifiers_per_group
            : current.qualifiers_per_group,
        ),
        1,
        16,
      );
      const playoffBestOf = oddBestOf(
        Object.prototype.hasOwnProperty.call(payload, "playoff_best_of_legs")
          ? payload.playoff_best_of_legs
          : current.playoff_best_of_legs,
        "sluttspill",
      );
      const autoCreatePlayoff = Object.prototype.hasOwnProperty.call(payload, "auto_create_playoff")
        ? phpBool(payload.auto_create_playoff)
        : current.auto_create_playoff === true;

      await this.validateGroupPlanWith(db, tournamentId, format, groupCount, qualifiers);
      await db.execute(
        `UPDATE \`${this.prefix}tournaments\`
            SET planned_group_count=?,planned_group_draw_mode=?,planned_group_best_of_legs=?,
                planned_qualifiers_per_group=?,planned_playoff_best_of_legs=?,planned_auto_create_playoff=?,
                planned_tournament_format=?,planned_starting_score=?
          WHERE id=?`,
        [
          groupCount,
          drawMode,
          groupBestOf,
          qualifiers,
          playoffBestOf,
          autoCreatePlayoff ? 1 : 0,
          format,
          startingScore,
          tournamentId,
        ],
      );
      return this.requirePlanWith(db, tournamentId);
    });
  }

  async deleteDraftTournament(tournamentIdInput: unknown): Promise<Record<string, unknown>> {
    const tournamentId = requiredId(tournamentIdInput, "tournament_id");
    return this.sessions.withTransaction(async (db) => {
      const plan = await this.requirePlanWith(db, tournamentId);
      if (String(plan.status ?? "") !== "draft") {
        throw new DomainValidationError(
          "tournament_delete_not_allowed",
          "Bare turneringer som ikke er startet kan slettes.",
          409,
        );
      }

      const matchRows = await db.query<QueryResultRow>(
        `SELECT COUNT(*) AS c FROM \`${this.prefix}matches\` WHERE tournament_id=?`,
        [tournamentId],
      );
      if (Number(matchRows[0]?.c ?? 0) > 0) {
        throw new DomainValidationError(
          "tournament_delete_has_matches",
          "Turneringen har kamper og kan ikke slettes. Arkiver den i stedet.",
          409,
        );
      }

      const databaseRows = await db.query<QueryResultRow>("SELECT DATABASE() AS db");
      const schema = textValue(databaseRows[0]?.db);
      const parentTable = `${this.prefix}tournaments`;
      const children = await db.query<QueryResultRow>(
        `SELECT TABLE_NAME,COLUMN_NAME
           FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
          WHERE REFERENCED_TABLE_SCHEMA=?
            AND REFERENCED_TABLE_NAME=?
            AND REFERENCED_COLUMN_NAME='id'
          ORDER BY TABLE_NAME,COLUMN_NAME`,
        [schema, parentTable],
      );

      for (const child of children) {
        const table = safeIdentifier(child.TABLE_NAME, "foreign key table");
        const column = safeIdentifier(child.COLUMN_NAME, "foreign key column");
        await db.execute(`DELETE FROM \`${table}\` WHERE \`${column}\`=?`, [tournamentId]);
      }

      const deleted = await db.execute(
        `DELETE FROM \`${this.prefix}tournaments\` WHERE id=? AND status='draft'`,
        [tournamentId],
      );
      if (deleted.affectedRows !== 1) {
        throw new DomainValidationError(
          "tournament_delete_failed",
          "Turneringen kunne ikke slettes.",
          409,
        );
      }

      return {
        deleted: true,
        tournament_id: publicId(tournamentId),
        name: String(plan.name ?? ""),
      };
    });
  }

  private async getPlanWith(db: SqlExecutor, tournamentId: string): Promise<Record<string, unknown> | null> {
    const rows = await db.query<WizardPlanRow>(
      `SELECT id,club_id,name,status,start_at,
              planned_group_count,planned_group_draw_mode,planned_group_best_of_legs,
              planned_qualifiers_per_group,planned_playoff_best_of_legs,planned_auto_create_playoff,
              planned_tournament_format,planned_starting_score,
              group_count,group_draw_mode,group_drawn_at
         FROM \`${this.prefix}tournaments\` WHERE id=? LIMIT 1`,
      [tournamentId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      tournament_id: publicId(requiredId(row.id, "tournament_id")),
      club_id: publicId(requiredId(row.club_id, "club_id")),
      name: row.name ?? null,
      status: row.status ?? null,
      start_at: row.start_at ?? null,
      tournament_format: textValue(row.planned_tournament_format),
      starting_score: integerValue(row.planned_starting_score),
      group_count: row.planned_group_count !== null && row.planned_group_count !== undefined
        ? integerValue(row.planned_group_count)
        : row.group_count !== null && row.group_count !== undefined
          ? integerValue(row.group_count)
          : 1,
      group_draw_mode: row.planned_group_draw_mode ?? row.group_draw_mode ?? "elo_snake",
      group_best_of_legs: row.planned_group_best_of_legs !== null && row.planned_group_best_of_legs !== undefined
        ? integerValue(row.planned_group_best_of_legs)
        : 3,
      qualifiers_per_group: row.planned_qualifiers_per_group !== null && row.planned_qualifiers_per_group !== undefined
        ? integerValue(row.planned_qualifiers_per_group)
        : 2,
      playoff_best_of_legs: row.planned_playoff_best_of_legs !== null && row.planned_playoff_best_of_legs !== undefined
        ? integerValue(row.planned_playoff_best_of_legs)
        : 3,
      auto_create_playoff: Number(row.planned_auto_create_playoff ?? 1) === 1,
      groups_already_drawn: row.group_drawn_at !== null && row.group_drawn_at !== undefined,
    };
  }

  private async requirePlanWith(db: SqlExecutor, tournamentId: string): Promise<Record<string, unknown>> {
    const plan = await this.getPlanWith(db, tournamentId);
    if (plan === null) {
      throw new DomainValidationError("tournament_not_found", "Turneringen ble ikke funnet.", 404);
    }
    return plan;
  }

  private async validateGroupPlanWith(
    db: SqlExecutor,
    tournamentId: string,
    format: string,
    groupCount: number,
    qualifiers: number,
  ): Promise<void> {
    if (format !== "groups_playoff" && format !== "groups_only") return;

    const countRows = await db.query<QueryResultRow>(
      `SELECT COUNT(*) AS c FROM \`${this.prefix}tournament_players\`
        WHERE tournament_id=? AND status='checked_in'`,
      [tournamentId],
    );
    const checkedIn = Number(countRows[0]?.c ?? 0);
    if (checkedIn === 0) return;
    if (checkedIn < 4) {
      throw new DomainValidationError(
        "not_enough_players_for_groups",
        "Gruppespill krever minst 4 innsjekkede spillere.",
      );
    }

    const maxGroups = Math.floor(checkedIn / 4);
    if (groupCount > maxGroups) {
      throw new DomainValidationError(
        "groups_too_small",
        `Med ${checkedIn} innsjekkede kan du ha maks ${maxGroups} ${maxGroups === 1 ? "gruppe" : "grupper"} slik at alle grupper får minst 4 spillere.`,
      );
    }

    const smallestGroup = Math.floor(checkedIn / groupCount);
    if (smallestGroup < 4) {
      throw new DomainValidationError("groups_too_small", "Alle grupper må ha minst 4 spillere.");
    }
    if (format !== "groups_playoff") return;

    if (qualifiers > smallestGroup) {
      throw new DomainValidationError(
        "too_many_qualifiers_per_group",
        `Den minste gruppen har ${smallestGroup} spillere og kan ikke sende ${qualifiers} videre.`,
      );
    }
    const qualified = groupCount * qualifiers;
    if (qualified < 2) {
      throw new DomainValidationError(
        "not_enough_playoff_qualifiers",
        "Sluttspillet må få minst 2 kvalifiserte spillere.",
      );
    }
    if (qualified > 32) {
      throw new DomainValidationError(
        "too_many_playoff_qualifiers",
        "Sluttspillet støtter maksimalt 32 kvalifiserte spillere.",
      );
    }
  }
}

function oddBestOf(value: unknown, label: string): number {
  const bestOf = integerValue(value);
  if (bestOf < 1 || bestOf > 21 || bestOf % 2 === 0) {
    throw new DomainValidationError(
      "invalid_best_of_legs",
      `Best of for ${label} må være et oddetall mellom 1 og 21.`,
    );
  }
  return bestOf;
}

function safeIdentifier(value: unknown, label: string): string {
  const identifier = textValue(value);
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new DomainValidationError("invalid_database_identifier", `Ugyldig ${label}.`, 500);
  }
  return identifier;
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

function integerValue(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function textValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function phpBool(value: unknown): boolean {
  return !(value === false || value === null || value === undefined || value === 0 || value === "" || value === "0");
}
