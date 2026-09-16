import bcrypt from "bcryptjs";

import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, TablePrefix } from "./contracts.js";

export type KioskInputMode = "sum" | "per_dart";

export interface KioskPlayerPreferencePlayer {
  readonly id: string;
  readonly display_name: string;
  readonly preferred_input_mode: string | null;
}

export interface KioskPlayerPreferenceState {
  readonly match_id: string | null;
  readonly current_player_id: string | null;
  readonly players: readonly KioskPlayerPreferencePlayer[];
}

interface KioskRow extends QueryResultRow {
  readonly id: unknown;
  readonly pairing_token_hash: unknown;
}

interface MatchRow extends QueryResultRow {
  readonly id: unknown;
  readonly status: unknown;
  readonly player_a_id: unknown;
  readonly player_b_id: unknown;
}

interface LegRow extends QueryResultRow {
  readonly id: unknown;
  readonly starting_player_id: unknown;
}

interface PlayerRow extends QueryResultRow {
  readonly id: unknown;
  readonly display_name: unknown;
  readonly preferred_input_mode: unknown;
}

/** Runtime-only persistence for the legacy kiosk player input preference surface. */
export class MySqlKioskPlayerPreferenceRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
  ) {}

  async resolvePairedKiosk(codeInput: unknown, tokenInput: unknown): Promise<string> {
    const code = String(codeInput ?? "").trim();
    const token = String(tokenInput ?? "").trim();

    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<KioskRow>(
        `SELECT id,pairing_token_hash
           FROM \`${this.runtimePrefix}kiosks\`
          WHERE code=? AND is_active=1 LIMIT 1`,
        [code],
      );
      const kiosk = rows[0];
      if (!kiosk) {
        throw new DomainValidationError("kiosk_not_found", "Kiosken finnes ikke.", 404);
      }

      const hash = String(kiosk.pairing_token_hash ?? "").trim();
      if (hash === "" || !await bcrypt.compare(token, hash)) {
        throw new DomainValidationError(
          "kiosk_pairing_invalid",
          "Pairingen er ikke gyldig for denne terminalen.",
          403,
        );
      }
      return id(kiosk.id, "kiosk_id");
    });
  }

  async stateForKiosk(kioskIdInput: unknown): Promise<KioskPlayerPreferenceState> {
    const kioskId = id(kioskIdInput, "kiosk_id");
    return this.sessions.withConnection(async (db) => {
      const matches = await db.query<MatchRow>(
        `SELECT id,status,player_a_id,player_b_id
           FROM \`${this.runtimePrefix}matches\`
          WHERE kiosk_id=? AND status IN ('in_progress','assigned')
          ORDER BY FIELD(status,'in_progress','assigned'),id ASC
          LIMIT 1`,
        [kioskId],
      );
      const match = matches[0];
      if (!match) {
        return { match_id: null, current_player_id: null, players: [] };
      }

      const matchId = id(match.id, "match_id");
      const playerAId = id(match.player_a_id, "player_a_id");
      const playerBId = id(match.player_b_id, "player_b_id");
      let currentPlayerId = playerAId;

      if (String(match.status ?? "") === "in_progress") {
        const legs = await db.query<LegRow>(
          `SELECT id,starting_player_id
             FROM \`${this.runtimePrefix}legs\`
            WHERE match_id=? AND status IN ('pending','in_progress')
            ORDER BY leg_number DESC
            LIMIT 1`,
          [matchId],
        );
        const leg = legs[0];
        if (leg) {
          const legId = id(leg.id, "leg_id");
          const visitCounts = await db.query<QueryResultRow>(
            `SELECT COUNT(*) AS total_visits FROM \`${this.runtimePrefix}visits\` WHERE leg_id=?`,
            [legId],
          );
          const totalVisits = nonNegativeInteger(visitCounts[0]?.total_visits);
          const startingPlayerId = id(leg.starting_player_id, "starting_player_id");
          const otherPlayerId = startingPlayerId === playerAId ? playerBId : playerAId;
          currentPlayerId = totalVisits % 2 === 0 ? startingPlayerId : otherPlayerId;
        }
      }

      const players = await db.query<PlayerRow>(
        `SELECT id,display_name,preferred_input_mode
           FROM \`${this.runtimePrefix}players\`
          WHERE id IN (?,?)
          ORDER BY FIELD(id,?,?)`,
        [playerAId, playerBId, playerAId, playerBId],
      );

      return {
        match_id: matchId,
        current_player_id: currentPlayerId,
        players: players.map((player) => ({
          id: id(player.id, "player_id"),
          display_name: String(player.display_name ?? ""),
          preferred_input_mode: player.preferred_input_mode == null ? null : String(player.preferred_input_mode),
        })),
      };
    });
  }

  async updatePreference(playerIdInput: unknown, mode: KioskInputMode): Promise<void> {
    const playerId = id(playerIdInput, "player_id");
    await this.sessions.withConnection(async (db) => {
      await db.execute(
        `UPDATE \`${this.runtimePrefix}players\` SET preferred_input_mode=? WHERE id=?`,
        [mode, playerId],
      );
    });
  }
}

function id(value: unknown, name: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new DomainValidationError(`invalid_${name}`, `${name} must be a positive decimal id.`, 500);
  }
  return normalized;
}

function nonNegativeInteger(value: unknown): number {
  const normalized = String(value ?? "0").trim();
  if (!/^[0-9]+$/.test(normalized)) return 0;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
