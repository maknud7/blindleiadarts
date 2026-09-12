import bcrypt from "bcryptjs";

import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, TablePrefix } from "./contracts.js";

export interface PairedKioskContext {
  readonly kiosk_id: string;
  readonly club_id: string;
  readonly code: string;
}

export class MySqlScoliaKioskAuthRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
  ) {}

  async resolve(codeInput: unknown, tokenInput: unknown, touch = true): Promise<PairedKioskContext> {
    const code = decodeURIComponent(String(codeInput ?? "")).trim();
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
}

function id(value: unknown, name: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new DomainValidationError(`invalid_${name}`, `${name} must be a positive decimal id.`);
  return normalized;
}
