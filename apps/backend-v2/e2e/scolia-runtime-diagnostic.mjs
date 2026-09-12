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
  assert.equal(drain.claimed, 1, `Expected one claimed event: ${JSON.stringify(diagnostic)}`);
  assert.equal(drain.processed, 1, `HELLO_CLIENT processing failed: ${JSON.stringify(diagnostic)}`);
  assert.equal(drain.failed, 0, `HELLO_CLIENT processing failed: ${JSON.stringify(diagnostic)}`);
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

function requireInsertId(result, label) {
  const value = String(result.insertId ?? "").trim();
  assert.match(value, /^[1-9][0-9]*$/, `${label} insert id missing`);
  return value;
}
