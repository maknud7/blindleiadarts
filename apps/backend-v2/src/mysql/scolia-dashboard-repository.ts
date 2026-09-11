import type { MySqlSessionProvider, QueryResultRow, TablePrefix } from "./contracts.js";
import { MySqlScreenDeviceRepository } from "./screen-device-repository.js";

export class MySqlScoliaDashboardRepository {
  private readonly screens: MySqlScreenDeviceRepository;

  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly runtimePrefix: TablePrefix,
  ) {
    this.screens = new MySqlScreenDeviceRepository(sessions, runtimePrefix);
  }

  async listOpenIncidents(clubIdInput: unknown): Promise<Record<string, unknown>[]> {
    const clubId = requiredId(clubIdInput, "club_id");
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT i.*,k.name AS kiosk_name,k.board_number
           FROM \`${this.runtimePrefix}scolia_incidents\` i
           LEFT JOIN \`${this.runtimePrefix}kiosks\` k ON k.id=i.kiosk_id
          WHERE i.club_id=? AND i.status='open'
          ORDER BY FIELD(i.severity,'critical','error','warning','info'),i.last_seen_at DESC
          LIMIT 100`,
        [clubId],
      );
      return rows.map((row) => ({ ...row }));
    });
  }

  async listFailedEvents(clubIdInput: unknown): Promise<Record<string, unknown>[]> {
    const clubId = requiredId(clubIdInput, "club_id");
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT e.id,e.kiosk_id,k.board_number,e.match_id,e.event_type,e.processing_status,e.attempt_count,e.received_at,e.last_error
           FROM \`${this.runtimePrefix}scolia_events\` e
           INNER JOIN \`${this.runtimePrefix}kiosks\` k ON k.id=e.kiosk_id
          WHERE e.club_id=? AND e.processing_status IN ('failed','dead_letter')
          ORDER BY e.id DESC LIMIT 100`,
        [clubId],
      );
      return rows.map((row) => ({ ...row }));
    });
  }

  async queueCounts(clubIdInput: unknown): Promise<Record<string, number>> {
    const clubId = requiredId(clubIdInput, "club_id");
    return this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT processing_status,COUNT(*) AS c
           FROM \`${this.runtimePrefix}scolia_events\`
          WHERE club_id=? GROUP BY processing_status`,
        [clubId],
      );
      const counts: Record<string, number> = {
        queued: 0,
        processing: 0,
        processed: 0,
        ignored: 0,
        failed: 0,
        dead_letter: 0,
      };
      for (const row of rows) {
        const status = String(row.processing_status ?? "").trim();
        if (status !== "") counts[status] = numberValue(row.c);
      }
      return counts;
    });
  }

  async listScreenDevices(clubIdInput: unknown): Promise<Record<string, unknown>[]> {
    return this.screens.listByClubId(clubIdInput);
  }

  async createScreenDevice(clubIdInput: unknown, labelInput: unknown): Promise<Record<string, unknown>> {
    return this.screens.createForClub(clubIdInput, labelInput);
  }

  async deleteScreenDevice(clubIdInput: unknown, screenIdInput: unknown): Promise<boolean> {
    return this.screens.deleteForClub(clubIdInput, screenIdInput);
  }
}

function requiredId(value: unknown, name: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new TypeError(`${name} must be a positive decimal id.`);
  return normalized;
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
