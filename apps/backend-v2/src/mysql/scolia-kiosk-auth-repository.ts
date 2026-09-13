import bcrypt from "bcryptjs";

import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

export interface PairedKioskContext {
  readonly kiosk_id: string;
  readonly club_id: string;
  readonly code: string;
}

interface KioskRow extends QueryResultRow {
  readonly id: unknown;
  readonly club_id: unknown;
  readonly club_name: unknown;
  readonly club_logo_url: unknown;
  readonly code: unknown;
  readonly name: unknown;
  readonly board_number: unknown;
  readonly sponsor_label: unknown;
  readonly sponsor_logo_url: unknown;
  readonly scoring_mode: unknown;
  readonly pairing_token_hash: unknown;
  readonly paired_device_name: unknown;
  readonly paired_at: unknown;
}

interface MatchRow extends QueryResultRow {
  readonly id: unknown;
  readonly status: unknown;
  readonly round_label: unknown;
  readonly bracket_label: unknown;
  readonly best_of_legs: unknown;
  readonly legs_to_win: unknown;
  readonly player_a_id: unknown;
  readonly player_b_id: unknown;
  readonly winner_player_id: unknown;
  readonly starts_at: unknown;
  readonly finished_at: unknown;
  readonly player_a_name: unknown;
  readonly player_b_name: unknown;
}

interface LegRow extends QueryResultRow {
  readonly id: unknown;
  readonly leg_number: unknown;
  readonly starting_player_id: unknown;
  readonly status: unknown;
}

export class MySqlScoliaKioskAuthRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
  ) {}

  async resolve(codeInput: unknown, tokenInput: unknown, touch = true): Promise<PairedKioskContext> {
    const code = decodeCode(codeInput);
    const token = String(tokenInput ?? "").trim();
    if (!code || !token) throw new DomainValidationError("kiosk_auth_required", "Board-terminalen mangler gyldig pairing-token.", 401);

    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT id,club_id,code,pairing_token_hash
           FROM \`${this.runtimePrefix}kiosks\`
          WHERE code=? AND is_active=1 LIMIT 1`,
        [code],
      );
      const row = rows[0];
      const hash = String(row?.pairing_token_hash ?? "").trim();
      if (!row || !hash || !await bcrypt.compare(token, hash)) {
        throw new DomainValidationError("kiosk_auth_invalid", "Board-terminalens pairing-token er ugyldig.", 401);
      }
      const kioskId = id(row.id, "kiosk_id");
      const clubId = id(row.club_id, "club_id");
      if (touch) await db.execute(`UPDATE \`${this.runtimePrefix}kiosks\` SET last_seen_at=NOW() WHERE id=?`, [kioskId]);
      return { kiosk_id: kioskId, club_id: clubId, code: String(row.code ?? code) };
    });
  }

  /**
   * Legacy-compatible kiosk access for the canonical scoring front door.
   *
   * Pairing is enforced when a kiosk is paired. Unpaired TEST aliases remain
   * usable without a token, matching the current kiosk state/scoring contract.
   */
  async resolveScoring(codeInput: unknown, tokenInput: unknown, touch = true): Promise<PairedKioskContext> {
    const code = decodeCode(codeInput);
    if (!code) throw new DomainValidationError("kiosk_not_found", "No kiosk exists for the supplied kiosk code.", 404);
    const token = String(tokenInput ?? "").trim();

    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT id,club_id,code,pairing_token_hash
           FROM \`${this.runtimePrefix}kiosks\`
          WHERE code=? AND is_active=1 LIMIT 1`,
        [code],
      );
      const row = rows[0];
      if (!row) throw new DomainValidationError("kiosk_not_found", "No kiosk exists for the supplied kiosk code.", 404);

      const hash = String(row.pairing_token_hash ?? "").trim();
      if (hash !== "") {
        if (token === "") {
          throw new DomainValidationError(
            "kiosk_pairing_required",
            "Denne kiosken er paret til et nettbrett og krever gyldig paringstoken.",
            403,
          );
        }
        if (!await bcrypt.compare(token, hash)) {
          throw new DomainValidationError(
            "kiosk_paired_to_other_device",
            "Denne kiosken er allerede paret mot et annet nettbrett.",
            409,
          );
        }
      }

      const kioskId = id(row.id, "kiosk_id");
      const clubId = id(row.club_id, "club_id");
      if (touch) await db.execute(`UPDATE \`${this.runtimePrefix}kiosks\` SET last_seen_at=NOW() WHERE id=?`, [kioskId]);
      return { kiosk_id: kioskId, club_id: clubId, code: String(row.code ?? code) };
    });
  }

  /** Clears only the runtime pairing fields after legacy-compatible kiosk access. */
  async unpairScoring(codeInput: unknown, tokenInput: unknown): Promise<Record<string, unknown>> {
    const kiosk = await this.resolveScoring(codeInput, tokenInput, true);
    await this.sessions.withConnection(async (db) => {
      await db.execute(
        `UPDATE \`${this.runtimePrefix}kiosks\`
            SET pairing_token_hash=NULL,paired_device_name=NULL,paired_at=NULL
          WHERE id=?`,
        [kiosk.kiosk_id],
      );
    });
    return this.scoringSnapshot(kiosk.kiosk_id);
  }

  /** Pure canonical kiosk snapshot. No leg or match state is created by reads. */
  async scoringSnapshot(kioskIdInput: unknown): Promise<Record<string, unknown>> {
    const kioskId = id(kioskIdInput, "kiosk_id");
    return this.sessions.withConnection(async (db) => {
      const kiosk = await this.kioskWith(db, kioskId);
      if (!kiosk) throw new DomainValidationError("kiosk_not_found", "No kiosk exists for the supplied kiosk code.", 404);

      const matchRows = await db.query<MatchRow>(
        `SELECT m.id,m.status,m.round_label,m.bracket_label,m.best_of_legs,m.legs_to_win,
                m.player_a_id,m.player_b_id,m.winner_player_id,m.starts_at,m.finished_at,
                pa.display_name AS player_a_name,pb.display_name AS player_b_name
           FROM \`${this.runtimePrefix}matches\` m
           INNER JOIN \`${this.runtimePrefix}players\` pa ON pa.id=m.player_a_id
           INNER JOIN \`${this.runtimePrefix}players\` pb ON pb.id=m.player_b_id
          WHERE m.kiosk_id=? AND m.status IN ('in_progress','assigned')
          ORDER BY FIELD(m.status,'in_progress','assigned'),m.id ASC LIMIT 1`,
        [kioskId],
      );
      const match = matchRows[0];
      const kioskPayload = this.formatKiosk(kiosk);
      if (!match) {
        return {
          kiosk: kioskPayload,
          state: "idle",
          message: "No assigned or active match for this kiosk.",
        };
      }

      const matchId = id(match.id, "match_id");
      const playerAId = id(match.player_a_id, "player_a_id");
      const playerBId = id(match.player_b_id, "player_b_id");
      const status = String(match.status ?? "");
      let leg: LegRow | null = null;
      let remainingA = 501;
      let remainingB = 501;
      let currentPlayerId: string | null = playerAId;

      if (status === "assigned") {
        const legRows = await db.query<LegRow>(
          `SELECT id,leg_number,starting_player_id,status
             FROM \`${this.runtimePrefix}legs\`
            WHERE match_id=? AND status IN ('pending','in_progress')
            ORDER BY leg_number DESC LIMIT 1`,
          [matchId],
        );
        leg = legRows[0] ?? null;
      } else if (status === "in_progress") {
        const legRows = await db.query<LegRow>(
          `SELECT id,leg_number,starting_player_id,status
             FROM \`${this.runtimePrefix}legs\`
            WHERE match_id=? AND status IN ('pending','in_progress')
            ORDER BY leg_number DESC LIMIT 1`,
          [matchId],
        );
        leg = legRows[0] ?? null;
        if (!leg) {
          throw new DomainValidationError(
            "kiosk_state_invalid",
            "Aktiv kamp mangler et åpent canonical leg.",
            409,
          );
        }
        const legId = id(leg.id, "leg_id");
        const visitRows = await db.query<QueryResultRow>(
          `SELECT player_id,remaining_after
             FROM \`${this.runtimePrefix}visits\`
            WHERE leg_id=? ORDER BY id ASC`,
          [legId],
        );
        for (const visit of visitRows) {
          const playerId = id(visit.player_id, "visit_player_id");
          const remaining = numberValue(visit.remaining_after);
          if (playerId === playerAId) remainingA = remaining;
          if (playerId === playerBId) remainingB = remaining;
        }
        const starterId = leg.starting_player_id == null ? playerAId : id(leg.starting_player_id, "starting_player_id");
        const otherId = starterId === playerAId ? playerBId : playerAId;
        currentPlayerId = visitRows.length % 2 === 0 ? starterId : otherId;
      }

      const winRows = await db.query<QueryResultRow>(
        `SELECT winner_player_id,COUNT(*) AS win_count
           FROM \`${this.runtimePrefix}legs\`
          WHERE match_id=? AND winner_player_id IS NOT NULL
          GROUP BY winner_player_id`,
        [matchId],
      );
      let playerAWins = 0;
      let playerBWins = 0;
      for (const row of winRows) {
        const winnerId = id(row.winner_player_id, "winner_player_id");
        if (winnerId === playerAId) playerAWins = numberValue(row.win_count);
        if (winnerId === playerBId) playerBWins = numberValue(row.win_count);
      }

      const recentRows = await db.query<QueryResultRow>(
        `SELECT v.id,v.leg_id,v.player_id,p.display_name AS player_name,v.visit_number,v.score,
                v.darts_used,v.input_mode,v.is_bust,v.remaining_after,v.created_at
           FROM \`${this.runtimePrefix}visits\` v
           INNER JOIN \`${this.runtimePrefix}players\` p ON p.id=v.player_id
          WHERE v.match_id=? ORDER BY v.id DESC LIMIT 8`,
        [matchId],
      );
      const recentVisits = recentRows.map((row) => ({
        id: id(row.id, "visit_id"),
        leg_id: id(row.leg_id, "visit_leg_id"),
        player_id: id(row.player_id, "visit_player_id"),
        player_name: String(row.player_name ?? ""),
        visit_number: numberValue(row.visit_number),
        score: numberValue(row.score),
        darts_used: numberValue(row.darts_used),
        input_mode: String(row.input_mode ?? "sum"),
        is_bust: numberValue(row.is_bust),
        remaining_after: numberValue(row.remaining_after),
        created_at: row.created_at ?? null,
      }));

      const currentLeg = leg
        ? {
            id: id(leg.id, "leg_id"),
            leg_number: numberValue(leg.leg_number),
            starting_player_id: leg.starting_player_id == null ? null : id(leg.starting_player_id, "starting_player_id"),
            status: String(leg.status ?? "pending"),
          }
        : {
            id: null,
            leg_number: 1,
            starting_player_id: playerAId,
            status: "pending",
          };

      return {
        kiosk: kioskPayload,
        state: status,
        match: {
          id: matchId,
          status,
          round_label: match.round_label ?? null,
          bracket_label: match.bracket_label ?? null,
          best_of_legs: numberValue(match.best_of_legs),
          legs_to_win: numberValue(match.legs_to_win),
          player_a: {
            id: playerAId,
            display_name: String(match.player_a_name ?? ""),
            remaining: remainingA,
            legs_won: playerAWins,
          },
          player_b: {
            id: playerBId,
            display_name: String(match.player_b_name ?? ""),
            remaining: remainingB,
            legs_won: playerBWins,
          },
          winner_player_id: match.winner_player_id == null ? null : id(match.winner_player_id, "winner_player_id"),
          starts_at: match.starts_at ?? null,
          finished_at: match.finished_at ?? null,
          current_leg: currentLeg,
          current_player_id: currentPlayerId,
          recent_visits: recentVisits,
        },
      };
    });
  }

  private async kioskWith(db: SqlExecutor, kioskId: string): Promise<KioskRow | null> {
    const rows = await db.query<KioskRow>(
      `SELECT k.id,k.club_id,c.name AS club_name,c.logo_url AS club_logo_url,k.code,k.name,k.board_number,
              k.sponsor_label,k.sponsor_logo_url,k.scoring_mode,k.pairing_token_hash,k.paired_device_name,k.paired_at
         FROM \`${this.runtimePrefix}kiosks\` k
         INNER JOIN \`${this.runtimePrefix}clubs\` c ON c.id=k.club_id
        WHERE k.id=? AND k.is_active=1 LIMIT 1`,
      [kioskId],
    );
    return rows[0] ?? null;
  }

  private formatKiosk(kiosk: KioskRow): Record<string, unknown> {
    return {
      id: id(kiosk.id, "kiosk_id"),
      code: String(kiosk.code ?? ""),
      name: String(kiosk.name ?? ""),
      club: {
        id: id(kiosk.club_id, "club_id"),
        name: kiosk.club_name ?? null,
        logo_url: kiosk.club_logo_url ?? null,
      },
      board_number: numberValue(kiosk.board_number),
      sponsor_label: kiosk.sponsor_label ?? null,
      sponsor_logo_url: kiosk.sponsor_logo_url ?? null,
      scoring_mode: String(kiosk.scoring_mode ?? "manual") || "manual",
      is_paired: String(kiosk.pairing_token_hash ?? "").trim() !== "",
      paired_device_name: kiosk.paired_device_name ?? null,
      paired_at: kiosk.paired_at ?? null,
    };
  }
}

function decodeCode(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (raw === "") return "";
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    throw new DomainValidationError("invalid_kiosk_code", "Kiosk code is not valid URL encoding.", 400);
  }
}

function id(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new DomainValidationError(`invalid_${name}`, `${name} must be a positive decimal id.`, 500);
  }
  return value;
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
