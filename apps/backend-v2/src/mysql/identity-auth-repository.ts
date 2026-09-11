import { createHash, randomBytes } from "node:crypto";

import type { MySqlSessionProvider, QueryResultRow, TablePrefix } from "./contracts.js";

export interface IdentityUser extends QueryResultRow {
  id: string | number;
  email: string | null;
  password_hash?: string | null;
  display_name: string | null;
  account_status: string | null;
  role: string | null;
  is_active: string | number | null;
  contact_phone: string | null;
  player_id: string | number | null;
  player_display_name: string | null;
  player_club_id: string | number | null;
  member_id: string | number | null;
  admin_club_ids: string | null;
  global_roles: string | null;
  session_id?: string | number | null;
  expires_at?: string | null;
  last_used_at?: string | null;
}

export interface SessionToken {
  token: string;
  expiresAt: string;
}

export class MySqlIdentityAuthRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
    private readonly identityPrefix: TablePrefix,
  ) {}

  async findByEmail(email: string): Promise<IdentityUser | null> {
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<IdentityUser>(
        this.identitySelectSql("WHERE LOWER(ua.email) = LOWER(?) LIMIT 1", false),
        [email.trim().toLowerCase()],
      );
      return rows[0] ?? null;
    });
  }

  async findBySessionToken(token: string, touchSession: boolean): Promise<IdentityUser | null> {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const row = await this.sessions.withConnection(async (db) => {
      const rows = await db.query<IdentityUser>(
        this.identitySelectSql(
          `WHERE s.session_token_hash = ?
             AND s.revoked_at IS NULL
             AND ua.is_active = 1
             AND ua.account_status = 'active'
           LIMIT 1`,
          true,
        ),
        [tokenHash],
      );
      return rows[0] ?? null;
    });
    if (row === null) return null;
    if (row.expires_at && Date.parse(`${row.expires_at.replace(" ", "T")}Z`) < Date.now()) return null;

    if (touchSession && shouldTouch(row.last_used_at ?? null)) {
      const sessionId = decimalId(row.session_id);
      if (sessionId !== null) {
        await this.sessions.withConnection(async (db) => {
          await db.execute(
            `UPDATE \`${this.identityPrefix}auth_sessions\`
                SET last_used_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL 180 DAY)
              WHERE id = ?`,
            [sessionId],
          );
        });
      }
    }
    return row;
  }

  async createSession(userAccountId: string): Promise<SessionToken> {
    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expires = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
    const expiresAt = mysqlDateTime(expires);

    await this.sessions.withTransaction(async (db) => {
      await db.execute(
        `INSERT INTO \`${this.identityPrefix}auth_sessions\`
          (user_account_id, session_token_hash, expires_at, last_used_at)
         VALUES (?, ?, ?, NOW())`,
        [userAccountId, tokenHash, expiresAt],
      );
      await db.execute(
        `UPDATE \`${this.identityPrefix}user_accounts\` SET last_login_at = NOW() WHERE id = ?`,
        [userAccountId],
      );
    });
    return { token, expiresAt };
  }

  async recordAudit(userAccountId: string | null, clubId: string | null, eventName: string): Promise<void> {
    const allowed = new Set([
      "login_success",
      "login_failed_credentials_required",
      "login_failed_invalid_credentials",
      "login_failed_account_inactive",
    ]);
    if (!allowed.has(eventName)) throw new TypeError("Invalid auth audit event.");
    await this.sessions.withConnection(async (db) => {
      await db.execute(
        `INSERT INTO \`${this.runtimePrefix}activity_events\`
          (occurred_at,user_account_id,club_id,surface,event_name,path,metadata_json)
         VALUES (NOW(),?,?,?,?,?,?)`,
        [userAccountId, clubId, "auth", eventName, "/api/v1/auth/login", JSON.stringify({ source: "backend_v2_email_auth" })],
      );
    });
  }

  private identitySelectSql(whereSql: string, withSession: boolean): string {
    const users = `${this.identityPrefix}user_accounts`;
    const globalRoles = `${this.identityPrefix}global_user_roles`;
    const clubRoles = `${this.identityPrefix}club_user_roles`;
    const identityPlayers = `${this.identityPrefix}players`;
    const identityClubs = `${this.identityPrefix}clubs`;
    const localPlayers = `${this.runtimePrefix}players`;
    const localClubs = `${this.runtimePrefix}clubs`;
    const sessions = `${this.identityPrefix}auth_sessions`;

    const adminClubIdsSql = this.identityPrefix === this.runtimePrefix
      ? `(SELECT GROUP_CONCAT(cur.club_id ORDER BY cur.club_id SEPARATOR ',')
           FROM \`${clubRoles}\` cur
          WHERE cur.user_account_id = ua.id AND cur.role = 'club_admin')`
      : `(SELECT GROUP_CONCAT(lc.id ORDER BY lc.id SEPARATOR ',')
           FROM \`${clubRoles}\` cur
           INNER JOIN \`${identityClubs}\` ic ON ic.id = cur.club_id
           INNER JOIN \`${localClubs}\` lc ON lc.slug = ic.slug
          WHERE cur.user_account_id = ua.id AND cur.role = 'club_admin')`;
    const sessionSelect = withSession
      ? ", s.id AS session_id, s.expires_at, s.revoked_at, s.last_used_at"
      : "";
    const sessionJoin = withSession ? `INNER JOIN \`${sessions}\` s ON s.user_account_id = ua.id` : "";
    const passwordSelect = withSession ? "" : "ua.password_hash,";

    return `SELECT
      ua.id,
      ua.email,
      ${passwordSelect}
      ua.display_name,
      ua.account_status,
      CASE
        WHEN EXISTS (SELECT 1 FROM \`${globalRoles}\` gur WHERE gur.user_account_id = ua.id AND gur.role = 'super_admin') THEN 'super_admin'
        WHEN EXISTS (SELECT 1 FROM \`${clubRoles}\` cur0 WHERE cur0.user_account_id = ua.id AND cur0.role = 'club_admin') THEN 'club_admin'
        ELSE 'player'
      END AS role,
      ua.is_active,
      ua.contact_phone,
      p.id AS player_id,
      p.display_name AS player_display_name,
      p.club_id AS player_club_id,
      COALESCE(ua.member_id, ip.member_id, p.member_id) AS member_id,
      ${adminClubIdsSql} AS admin_club_ids,
      (SELECT GROUP_CONCAT(gur.role ORDER BY gur.role SEPARATOR ',') FROM \`${globalRoles}\` gur WHERE gur.user_account_id = ua.id) AS global_roles
      ${sessionSelect}
    FROM \`${users}\` ua
    ${sessionJoin}
    LEFT JOIN \`${identityPlayers}\` ip ON ip.id = ua.player_id
    LEFT JOIN \`${localPlayers}\` p ON p.id = (
      SELECT MIN(p2.id) FROM \`${localPlayers}\` p2 WHERE p2.member_id = COALESCE(ua.member_id, ip.member_id)
    )
    ${whereSql}`;
  }
}

function decimalId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}

function shouldTouch(lastUsedAt: string | null): boolean {
  if (!lastUsedAt) return true;
  const parsed = Date.parse(`${lastUsedAt.replace(" ", "T")}Z`);
  return !Number.isFinite(parsed) || parsed <= Date.now() - 5 * 60 * 1000;
}

function mysqlDateTime(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}
