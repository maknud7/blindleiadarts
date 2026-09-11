import bcrypt from "bcryptjs";

import { RuntimeAccessError } from "../runtime/config.js";
import type { IdentityUser, MySqlIdentityAuthRepository } from "../mysql/identity-auth-repository.js";

export interface AuthUserPayload {
  id: number | null;
  email: string | null;
  username: string | null;
  display_name: string | null;
  role: string | null;
  is_super_admin: boolean;
  contact_email: string | null;
  contact_phone: string | null;
  player: {
    id: number | null;
    display_name: string | null;
    club_id: number | null;
  };
}

export class IdentityAuthService {
  constructor(private readonly repository: MySqlIdentityAuthRepository) {}

  async login(emailInput: unknown, passwordInput: unknown): Promise<{
    token_type: "Bearer";
    access_token: string;
    expires_at: string;
    user: AuthUserPayload;
  }> {
    const email = typeof emailInput === "string" ? emailInput.trim().toLowerCase() : "";
    const password = typeof passwordInput === "string" ? passwordInput : "";
    if (!isEmail(email) || password === "") {
      await this.safeAudit(null, null, "login_failed_credentials_required");
      throw new RuntimeAccessError(422, "credentials_required", "Skriv inn gyldig e-postadresse og passord.");
    }

    const user = await this.repository.findByEmail(email);
    const userId = user ? decimalId(user.id) : null;
    const clubId = user ? decimalId(user.player_club_id) : null;
    const hash = user?.password_hash ?? "";
    const validPassword = hash !== "" && await bcrypt.compare(password, normalizePhpBcrypt(hash));
    if (user === null || !validPassword) {
      await this.safeAudit(userId, clubId, "login_failed_invalid_credentials");
      throw new RuntimeAccessError(401, "invalid_credentials", "Ugyldig e-post eller passord.");
    }
    if (String(user.is_active ?? "0") !== "1" || String(user.account_status ?? "active") !== "active") {
      await this.safeAudit(userId, clubId, "login_failed_account_inactive");
      throw new RuntimeAccessError(403, "account_inactive", "Denne kontoen er ikke aktiv.");
    }
    if (userId === null) throw new RuntimeAccessError(500, "identity_invalid", "Brukerkontoen mangler gyldig id.");

    const session = await this.repository.createSession(userId);
    await this.safeAudit(userId, clubId, "login_success");
    return {
      token_type: "Bearer",
      access_token: session.token,
      expires_at: session.expiresAt,
      user: formatAuthUser(user),
    };
  }

  async me(token: string | null, touchSession: boolean): Promise<{ user: AuthUserPayload }> {
    if (!token) throw new RuntimeAccessError(401, "missing_bearer_token", "Innlogging kreves.");
    const user = await this.repository.findBySessionToken(token, touchSession);
    if (user === null) throw new RuntimeAccessError(401, "invalid_session", "Innloggingen er utløpt eller ugyldig.");
    return { user: formatAuthUser(user) };
  }

  private async safeAudit(userId: string | null, clubId: string | null, event: string): Promise<void> {
    try {
      await this.repository.recordAudit(userId, clubId, event);
    } catch {
      // Audit is auxiliary and must not change authentication semantics.
    }
  }
}

export function formatAuthUser(user: IdentityUser): AuthUserPayload {
  const email = typeof user.email === "string" && user.email !== "" ? user.email : null;
  const role = typeof user.role === "string" ? user.role : null;
  return {
    id: safeNumber(user.id),
    email,
    username: email,
    display_name: typeof user.display_name === "string" ? user.display_name : null,
    role,
    is_super_admin: role === "super_admin",
    contact_email: email,
    contact_phone: typeof user.contact_phone === "string" ? user.contact_phone : null,
    player: {
      id: safeNumber(user.player_id),
      display_name: typeof user.player_display_name === "string" ? user.player_display_name : null,
      club_id: safeNumber(user.player_club_id),
    },
  };
}

export function normalizePhpBcrypt(hash: string): string {
  return hash.startsWith("$2y$") ? `$2b$${hash.slice(4)}` : hash;
}

function safeNumber(value: unknown): number | null {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function decimalId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
