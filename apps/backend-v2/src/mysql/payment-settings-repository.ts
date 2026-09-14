import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, TablePrefix } from "./contracts.js";

const FIELD_TO_KEY = {
  stripe_start_url: "membership.stripe_start_url",
  stripe_portal_url: "membership.stripe_portal_url",
  vipps_name: "membership.vipps_name",
  vipps_number: "membership.vipps_number",
  vipps_one_time_url: "membership.vipps_one_time_url",
  payment_contact: "membership.payment_contact",
  registration_block_after_missed_months: "membership.registration_block_after_missed_months",
} as const;

type PaymentField = keyof typeof FIELD_TO_KEY;

interface ClubRow extends QueryResultRow {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly slug?: unknown;
}

interface SettingRow extends QueryResultRow {
  readonly setting_key?: unknown;
  readonly setting_value?: unknown;
}

export class MySqlPaymentSettingsRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly prefix: TablePrefix,
  ) {}

  async adminSettings(clubIdInput: unknown): Promise<Record<string, unknown>> {
    const clubId = requiredId(clubIdInput, "club_id");
    return this.sessions.withConnection(async (db) => {
      const clubs = await db.query<ClubRow>(
        `SELECT id, name, slug FROM \`${this.prefix}clubs\` WHERE id = ? LIMIT 1`,
        [clubId],
      );
      const club = clubs[0] ?? null;
      if (club === null) {
        throw new DomainValidationError("club_not_found", "Klubben finnes ikke.", 404);
      }
      const rows = await db.query<SettingRow>(
        `SELECT setting_key, setting_value FROM \`${this.prefix}settings\` WHERE club_id = ?`,
        [clubId],
      );
      return formatAdminSettings(clubId, club, settingsMap(rows));
    });
  }

  async saveAdminSettings(clubIdInput: unknown, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const clubId = requiredId(clubIdInput, "club_id");
    const changes = normalizeChanges(payload);

    await this.sessions.withTransaction(async (db) => {
      const clubs = await db.query<ClubRow>(
        `SELECT id FROM \`${this.prefix}clubs\` WHERE id = ? LIMIT 1 FOR UPDATE`,
        [clubId],
      );
      if (clubs.length === 0) {
        throw new DomainValidationError("club_not_found", "Klubben finnes ikke.", 404);
      }

      for (const change of changes) {
        if (change.delete) {
          await db.execute(
            `DELETE FROM \`${this.prefix}settings\` WHERE club_id = ? AND setting_key = ?`,
            [clubId, FIELD_TO_KEY[change.field]],
          );
          continue;
        }
        await db.execute(
          `INSERT INTO \`${this.prefix}settings\` (club_id, setting_key, setting_value)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = NOW()`,
          [clubId, FIELD_TO_KEY[change.field], change.value],
        );
      }
    });

    return this.adminSettings(clubId);
  }
}

function normalizeChanges(payload: Record<string, unknown>): Array<{ field: PaymentField; value: string; delete: boolean }> {
  const changes: Array<{ field: PaymentField; value: string; delete: boolean }> = [];
  const fields = Object.keys(FIELD_TO_KEY) as PaymentField[];
  const urlFields = new Set<PaymentField>(["stripe_start_url", "stripe_portal_url", "vipps_one_time_url"]);

  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;

    let value: string;
    if (field === "registration_block_after_missed_months") {
      const raw = stringValue(payload[field]).trim();
      if (raw === "") {
        value = "3";
      } else if (!/^\d{1,2}$/.test(raw)) {
        throw new DomainValidationError(
          "payment_policy_invalid",
          "Påmeldingsgrensen må være et helt antall måneder fra 0 til 12.",
          422,
        );
      } else {
        const months = Number(raw);
        if (months < 0 || months > 12) {
          throw new DomainValidationError("payment_policy_invalid", "Påmeldingsgrensen må være fra 0 til 12 måneder.", 422);
        }
        value = String(months);
      }
    } else {
      value = stringValue(payload[field]).trim();
    }

    if (urlFields.has(field) && value !== "" && !isHttpUrl(value)) {
      throw new DomainValidationError("payment_url_invalid", "Betalingslenker må være gyldige http- eller https-adresser.", 422);
    }
    if (field === "vipps_number" && textLength(value) > 50) {
      throw new DomainValidationError("vipps_number_invalid", "Vipps-nummeret er for langt.", 422);
    }
    if (textLength(value) > 1000) {
      throw new DomainValidationError("payment_setting_too_long", "En betalingsinnstilling er for lang.", 422);
    }

    changes.push({
      field,
      value,
      delete: value === "" && field !== "registration_block_after_missed_months",
    });
  }

  return changes;
}

function formatAdminSettings(clubId: string, club: ClubRow, settings: Map<string, string | null>): Record<string, unknown> {
  const value = (key: string): string | null => {
    const raw = settings.get(key)?.trim() ?? "";
    return raw === "" ? null : raw;
  };
  const result: Record<string, unknown> = {
    club_id: publicId(clubId),
    club_name: nullableString(club.name),
    stripe_start_url_effective: value(FIELD_TO_KEY.stripe_start_url) ?? legacyStripeStartUrl(club),
  };
  for (const [field, key] of Object.entries(FIELD_TO_KEY)) {
    result[field] = value(key);
  }
  const rawMonths = value(FIELD_TO_KEY.registration_block_after_missed_months);
  result.registration_block_after_missed_months = rawMonths === null
    ? 3
    : Math.max(0, Math.min(12, Number.parseInt(rawMonths, 10) || 0));
  return result;
}

function settingsMap(rows: readonly SettingRow[]): Map<string, string | null> {
  return new Map(rows.map((row) => [String(row.setting_key ?? ""), nullableString(row.setting_value)]));
}

function legacyStripeStartUrl(club: ClubRow): string | null {
  const name = stringValue(club.name).toLocaleLowerCase("nb-NO");
  const slug = stringValue(club.slug).toLocaleLowerCase("nb-NO");
  return name.includes("blindleia") || slug.includes("blindleia")
    ? "https://dart.ingenting.org/stripe_kontingent.php"
    : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
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

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value);
  return normalized === "" ? null : normalized;
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function textLength(value: string): number {
  return Array.from(value).length;
}
