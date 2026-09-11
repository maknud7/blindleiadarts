import bcrypt from "bcryptjs";

import { DomainValidationError } from "../domain/errors.js";
import type { IdentityUser } from "./identity-auth-repository.js";
import type { MySqlSessionProvider, QueryResultRow, TablePrefix } from "./contracts.js";

interface PlayerRow extends QueryResultRow {
  id: string | number;
  club_id: string | number | null;
  member_id: string | number | null;
  display_name: string | null;
  nickname: string | null;
  avatar_url: string | null;
}

export class MySqlAccountProfileRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
    private readonly identityPrefix: TablePrefix,
  ) {}

  async profileForUser(user: IdentityUser): Promise<Record<string, unknown>> {
    const playerId = decimalId(user.player_id);
    let player: PlayerRow | null = null;
    if (playerId !== null) {
      player = await this.sessions.withConnection(async (db) => {
        const rows = await db.query<PlayerRow>(
          `SELECT id, club_id, member_id, display_name, nickname, avatar_url
             FROM \`${this.runtimePrefix}players\` WHERE id = ? LIMIT 1`,
          [playerId],
        );
        return rows[0] ?? null;
      });
    }

    return {
      user_id: safeNumber(user.id) ?? 0,
      email: stringValue(user.email),
      display_name: stringValue(player?.display_name) || stringValue(user.display_name),
      nickname: nullableString(player?.nickname),
      avatar_url: nullableString(player?.avatar_url),
      player_id: safeNumber(playerId),
      club_id: safeNumber(player?.club_id),
      member_id: safeNumber(player?.member_id) ?? safeNumber(user.member_id),
    };
  }

  async membershipAndPayments(user: IdentityUser): Promise<Record<string, unknown>> {
    const profile = await this.profileForUser(user);
    const memberId = decimalId(profile.member_id);
    const clubId = decimalId(profile.club_id);
    let membership: Record<string, unknown> | null = null;

    if (memberId !== null) {
      membership = await this.sessions.withConnection(async (db) => {
        const members = await db.query<QueryResultRow>(
          `SELECT id, medlemsnummer, navn, innmeldingsdato, rolle, betalingsstatus_override,
                  kontingent_start, kontingent_slutt, maanedsbelop
             FROM \`medlemmer\` WHERE id = ? LIMIT 1`,
          [memberId],
        );
        const member = members[0];
        if (!member) return null;
        const memberNumber = decimalId(member.medlemsnummer);
        const paymentRows = memberNumber === null
          ? []
          : await db.query<QueryResultRow>(
              `SELECT dato, periode, belop, kilde
                 FROM \`kontingentbetalinger\`
                WHERE medlemsnummer = ? ORDER BY dato DESC, id DESC`,
              [memberNumber],
            );
        const payments = paymentRows.map((row) => ({
          date: row.dato ?? null,
          period: row.periode ?? null,
          amount: numericOrNull(row.belop),
          source: row.kilde ?? null,
        }));
        return {
          member_id: safeNumber(member.id),
          member_number: safeNumber(memberNumber) ?? 0,
          member_name: member.navn ?? null,
          joined_at: member.innmeldingsdato ?? null,
          role: member.rolle ?? null,
          status_override: member.betalingsstatus_override ?? null,
          dues_start: member.kontingent_start ?? null,
          dues_end: member.kontingent_slutt ?? null,
          monthly_amount: numericOrNull(member.maanedsbelop),
          latest_payment: payments[0] ?? null,
          payments,
          payment_count: payments.length,
        };
      });
    }

    return {
      membership,
      payment_options: await this.publicPaymentOptions(clubId, memberId),
    };
  }

  async updateProfile(user: IdentityUser, displayNameInput: unknown, nicknameInput: unknown): Promise<Record<string, unknown>> {
    const displayName = normalizeWhitespace(typeof displayNameInput === "string" ? displayNameInput : "");
    const nickname = normalizeWhitespace(typeof nicknameInput === "string" ? nicknameInput : "");
    if (displayName.length < 2 || displayName.length > 150) {
      throw new DomainValidationError("profile_name_invalid", "Navnet må være mellom 2 og 150 tegn.");
    }
    if (nickname.length > 120) {
      throw new DomainValidationError("profile_nickname_invalid", "Kallenavnet kan være maks 120 tegn.");
    }
    const userId = decimalId(user.id);
    const playerId = decimalId(user.player_id);
    if (userId === null) throw new DomainValidationError("profile_account_missing", "Brukerkontoen kunne ikke finnes.", 404);

    await this.sessions.withTransaction(async (db) => {
      if (this.identityPrefix === this.runtimePrefix) {
        await db.execute(
          `UPDATE \`${this.identityPrefix}user_accounts\` SET display_name = ?, updated_at = NOW() WHERE id = ?`,
          [displayName, userId],
        );
      }
      if (playerId !== null) {
        await db.execute(
          `UPDATE \`${this.runtimePrefix}players\` SET display_name = ?, nickname = ?, updated_at = NOW() WHERE id = ?`,
          [displayName, nickname === "" ? null : nickname, playerId],
        );
      }
    });

    const updated = { ...user, display_name: displayName, player_display_name: playerId ? displayName : user.player_display_name };
    const profile = await this.profileForUser(updated);
    return { ...profile, nickname: nickname === "" ? null : nickname };
  }

  async changePassword(user: IdentityUser, currentPasswordInput: unknown, newPasswordInput: unknown): Promise<void> {
    const currentPassword = typeof currentPasswordInput === "string" ? currentPasswordInput : "";
    const newPassword = typeof newPasswordInput === "string" ? newPasswordInput : "";
    const userId = decimalId(user.id);
    const sessionId = decimalId(user.session_id);
    if (userId === null) throw new DomainValidationError("profile_account_missing", "Brukerkontoen kunne ikke finnes.", 404);
    if (currentPassword === "") throw new DomainValidationError("current_password_required", "Skriv inn nåværende passord.");
    if (newPassword.length < 8) throw new DomainValidationError("password_too_short", "Det nye passordet må være minst 8 tegn.");
    if (currentPassword === newPassword) throw new DomainValidationError("password_unchanged", "Velg et annet passord enn det du bruker nå.");

    const currentHash = await this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT password_hash FROM \`${this.identityPrefix}user_accounts\` WHERE id = ? AND is_active = 1 LIMIT 1`,
        [userId],
      );
      return typeof rows[0]?.password_hash === "string" ? rows[0].password_hash : "";
    });
    if (currentHash === "" || !(await bcrypt.compare(currentPassword, normalizePhpBcrypt(currentHash)))) {
      throw new DomainValidationError("current_password_invalid", "Nåværende passord er ikke riktig.");
    }
    const newHash = await bcrypt.hash(newPassword, 10);

    await this.sessions.withTransaction(async (db) => {
      await db.execute(
        `UPDATE \`${this.identityPrefix}user_accounts\` SET password_hash = ?, updated_at = NOW() WHERE id = ?`,
        [newHash, userId],
      );
      if (sessionId !== null) {
        await db.execute(
          `UPDATE \`${this.identityPrefix}auth_sessions\` SET revoked_at = NOW()
            WHERE user_account_id = ? AND id <> ? AND revoked_at IS NULL`,
          [userId, sessionId],
        );
      } else {
        await db.execute(
          `UPDATE \`${this.identityPrefix}auth_sessions\` SET revoked_at = NOW()
            WHERE user_account_id = ? AND revoked_at IS NULL`,
          [userId],
        );
      }
    });
  }

  async publicPaymentOptions(clubIdInput: unknown, memberIdInput: unknown): Promise<Record<string, unknown>> {
    const clubId = decimalId(clubIdInput);
    const memberId = decimalId(memberIdInput);
    if (clubId === null) return emptyPaymentOptions();

    return this.sessions.withConnection(async (db) => {
      const clubs = await db.query<QueryResultRow>(
        `SELECT id, name, slug FROM \`${this.runtimePrefix}clubs\` WHERE id = ? LIMIT 1`,
        [clubId],
      );
      const club = clubs[0] ?? null;
      const rows = await db.query<QueryResultRow>(
        `SELECT setting_key, setting_value FROM \`${this.runtimePrefix}settings\` WHERE club_id = ?`,
        [clubId],
      );
      const settings = new Map(rows.map((row) => [String(row.setting_key), nullableString(row.setting_value)]));
      const value = (key: string): string | null => {
        const raw = settings.get(key)?.trim() ?? "";
        return raw === "" ? null : raw;
      };
      let stripeSubscription: Record<string, unknown> | null = null;
      if (memberId !== null) {
        const exists = await db.query<QueryResultRow>(
          `SELECT 1 AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'stripe_abonnementer' LIMIT 1`,
        );
        if (exists.length > 0) {
          const subscriptions = await db.query<QueryResultRow>(
            `SELECT status, cancel_at_period_end, ended_at, updated_at
               FROM \`stripe_abonnementer\` WHERE member_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`,
            [memberId],
          );
          const row = subscriptions[0];
          if (row) {
            const status = stringValue(row.status).toLowerCase() || "unknown";
            stripeSubscription = {
              status,
              active: status === "active" || status === "trialing",
              cancel_at_period_end: String(row.cancel_at_period_end ?? "0") === "1",
              ended_at: row.ended_at ?? null,
              updated_at: row.updated_at ?? null,
            };
          }
        }
      }
      const name = nullableString(club?.name);
      const slug = stringValue(club?.slug).toLowerCase();
      const lowerName = (name ?? "").toLowerCase();
      const legacyStripe = lowerName.includes("blindleia") || slug.includes("blindleia")
        ? "https://dart.ingenting.org/stripe_kontingent.php"
        : null;
      const missed = Math.max(0, Math.min(12, Number(value("membership.registration_block_after_missed_months") ?? "3") || 3));
      return {
        club_name: name,
        stripe_start_url: value("membership.stripe_start_url") ?? legacyStripe,
        stripe_portal_url: value("membership.stripe_portal_url"),
        stripe_subscription: stripeSubscription,
        vipps_name: value("membership.vipps_name") ?? name,
        vipps_number: value("membership.vipps_number"),
        vipps_one_time_url: value("membership.vipps_one_time_url"),
        payment_contact: value("membership.payment_contact"),
        registration_block_after_missed_months: missed,
      };
    });
  }
}

function normalizePhpBcrypt(hash: string): string {
  return hash.startsWith("$2y$") ? `$2b$${hash.slice(4)}` : hash;
}
function decimalId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}
function safeNumber(value: unknown): number | null {
  const id = decimalId(value);
  if (id === null) return null;
  const parsed = Number(id);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function nullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
function numericOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}
function emptyPaymentOptions(): Record<string, unknown> {
  return {
    club_name: null,
    stripe_start_url: null,
    stripe_portal_url: null,
    stripe_subscription: null,
    vipps_name: null,
    vipps_number: null,
    vipps_one_time_url: null,
    payment_contact: null,
    registration_block_after_missed_months: 3,
  };
}
