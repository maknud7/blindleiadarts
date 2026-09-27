import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { loadRuntimeConfig } from "../dist/runtime/config.js";
import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";
import { MySqlScoliaBridgeRepository } from "../dist/mysql/scolia-bridge-repository.js";
import { ScoliaEventProcessor } from "../dist/service/scolia-event-processor.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test");
assert.equal(config.mode, "test-write");
assert.equal(config.prefixes.runtime, "bd_test_");
assert.equal(config.prefixes.hardware, "bd_test_");

const suffix = randomBytes(6).toString("hex");
const serial = `DIAG-${suffix.toUpperCase()}`;
const code = `scolia-diag-${suffix}`;
const boardNumber = 900000 + Number.parseInt(suffix.slice(0, 5), 16);
const fixture = { club: null, kiosk: null, event: null };
const provider = new MySql2SessionProvider({
  host: config.mysql.host,
  port: config.mysql.port,
  database: config.mysql.database,
  username: config.mysql.username,
  password: config.mysql.password,
  connectTimeoutMs: config.mysql.connectTimeoutMs,
  budget: config.mysql.budget,
  writable: true,
  connectionReuse: "idle-reuse",
  idleConnectionTimeoutMs: config.mysql.idleConnectionTimeoutMs,
});
const bridge = new MySqlScoliaBridgeRepository(provider, config.prefixes.runtime, config.prefixes.hardware);
const processor = new ScoliaEventProcessor(bridge, {});

await dumpPhysicalBoardSnapshot(provider);
await provider.close();
process.exit(0);

try {
  await provider.withConnection(async (sql) => {
    const club = await sql.execute(
      `INSERT INTO \`${config.prefixes.runtime}clubs\` (name,slug) VALUES (?,?)`,
      [`Scolia diag ${suffix}`, `scolia-diag-${suffix}`],
    );
    fixture.club = requireInsertId(club, "club");
    const kiosk = await sql.execute(
      `INSERT INTO \`${config.prefixes.runtime}kiosks\`
        (club_id,code,name,board_number,scoring_mode,is_active)
       VALUES (?,?,?,?,'scolia',1)`,
      [fixture.club, code, `Scolia diag board ${suffix}`, boardNumber],
    );
    fixture.kiosk = requireInsertId(kiosk, "kiosk");
    await sql.execute(
      `INSERT INTO \`${config.prefixes.runtime}scolia_club_settings\`
        (club_id,enabled,access_token,force_connect,forward_messages_to_scolia,disconnect_fallback_enabled,queue_max_attempts,queue_retry_base_seconds,event_retention_days)
       VALUES (?,1,?,1,0,1,3,1,1)`,
      [fixture.club, `diag-token-${suffix}`],
    );
    await sql.execute(
      `INSERT INTO \`${config.prefixes.runtime}scolia_board_settings\`
        (kiosk_id,serial_number,mode,auto_fallback_to_manual)
       VALUES (?,?,'live',1)`,
      [fixture.kiosk, serial],
    );
  });

  const queued = await bridge.enqueueEvent(serial, {
    id: `diag-hello-${suffix}`,
    type: "HELLO_CLIENT",
    payload: { boardStatus: "Ready", boardPhase: "Throw" },
  });
  fixture.event = String(queued.id);
  const drain = await processor.drain(10, 5000);
  const diagnostic = await provider.withConnection(async (sql) => {
    const rows = await sql.query(
      `SELECT id,kiosk_id,event_type,processing_status,attempt_count,last_error,processing_meta_json
         FROM \`${config.prefixes.runtime}scolia_events\` WHERE id=? LIMIT 1`,
      [fixture.event],
    );
    return rows[0] ?? null;
  });
  console.log(JSON.stringify({ scenario: "scolia-runtime-diagnostic", queued, drain, diagnostic }));
  assert.ok(drain.claimed >= 1, `Expected diagnostic event to be claimable: ${JSON.stringify({ drain, diagnostic })}`);
  assert.equal(diagnostic?.processing_status, "processed", `Diagnostic HELLO_CLIENT was not processed: ${JSON.stringify({ drain, diagnostic })}`);
  assert.equal(diagnostic?.last_error ?? null, null, `Diagnostic HELLO_CLIENT recorded an error: ${JSON.stringify({ drain, diagnostic })}`);
} finally {
  try {
    await provider.withConnection(async (sql) => {
      if (fixture.kiosk) {
        await sql.execute(`DELETE FROM \`${config.prefixes.runtime}scolia_events\` WHERE kiosk_id=?`, [fixture.kiosk]);
        await sql.execute(`DELETE FROM \`${config.prefixes.runtime}scolia_incidents\` WHERE kiosk_id=?`, [fixture.kiosk]);
        await sql.execute(`DELETE FROM \`${config.prefixes.runtime}scolia_board_runtime\` WHERE kiosk_id=?`, [fixture.kiosk]);
        await sql.execute(`DELETE FROM \`${config.prefixes.runtime}scolia_board_settings\` WHERE kiosk_id=?`, [fixture.kiosk]);
      }
      if (fixture.club) await sql.execute(`DELETE FROM \`${config.prefixes.runtime}scolia_club_settings\` WHERE club_id=?`, [fixture.club]);
      if (fixture.kiosk) await sql.execute(`DELETE FROM \`${config.prefixes.runtime}kiosks\` WHERE id=?`, [fixture.kiosk]);
      if (fixture.club) await sql.execute(`DELETE FROM \`${config.prefixes.runtime}clubs\` WHERE id=?`, [fixture.club]);
    });
  } finally {
    await provider.close();
  }
}

async function dumpPhysicalBoardSnapshot(provider) {
  const physicalBoardId = "4";
  const snapshot = await provider.withConnection(async (sql) => {
    const dbNow = await sql.query("SELECT NOW(3) AS db_now");
    const physicalBoard = await sql.query(
      `SELECT k.id,k.club_id,k.code,k.name,k.board_number,k.scoring_mode,k.is_active,
              CASE WHEN s.serial_number IS NULL OR s.serial_number='' THEN 0 ELSE 1 END AS serial_configured,
              s.mode,s.auto_fallback_to_manual,
              cs.enabled AS club_scolia_enabled,cs.force_connect,cs.forward_messages_to_scolia,
              CASE WHEN cs.access_token IS NULL OR cs.access_token='' THEN 0 ELSE 1 END AS access_token_configured
         FROM \`bd_prod_kiosks\` k
         LEFT JOIN \`bd_prod_scolia_board_settings\` s ON s.kiosk_id=k.id
         LEFT JOIN \`bd_prod_scolia_club_settings\` cs ON cs.club_id=k.club_id
        WHERE k.id=? LIMIT 1`,
      [physicalBoardId],
    );
    const aliases = await sql.query(
      `SELECT k.id,k.club_id,k.code,k.name,k.board_number,k.scoring_mode,k.is_active,k.source_kiosk_id,c.slug
         FROM \`bd_test_kiosks\` k
         LEFT JOIN \`bd_test_clubs\` c ON c.id=k.club_id
        WHERE k.source_kiosk_id=? ORDER BY k.id`,
      [physicalBoardId],
    );
    const leases = await sql.query(
      `SELECT physical_kiosk_id,test_kiosk_id,leased_at,heartbeat_at,expires_at,
              TIMESTAMPDIFF(SECOND,NOW(3),expires_at) AS expires_in_seconds
         FROM \`bd_prod_scolia_test_leases\`
        WHERE physical_kiosk_id=?
        ORDER BY expires_at DESC LIMIT 10`,
      [physicalBoardId],
    );
    const testKioskIds = Array.from(new Set([
      ...aliases.map((row) => String(row.id ?? "")).filter((value) => /^[1-9][0-9]*$/.test(value)),
      ...leases.map((row) => String(row.test_kiosk_id ?? "")).filter((value) => /^[1-9][0-9]*$/.test(value)),
    ]));
    if (testKioskIds.length === 0) {
      return {
        db_now: dbNow[0]?.db_now ?? null,
        physical_board: physicalBoard[0] ?? null,
        aliases,
        leases,
        test_kiosk_ids: [],
        runtime: [],
        events: [],
        commands: [],
        matches: [],
        visits: [],
      };
    }

    const placeholders = testKioskIds.map(() => "?").join(",");
    const eventHistorySummary = await sql.query(
      `SELECT event_type,COUNT(*) AS event_count,MIN(received_at) AS first_received_at,MAX(received_at) AS last_received_at
         FROM \`bd_test_scolia_events\`
        WHERE kiosk_id IN (${placeholders})
        GROUP BY event_type
        ORDER BY last_received_at DESC`,
      testKioskIds,
    );
    const historicalScoringEvents = await sql.query(
      `SELECT id,kiosk_id,match_id,event_type,processing_status,attempt_count,received_at,processed_at,
              canonical_visit_id,last_error,processing_meta_json,payload_json
         FROM \`bd_test_scolia_events\`
        WHERE kiosk_id IN (${placeholders})
          AND event_type IN ('THROW_DETECTED','TAKEOUT_STARTED','TAKEOUT_FINISHED')
        ORDER BY id DESC LIMIT 30`,
      testKioskIds,
    );
    const runtime = await sql.query(
      `SELECT kiosk_id,connection_state,board_status,board_phase,error_type,fallback_active,
              needs_reconciliation,turn_locked_until_takeout,last_disconnect_reason,
              last_bridge_heartbeat_at,connected_at,last_event_at,last_disconnect_at,last_reconciled_at
         FROM \`bd_test_scolia_board_runtime\`
        WHERE kiosk_id IN (${placeholders}) ORDER BY kiosk_id`,
      testKioskIds,
    );
    const events = await sql.query(
      `SELECT id,kiosk_id,match_id,provider_event_id,event_type,priority,processing_status,
              attempt_count,received_at,processing_started_at,processed_at,next_attempt_at,
              canonical_visit_id,last_error,processing_meta_json,payload_json
         FROM \`bd_test_scolia_events\`
        WHERE kiosk_id IN (${placeholders})
        ORDER BY id DESC LIMIT 80`,
      testKioskIds,
    );
    const commands = await sql.query(
      `SELECT id,kiosk_id,command_type,message_id,status,priority,attempt_count,
              created_at,delivered_at,completed_at,next_attempt_at,last_error
         FROM \`bd_test_scolia_commands\`
        WHERE kiosk_id IN (${placeholders})
        ORDER BY id DESC LIMIT 40`,
      testKioskIds,
    );
    const matches = await sql.query(
      `SELECT *
         FROM \`bd_test_matches\`
        WHERE kiosk_id IN (${placeholders})
        ORDER BY id DESC LIMIT 20`,
      testKioskIds,
    );
    const matchIds = matches
      .map((row) => String(row.id ?? ""))
      .filter((value) => /^[1-9][0-9]*$/.test(value));
    let visits = [];
    if (matchIds.length > 0) {
      const matchPlaceholders = matchIds.map(() => "?").join(",");
      visits = await sql.query(
        `SELECT *
           FROM \`bd_test_visits\`
          WHERE match_id IN (${matchPlaceholders})
          ORDER BY id DESC LIMIT 40`,
        matchIds,
      );
    }
    return {
      db_now: dbNow[0]?.db_now ?? null,
      physical_board: physicalBoard[0] ?? null,
      aliases,
      leases,
      test_kiosk_ids: testKioskIds,
      event_history_summary: eventHistorySummary,
      historical_scoring_events: historicalScoringEvents,
      runtime,
      events,
      commands,
      matches,
      visits,
    };
  });
  console.log(JSON.stringify({ scenario: "physical-scolia-board4-readonly-snapshot", ...snapshot }, null, 2));
}

function requireInsertId(result, label) {
  const value = String(result.insertId ?? "").trim();
  assert.match(value, /^[1-9][0-9]*$/, `${label} insert id missing`);
  return value;
}
