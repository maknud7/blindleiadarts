import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";

import { DomainValidationError } from "../domain/errors.js";
import type { MySqlSessionProvider, QueryResultRow, SqlExecutor, TablePrefix } from "./contracts.js";

export interface EquipmentScope {
  configuration_scope: "production_hardware";
  shared_across_environments: true;
  configuration_table_prefix: string;
  runtime_table_prefix: string;
}

export class MySqlEquipmentAdminRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
    private readonly hardwarePrefix: TablePrefix,
  ) {}

  scope(): EquipmentScope {
    return {
      configuration_scope: "production_hardware",
      shared_across_environments: true,
      configuration_table_prefix: this.hardwarePrefix,
      runtime_table_prefix: this.runtimePrefix,
    };
  }

  async listBoards(environmentClubIdInput: unknown, includeInactive = false): Promise<Record<string, unknown>[]> {
    const environmentClubId = requiredId(environmentClubIdInput, "club_id");
    return this.sessions.withConnection(async (db) => {
      const canonicalClubId = await this.canonicalClubIdWith(db, environmentClubId);
      const rows = await db.query<QueryResultRow>(
        `SELECT id,code,name,board_number,sponsor_label,sponsor_logo_url,scoring_mode,is_active,
                pairing_token_hash,paired_device_name,paired_at,last_seen_at
           FROM \`${this.hardwarePrefix}kiosks\`
          WHERE club_id=?${includeInactive ? "" : " AND is_active=1"}
          ORDER BY is_active DESC,board_number,id`,
        [canonicalClubId],
      );
      const result: Record<string, unknown>[] = [];
      for (const row of rows) {
        result.push(await this.publicBoardWith(db, environmentClubId, canonicalClubId, row));
      }
      return result;
    });
  }

  async isActiveBoard(environmentClubIdInput: unknown, physicalIdInput: unknown): Promise<boolean> {
    const environmentClubId = requiredId(environmentClubIdInput, "club_id");
    const physicalId = requiredId(physicalIdInput, "kiosk_id");
    return this.sessions.withConnection(async (db) => {
      const canonicalClubId = await this.canonicalClubIdWith(db, environmentClubId);
      const rows = await db.query<QueryResultRow>(
        `SELECT is_active FROM \`${this.hardwarePrefix}kiosks\` WHERE club_id=? AND id=? LIMIT 1`,
        [canonicalClubId, physicalId],
      );
      return numberValue(rows[0]?.is_active) === 1;
    });
  }

  async createBoard(environmentClubIdInput: unknown, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const environmentClubId = requiredId(environmentClubIdInput, "club_id");
    return this.sessions.withTransaction(async (db) => {
      const club = await this.environmentClubWith(db, environmentClubId);
      const canonicalClubId = await this.canonicalClubIdWith(db, environmentClubId);
      const boardNumber = Math.max(1, integerValue(payload.board_number, 1));
      const code = stringValue(payload.code) || await this.generateKioskCodeWith(
        db,
        stringValue(club.slug) || stringValue(club.name) || "club",
        boardNumber,
      );
      const name = stringValue(payload.name) || `Skive ${boardNumber}`;
      const sponsorLabel = nullableString(payload.sponsor_label);
      const sponsorLogoUrl = nullableString(payload.sponsor_logo_url);
      const scoringMode = normalizeScoringMode(payload.scoring_mode);
      const insert = await db.execute(
        `INSERT INTO \`${this.hardwarePrefix}kiosks\`
          (club_id,code,name,board_number,sponsor_label,sponsor_logo_url,scoring_mode,pairing_token_hash,paired_device_name,paired_at,is_active)
         VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,1)`,
        [canonicalClubId, code, name, boardNumber, sponsorLabel, sponsorLogoUrl, scoringMode],
      );
      const physicalId = decimalId(insert.insertId, "kiosk_id");
      const row = await this.findPhysicalBoardWith(db, canonicalClubId, physicalId);
      if (!row) throw new DomainValidationError("board_create_failed", "Skiva kunne ikke leses etter opprettelse.", 500);
      return this.publicBoardWith(db, environmentClubId, canonicalClubId, row);
    });
  }

  async updateBoard(
    environmentClubIdInput: unknown,
    physicalIdInput: unknown,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const environmentClubId = requiredId(environmentClubIdInput, "club_id");
    const physicalId = requiredId(physicalIdInput, "kiosk_id");
    return this.sessions.withTransaction(async (db) => {
      const canonicalClubId = await this.canonicalClubIdWith(db, environmentClubId);
      const existing = await this.findPhysicalBoardWith(db, canonicalClubId, physicalId);
      if (!existing) return null;
      const code = stringValue(payload.code) || stringValue(existing.code);
      const name = stringValue(payload.name) || stringValue(existing.name);
      const boardNumber = payload.board_number === undefined
        ? Math.max(1, numberValue(existing.board_number))
        : Math.max(1, integerValue(payload.board_number, 1));
      const sponsorLabel = payload.sponsor_label === undefined ? nullableString(existing.sponsor_label) : nullableString(payload.sponsor_label);
      const sponsorLogoUrl = payload.sponsor_logo_url === undefined ? nullableString(existing.sponsor_logo_url) : nullableString(payload.sponsor_logo_url);
      const scoringMode = normalizeScoringMode(payload.scoring_mode ?? existing.scoring_mode);
      const isActive = payload.is_active === undefined ? numberValue(existing.is_active) : boolInt(payload.is_active);
      await db.execute(
        `UPDATE \`${this.hardwarePrefix}kiosks\`
            SET code=?,name=?,board_number=?,sponsor_label=?,sponsor_logo_url=?,scoring_mode=?,is_active=?
          WHERE id=? AND club_id=?`,
        [code, name, boardNumber, sponsorLabel, sponsorLogoUrl, scoringMode, isActive, physicalId, canonicalClubId],
      );

      if (this.runtimePrefix !== this.hardwarePrefix) {
        const runtime = await this.runtimeBoardWith(db, environmentClubId, physicalId);
        if (runtime) {
          await db.execute(
            `UPDATE \`${this.runtimePrefix}kiosks\`
                SET name=?,board_number=?,sponsor_label=?,sponsor_logo_url=?,scoring_mode='manual',is_active=?
              WHERE id=?`,
            [name, boardNumber, sponsorLabel, sponsorLogoUrl, isActive, requiredId(runtime.id, "runtime_kiosk_id")],
          );
        }
      }
      const fresh = await this.findPhysicalBoardWith(db, canonicalClubId, physicalId);
      return fresh ? this.publicBoardWith(db, environmentClubId, canonicalClubId, fresh) : null;
    });
  }

  async resetPairing(environmentClubIdInput: unknown, physicalIdInput: unknown): Promise<Record<string, unknown> | null> {
    const environmentClubId = requiredId(environmentClubIdInput, "club_id");
    const physicalId = requiredId(physicalIdInput, "kiosk_id");
    return this.sessions.withTransaction(async (db) => {
      const canonicalClubId = await this.canonicalClubIdWith(db, environmentClubId);
      const existing = await this.findPhysicalBoardWith(db, canonicalClubId, physicalId);
      if (!existing) return null;
      const runtime = await this.runtimeBoardWith(db, environmentClubId, physicalId);
      if (runtime) {
        await db.execute(
          `UPDATE \`${this.runtimePrefix}kiosks\`
              SET pairing_token_hash=NULL,paired_device_name=NULL,paired_at=NULL,last_seen_at=NULL
            WHERE id=?`,
          [requiredId(runtime.id, "runtime_kiosk_id")],
        );
      }
      const fresh = await this.findPhysicalBoardWith(db, canonicalClubId, physicalId);
      return fresh ? this.publicBoardWith(db, environmentClubId, canonicalClubId, fresh) : null;
    });
  }

  async ensureRuntimeAlias(environmentClubIdInput: unknown, physicalIdInput: unknown): Promise<string> {
    const environmentClubId = requiredId(environmentClubIdInput, "club_id");
    const physicalId = requiredId(physicalIdInput, "kiosk_id");
    return this.sessions.withTransaction((db) => this.ensureRuntimeAliasWith(db, environmentClubId, physicalId));
  }

  async listPendingPairingRequests(clubIdInput: unknown): Promise<Record<string, unknown>[]> {
    const clubId = requiredId(clubIdInput, "club_id");
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT id,club_id,request_code,device_name,status,requested_at,expires_at
           FROM \`${this.runtimePrefix}kiosk_pairing_requests\`
          WHERE (club_id=? OR club_id IS NULL) AND status='pending' AND expires_at>=NOW()
          ORDER BY requested_at DESC`,
        [clubId],
      );
      return rows.map(publicPairingRequest);
    });
  }

  async createPairingRequest(
    pairingTokenInput: unknown,
    deviceNameInput: unknown,
    clubIdInput: unknown = null,
  ): Promise<Record<string, unknown>> {
    const pairingToken = stringValue(pairingTokenInput);
    if (pairingToken.length < 16) {
      throw new DomainValidationError("pairing_token_required", "Terminalen mangler gyldig device-token.");
    }
    const deviceName = (stringValue(deviceNameInput) || "Board Terminal").slice(0, 150);
    const clubId = optionalId(clubIdInput);
    const fingerprint = createHash("sha256").update(pairingToken).digest("hex");
    const tokenHash = await bcrypt.hash(pairingToken, 10);

    return this.sessions.withTransaction(async (db) => {
      if (clubId !== null) await this.environmentClubWith(db, clubId);
      const existingRows = await db.query<QueryResultRow>(
        `SELECT id,club_id,request_code,device_name,status,requested_at,expires_at
           FROM \`${this.runtimePrefix}kiosk_pairing_requests\`
          WHERE pairing_token_fingerprint=? AND status='pending' AND expires_at>NOW() LIMIT 1 FOR UPDATE`,
        [fingerprint],
      );
      if (existingRows[0]) return publicPairingRequest(existingRows[0]);

      await db.execute(
        `UPDATE \`${this.runtimePrefix}kiosk_pairing_requests\`
            SET status='cancelled'
          WHERE pairing_token_fingerprint=? AND status='pending'`,
        [fingerprint],
      );
      let requestCode = "";
      for (let attempts = 0; attempts < 8; attempts += 1) {
        const candidate = generatePairingCode();
        const collision = await db.query<QueryResultRow>(
          `SELECT id FROM \`${this.runtimePrefix}kiosk_pairing_requests\` WHERE request_code=? LIMIT 1`,
          [candidate],
        );
        if (collision.length === 0) {
          requestCode = candidate;
          break;
        }
      }
      if (!requestCode) throw new DomainValidationError("pairing_code_generation_failed", "Kunne ikke lage pairingkode.", 500);
      await db.execute(
        `INSERT INTO \`${this.runtimePrefix}kiosk_pairing_requests\`
          (club_id,request_code,pairing_token_hash,pairing_token_fingerprint,device_name,status,expires_at)
         VALUES (?,?,?,?,?,'pending',DATE_ADD(NOW(),INTERVAL 30 MINUTE))`,
        [clubId, requestCode, tokenHash, fingerprint, deviceName],
      );
      const rows = await db.query<QueryResultRow>(
        `SELECT id,club_id,request_code,device_name,status,requested_at,expires_at
           FROM \`${this.runtimePrefix}kiosk_pairing_requests\` WHERE request_code=? LIMIT 1`,
        [requestCode],
      );
      return publicPairingRequest(rows[0] ?? { request_code: requestCode, device_name: deviceName, status: "pending" });
    });
  }

  async getPairingRequestStatus(requestCodeInput: unknown, pairingTokenInput: unknown): Promise<Record<string, unknown> | null> {
    const requestCode = normalizePairingCode(requestCodeInput);
    const pairingToken = stringValue(pairingTokenInput);
    if (!requestCode || !pairingToken) throw new DomainValidationError("pairing_token_required", "X-Kiosk-Pairing-Token header is required.");
    const fingerprint = createHash("sha256").update(pairingToken).digest("hex");
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT * FROM \`${this.runtimePrefix}kiosk_pairing_requests\` WHERE request_code=? LIMIT 1`,
        [requestCode],
      );
      const request = rows[0];
      if (!request) return null;
      if (stringValue(request.pairing_token_fingerprint) !== fingerprint) {
        throw new DomainValidationError("kiosk_pairing_request_invalid", "Denne pairingforespørselen tilhører et annet nettbrett.", 403);
      }
      if (stringValue(request.status) === "approved" && request.approved_kiosk_id != null) {
        const kioskRows = await db.query<QueryResultRow>(
          `SELECT k.*,c.name AS club_name,c.logo_url AS club_logo_url
             FROM \`${this.runtimePrefix}kiosks\` k
             LEFT JOIN \`${this.runtimePrefix}clubs\` c ON c.id=k.club_id
            WHERE k.id=? LIMIT 1`,
          [requiredId(request.approved_kiosk_id, "approved_kiosk_id")],
        );
        const kiosk = kioskRows[0];
        if (kiosk) {
          return { status: "approved", request: publicPairingRequest(request), kiosk: publicRuntimeKiosk(kiosk) };
        }
      }
      return { status: stringValue(request.status) || "pending", request: publicPairingRequest(request) };
    });
  }

  async approvePairingRequest(
    environmentClubIdInput: unknown,
    requestCodeInput: unknown,
    physicalIdInput: unknown,
    approvedByUserIdInput: unknown,
  ): Promise<Record<string, unknown> | null> {
    const environmentClubId = requiredId(environmentClubIdInput, "club_id");
    const requestCode = normalizePairingCode(requestCodeInput);
    const physicalId = requiredId(physicalIdInput, "kiosk_id");
    const approvedByUserId = requiredId(approvedByUserIdInput, "user_id");
    return this.sessions.withTransaction(async (db) => {
      const requestRows = await db.query<QueryResultRow>(
        `SELECT * FROM \`${this.runtimePrefix}kiosk_pairing_requests\` WHERE request_code=? LIMIT 1 FOR UPDATE`,
        [requestCode],
      );
      const request = requestRows[0];
      if (!request) return null;
      if (stringValue(request.status) !== "pending") return { request: publicPairingRequest(request) };
      if (request.club_id != null && requiredId(request.club_id, "request_club_id") !== environmentClubId) return null;
      const canonicalClubId = await this.canonicalClubIdWith(db, environmentClubId);
      const physical = await this.findPhysicalBoardWith(db, canonicalClubId, physicalId);
      if (!physical || numberValue(physical.is_active) !== 1) {
        throw new DomainValidationError("board_inactive", "Deaktiverte skiver kan ikke pares med en terminal. Aktiver skiva først.", 409);
      }
      const runtimeId = await this.ensureRuntimeAliasWith(db, environmentClubId, physicalId);
      const runtimeRows = await db.query<QueryResultRow>(
        `SELECT pairing_token_hash FROM \`${this.runtimePrefix}kiosks\` WHERE id=? AND club_id=? LIMIT 1 FOR UPDATE`,
        [runtimeId, environmentClubId],
      );
      if (!runtimeRows[0]) return null;
      if (stringValue(runtimeRows[0].pairing_token_hash)) {
        throw new DomainValidationError("board_already_paired", "Dette boardet er allerede paret. Nullstill pairing først.", 409);
      }
      await db.execute(
        `UPDATE \`${this.runtimePrefix}kiosks\`
            SET pairing_token_hash=?,paired_device_name=?,paired_at=NOW(),last_seen_at=NOW()
          WHERE id=?`,
        [stringValue(request.pairing_token_hash), stringValue(request.device_name), runtimeId],
      );
      await db.execute(
        `UPDATE \`${this.runtimePrefix}kiosk_pairing_requests\`
            SET club_id=?,status='approved',approved_kiosk_id=?,approved_by_user_account_id=?,approved_at=NOW(),consumed_at=NOW()
          WHERE id=?`,
        [environmentClubId, runtimeId, approvedByUserId, requiredId(request.id, "pairing_request_id")],
      );
      const freshRows = await db.query<QueryResultRow>(
        `SELECT * FROM \`${this.runtimePrefix}kiosk_pairing_requests\` WHERE request_code=? LIMIT 1`,
        [requestCode],
      );
      return {
        request: publicPairingRequest(freshRows[0] ?? request),
        physical_kiosk_id: physicalId,
        runtime_kiosk_id: runtimeId,
        ...this.scope(),
      };
    });
  }

  private async ensureRuntimeAliasWith(db: SqlExecutor, environmentClubId: string, physicalId: string): Promise<string> {
    const canonicalClubId = await this.canonicalClubIdWith(db, environmentClubId);
    const board = await this.findPhysicalBoardWith(db, canonicalClubId, physicalId);
    if (!board) throw new DomainValidationError("board_not_found", "Skiva ble ikke funnet i canonical PROD-utstyrsregister.", 404);
    if (this.runtimePrefix === this.hardwarePrefix) return physicalId;
    const existing = await this.runtimeBoardWith(db, environmentClubId, physicalId);
    if (existing) return requiredId(existing.id, "runtime_kiosk_id");

    const boardNumber = Math.max(1, numberValue(board.board_number));
    const conflicts = await db.query<QueryResultRow>(
      `SELECT id,source_kiosk_id FROM \`${this.runtimePrefix}kiosks\`
        WHERE club_id=? AND board_number=? LIMIT 1 FOR UPDATE`,
      [environmentClubId, boardNumber],
    );
    const aliasCode = `TEST-${createHash("sha256").update(stringValue(board.code)).digest("hex").slice(0, 20).toUpperCase()}`;
    const name = stringValue(board.name);
    const sponsorLabel = nullableString(board.sponsor_label);
    const sponsorLogoUrl = nullableString(board.sponsor_logo_url);
    if (conflicts[0]) {
      const runtimeId = requiredId(conflicts[0].id, "runtime_kiosk_id");
      await db.execute(
        `UPDATE \`${this.runtimePrefix}kiosks\`
            SET source_kiosk_id=?,code=?,name=?,board_number=?,sponsor_label=?,sponsor_logo_url=?,scoring_mode='manual',is_active=1
          WHERE id=?`,
        [physicalId, aliasCode, name, boardNumber, sponsorLabel, sponsorLogoUrl, runtimeId],
      );
      return runtimeId;
    }
    const insert = await db.execute(
      `INSERT INTO \`${this.runtimePrefix}kiosks\`
        (source_kiosk_id,club_id,code,name,board_number,sponsor_label,sponsor_logo_url,scoring_mode,is_active)
       VALUES (?,?,?,?,?,?,?,'manual',1)`,
      [physicalId, environmentClubId, aliasCode, name, boardNumber, sponsorLabel, sponsorLogoUrl],
    );
    return decimalId(insert.insertId, "runtime_kiosk_id");
  }

  private async publicBoardWith(
    db: SqlExecutor,
    environmentClubId: string,
    canonicalClubId: string,
    row: QueryResultRow,
  ): Promise<Record<string, unknown>> {
    const physicalId = requiredId(row.id, "physical_kiosk_id");
    const runtime = await this.runtimeBoardWith(db, environmentClubId, physicalId);
    const pairingHash = this.runtimePrefix === this.hardwarePrefix
      ? stringValue(row.pairing_token_hash)
      : stringValue(runtime?.pairing_token_hash);
    return {
      id: physicalId,
      code: stringValue(row.code),
      name: stringValue(row.name),
      board_number: numberValue(row.board_number),
      sponsor_label: nullableString(row.sponsor_label),
      sponsor_logo_url: nullableString(row.sponsor_logo_url),
      scoring_mode: normalizeScoringMode(row.scoring_mode),
      is_active: numberValue(row.is_active),
      paired_device_name: this.runtimePrefix === this.hardwarePrefix ? nullableString(row.paired_device_name) : nullableString(runtime?.paired_device_name),
      paired_at: this.runtimePrefix === this.hardwarePrefix ? row.paired_at ?? null : runtime?.paired_at ?? null,
      last_seen_at: this.runtimePrefix === this.hardwarePrefix ? row.last_seen_at ?? null : runtime?.last_seen_at ?? null,
      physical_kiosk_id: physicalId,
      runtime_kiosk_id: runtime ? requiredId(runtime.id, "runtime_kiosk_id") : null,
      environment_club_id: environmentClubId,
      canonical_club_id: canonicalClubId,
      is_paired: pairingHash ? 1 : 0,
      ...this.scope(),
    };
  }

  private async findPhysicalBoardWith(db: SqlExecutor, canonicalClubId: string, physicalId: string): Promise<QueryResultRow | null> {
    const rows = await db.query<QueryResultRow>(
      `SELECT id,club_id,code,name,board_number,sponsor_label,sponsor_logo_url,scoring_mode,is_active,
              pairing_token_hash,paired_device_name,paired_at,last_seen_at
         FROM \`${this.hardwarePrefix}kiosks\` WHERE id=? AND club_id=? LIMIT 1`,
      [physicalId, canonicalClubId],
    );
    return rows[0] ?? null;
  }

  private async runtimeBoardWith(db: SqlExecutor, environmentClubId: string, physicalId: string): Promise<QueryResultRow | null> {
    const rows = this.runtimePrefix === this.hardwarePrefix
      ? await db.query<QueryResultRow>(
          `SELECT id,pairing_token_hash,paired_device_name,paired_at,last_seen_at FROM \`${this.runtimePrefix}kiosks\` WHERE id=? LIMIT 1`,
          [physicalId],
        )
      : await db.query<QueryResultRow>(
          `SELECT id,pairing_token_hash,paired_device_name,paired_at,last_seen_at FROM \`${this.runtimePrefix}kiosks\`
            WHERE club_id=? AND source_kiosk_id=? AND is_active=1 LIMIT 1`,
          [environmentClubId, physicalId],
        );
    return rows[0] ?? null;
  }

  private async canonicalClubIdWith(db: SqlExecutor, environmentClubId: string): Promise<string> {
    if (this.runtimePrefix === this.hardwarePrefix) return environmentClubId;
    const club = await this.environmentClubWith(db, environmentClubId);
    const slug = stringValue(club.slug);
    if (!slug) throw new DomainValidationError("club_not_found", "Klubben finnes ikke i dette miljøet.", 404);
    const rows = await db.query<QueryResultRow>(
      `SELECT id FROM \`${this.hardwarePrefix}clubs\` WHERE slug=? LIMIT 1`,
      [slug],
    );
    if (!rows[0]) throw new DomainValidationError("canonical_hardware_club_missing", "Klubben mangler canonical PROD-utstyrsregister.", 409);
    return requiredId(rows[0].id, "canonical_club_id");
  }

  private async environmentClubWith(db: SqlExecutor, environmentClubId: string): Promise<QueryResultRow> {
    const rows = await db.query<QueryResultRow>(
      `SELECT id,name,slug FROM \`${this.runtimePrefix}clubs\` WHERE id=? LIMIT 1`,
      [environmentClubId],
    );
    if (!rows[0]) throw new DomainValidationError("club_not_found", "Klubben finnes ikke i dette miljøet.", 404);
    return rows[0];
  }

  private async generateKioskCodeWith(db: SqlExecutor, clubKey: string, boardNumber: number): Promise<string> {
    let base = clubKey.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toUpperCase() || "CLUB";
    base = base.slice(0, 48);
    let counter = 1;
    while (counter < 1000) {
      const candidate = counter === 1 ? `${base}-B${String(boardNumber).padStart(2, "0")}` : `${base}-B${String(boardNumber).padStart(2, "0")}-${counter}`;
      const rows = await db.query<QueryResultRow>(
        `SELECT 1 AS present FROM \`${this.hardwarePrefix}kiosks\` WHERE code=? LIMIT 1`,
        [candidate],
      );
      if (rows.length === 0) return candidate;
      counter += 1;
    }
    throw new DomainValidationError("kiosk_code_generation_failed", "Kunne ikke lage unik skivekode.", 500);
  }
}

function publicPairingRequest(row: QueryResultRow): Record<string, unknown> {
  return {
    id: optionalId(row.id),
    club_id: optionalId(row.club_id),
    request_code: stringValue(row.request_code) || null,
    device_name: nullableString(row.device_name),
    status: stringValue(row.status) || "pending",
    requested_at: row.requested_at ?? null,
    expires_at: row.expires_at ?? null,
  };
}

function publicRuntimeKiosk(row: QueryResultRow): Record<string, unknown> {
  return {
    id: requiredId(row.id, "kiosk_id"),
    code: stringValue(row.code),
    name: stringValue(row.name),
    club: {
      id: optionalId(row.club_id),
      name: nullableString(row.club_name),
      logo_url: nullableString(row.club_logo_url),
    },
    board_number: numberValue(row.board_number),
    sponsor_label: nullableString(row.sponsor_label),
    sponsor_logo_url: nullableString(row.sponsor_logo_url),
    scoring_mode: normalizeScoringMode(row.scoring_mode),
    is_paired: stringValue(row.pairing_token_hash) !== "",
    paired_device_name: nullableString(row.paired_device_name),
    paired_at: row.paired_at ?? null,
  };
}

function generatePairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(6);
  let code = "";
  for (let index = 0; index < 6; index += 1) code += alphabet[bytes[index]! % alphabet.length];
  return code;
}

function normalizePairingCode(value: unknown): string {
  return stringValue(value).replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function normalizeScoringMode(value: unknown): "manual" | "scolia" {
  return stringValue(value).toLowerCase() === "scolia" ? "scolia" : "manual";
}

function boolInt(value: unknown): 0 | 1 {
  if (typeof value === "boolean") return value ? 1 : 0;
  return ["1", "true", "yes", "on"].includes(stringValue(value).toLowerCase()) ? 1 : 0;
}

function integerValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringValue(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function nullableString(value: unknown): string | null {
  const normalized = stringValue(value);
  return normalized === "" ? null : normalized;
}

function requiredId(value: unknown, name: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new DomainValidationError("invalid_id", `${name} must be a positive decimal id.`);
  return normalized;
}

function optionalId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}

function decimalId(value: unknown, name: string): string {
  return requiredId(value, name);
}
