import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { loadRuntimeConfig } from "../dist/runtime/config.js";
import { MySql2SessionProvider } from "../dist/mysql/mysql2-session-provider.js";

const config = loadRuntimeConfig(process.env);
assert.equal(config.environment, "test", "Attendance admin E2E may only run with BD_APP_ENV=test");
assert.equal(config.mode, "test-write", "Attendance admin E2E requires guarded test-write mode");
assert.equal(config.prefixes.runtime, "bd_test_", "Attendance admin E2E may only mutate bd_test_ runtime tables");
assert.equal(config.prefixes.identity, "bd_test_", "Attendance admin E2E may only mutate bd_test_ identity tables");
assert.equal(config.mysql.budget.maxConcurrentConnections, 1, "Attendance admin E2E must use one MySQL connection");

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

const prefix = config.prefixes.runtime;
const suffix = randomBytes(6).toString("hex");
const bearer = `attendance-admin-e2e-${randomBytes(24).toString("hex")}`;
const bearerHash = createHash("sha256").update(bearer).digest("hex");
const fixture = { club: null, tournament: null, players: [], guestPlayer: null, user: null, session: null };
const baseUrl = `http://127.0.0.1:${config.port}`;
let server = null;
let serverOutput = "";

try {
  await createFixture();
  server = startServer();
  await waitForReady();

  const defaultClub = await getJson(`/v1/clubs/${fixture.club}/checkin-settings`);
  assert.equal(defaultClub.settings.default_method, "admin_or_code");
  assert.equal(Number(defaultClub.settings.opens_minutes_before_start), 60);

  const clubUpdated = await patchJson(`/v1/clubs/${fixture.club}/checkin-settings`, {
    default_method: "admin_only",
    opens_minutes_before_start: 90,
    closes_minutes_after_start: 15,
  });
  assert.equal(clubUpdated.settings.default_method, "admin_only");
  assert.equal(Number(clubUpdated.settings.opens_minutes_before_start), 90);
  assert.equal(Number(clubUpdated.settings.closes_minutes_after_start), 15);

  const inherited = await getJson(`/v1/tournaments/${fixture.tournament}/checkin-settings`);
  assert.equal(inherited.settings.effective_method, "admin_only");

  const tournamentUpdated = await patchJson(`/v1/tournaments/${fixture.tournament}/checkin-settings`, {
    checkin_method: "code",
    checkin_opens_at: "2000-01-01 00:00:00",
    checkin_code: "x-y-z",
  });
  assert.equal(tournamentUpdated.settings.checkin_method, "code");
  assert.equal(tournamentUpdated.settings.checkin_code, "XYZ");
  assert.equal(tournamentUpdated.settings.effective_method, "code");

  const rotated = await postJson(`/v1/tournaments/${fixture.tournament}/checkin-code/rotate`, {});
  assert.match(String(rotated.settings.checkin_code), /^[A-HJ-NP-Z]{3}$/);
  assert.notEqual(rotated.settings.checkin_code, "XYZ");

  const beforeStatus = await getJson(`/v1/tournaments/${fixture.tournament}/check-in-status`);
  assert.equal(beforeStatus.registration_status, "registered");
  assert.equal(beforeStatus.window_state, "open");
  assert.equal(beforeStatus.method, "code");
  assert.equal(beforeStatus.code_allowed, true);
  assert.equal(beforeStatus.admin_checkin_allowed, true);

  const adminChecked = await postJson(
    `/v1/tournaments/${fixture.tournament}/admin-check-in/${fixture.players[0]}`,
    {},
  );
  assert.equal(adminChecked.registration.status, "checked_in");
  assert.equal(adminChecked.registration.checkin_source, "admin_override");
  assert.ok(adminChecked.registration.checked_in_at);

  const afterStatus = await getJson(`/v1/tournaments/${fixture.tournament}/check-in-status`);
  assert.equal(afterStatus.registration_status, "checked_in");
  assert.equal(afterStatus.checkin_source, "admin_override");

  const checkedOut = await deleteJson(
    `/v1/tournaments/${fixture.tournament}/admin-check-in/${fixture.players[0]}`,
  );
  assert.equal(checkedOut.registration.status, "registered");
  assert.equal(checkedOut.registration.checked_in_at, null);
  assert.equal(checkedOut.registration.checkin_source, null);

  const guest = await requestJson(`/v1/tournaments/${fixture.tournament}/registrations/guest`, {
    method: "POST",
    body: { first_name: "Guest", last_name: `Player${suffix}` },
    expectedStatus: 201,
  });
  fixture.guestPlayer = String(guest.registration.player_id);
  assert.match(fixture.guestPlayer, /^[1-9][0-9]*$/);
  assert.equal(guest.registration.status, "checked_in");
  assert.equal(guest.registration.registration_source, "guest_admin");

  const duplicateGuest = await requestJson(`/v1/tournaments/${fixture.tournament}/registrations/guest`, {
    method: "POST",
    body: { first_name: "Guest", last_name: `Player${suffix}` },
    expectedStatus: 409,
  });
  assert.equal(duplicateGuest.error.code, "guest_already_added");

  const guestRow = await provider.withConnection(async (db) => {
    const rows = await db.query(
      `SELECT p.club_id,tp.checkin_source
         FROM \`${prefix}players\` p
         INNER JOIN \`${prefix}tournament_players\` tp ON tp.player_id=p.id
        WHERE p.id=? AND tp.tournament_id=? LIMIT 1`,
      [fixture.guestPlayer, fixture.tournament],
    );
    return rows[0];
  });
  assert.equal(guestRow.club_id, null);
  assert.equal(guestRow.checkin_source, "admin_guest");

  console.log(JSON.stringify({
    ok: true,
    scenario: "backend-v2-tournament-attendance-admin-lifecycle",
    release_sha: config.releaseSha,
    runtime_prefix: prefix,
    settings_updated: true,
    code_rotated: true,
    admin_checkin_roundtrip: true,
    guest_added: true,
  }));
} catch (error) {
  if (serverOutput) process.stderr.write(`\n--- backend-v2 server output ---\n${serverOutput}\n`);
  throw error;
} finally {
  if (server) {
    server.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  await cleanupFixture();
  await provider.close();
}

async function createFixture() {
  await provider.withConnection(async (sql) => {
    const club = await sql.execute(
      `INSERT INTO \`${prefix}clubs\` (name,slug) VALUES (?,?)`,
      [`Attendance Admin E2E ${suffix}`, `attendance-admin-e2e-${suffix}`],
    );
    fixture.club = requireInsertId(club, "club");

    for (let index = 0; index < 2; index += 1) {
      const inserted = await sql.execute(
        `INSERT INTO \`${prefix}players\` (club_id,display_name,first_name,last_name) VALUES (?,?,?,?)`,
        [fixture.club, `Attendance Admin Player ${index + 1} ${suffix}`, `Admin${index + 1}`, `Player${suffix}`],
      );
      fixture.players.push(requireInsertId(inserted, `player ${index + 1}`));
    }

    const identityMemberId = fixture.players[0];
    await sql.execute(`UPDATE \`${prefix}players\` SET member_id=? WHERE id=?`, [identityMemberId, fixture.players[0]]);

    const tournament = await sql.execute(
      `INSERT INTO \`${prefix}tournaments\`
        (club_id,name,slug,provider_system,status,start_at,registration_opens_at,registration_closes_at,max_players)
       VALUES (?,?,?,'local','draft',DATE_ADD(NOW(),INTERVAL 1 DAY),DATE_SUB(NOW(),INTERVAL 1 DAY),DATE_ADD(NOW(),INTERVAL 2 DAY),16)`,
      [fixture.club, `Attendance Admin ${suffix}`, `attendance-admin-${suffix}`],
    );
    fixture.tournament = requireInsertId(tournament, "tournament");

    for (const playerId of fixture.players) {
      await sql.execute(
        `INSERT INTO \`${prefix}tournament_players\` (tournament_id,player_id,status,registration_source)
         VALUES (?,?,'registered','admin')`,
        [fixture.tournament, playerId],
      );
    }

    const username = `attendance-admin-e2e-${suffix}`;
    const user = await sql.execute(
      `INSERT INTO \`${prefix}user_accounts\`
        (username,email,password_hash,display_name,player_id,member_id,role,is_active,account_status)
       VALUES (?,?,NULL,?,?,?,'player',1,'active')`,
      [username, `${username}@example.invalid`, `Attendance Admin ${suffix}`, fixture.players[0], identityMemberId],
    );
    fixture.user = requireInsertId(user, "user");
    await sql.execute(`INSERT INTO \`${prefix}global_user_roles\` (user_account_id,role) VALUES (?,'super_admin')`, [fixture.user]);
    const session = await sql.execute(
      `INSERT INTO \`${prefix}auth_sessions\` (user_account_id,session_token_hash,expires_at,last_used_at)
       VALUES (?,?,DATE_ADD(NOW(),INTERVAL 1 DAY),NOW())`,
      [fixture.user, bearerHash],
    );
    fixture.session = requireInsertId(session, "session");
  });
}

async function cleanupFixture() {
  if (!fixture.club) return;
  try {
    await provider.withConnection(async (sql) => {
      if (fixture.tournament) {
        await sql.execute(`DELETE FROM \`${prefix}tournament_players\` WHERE tournament_id=?`, [fixture.tournament]);
        await sql.execute(`DELETE FROM \`${prefix}tournaments\` WHERE id=?`, [fixture.tournament]);
      }
      if (fixture.session) await sql.execute(`DELETE FROM \`${prefix}auth_sessions\` WHERE id=?`, [fixture.session]);
      if (fixture.user) {
        await sql.execute(`DELETE FROM \`${prefix}global_user_roles\` WHERE user_account_id=?`, [fixture.user]);
        await sql.execute(`DELETE FROM \`${prefix}club_user_roles\` WHERE user_account_id=?`, [fixture.user]);
        await sql.execute(`DELETE FROM \`${prefix}user_accounts\` WHERE id=?`, [fixture.user]);
      }
      if (fixture.guestPlayer) await sql.execute(`DELETE FROM \`${prefix}players\` WHERE id=?`, [fixture.guestPlayer]);
      for (const playerId of fixture.players) await sql.execute(`DELETE FROM \`${prefix}players\` WHERE id=?`, [playerId]);
      await sql.execute(`DELETE FROM \`${prefix}club_checkin_settings\` WHERE club_id=?`, [fixture.club]);
      await sql.execute(`DELETE FROM \`${prefix}clubs\` WHERE id=?`, [fixture.club]);
    });
  } catch (cleanupError) {
    console.error("backend-v2 attendance admin E2E cleanup failed", cleanupError);
  }
}

function startServer() {
  const child = spawn(process.execPath, ["apps/backend-v2/dist/server.js"], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(config.port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  child.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
  return child;
}

async function waitForReady() {
  let lastError = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (server?.exitCode !== null) throw new Error(`backend-v2 exited before readiness. ${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        const health = await response.json();
        if (health.ok === true && health.environment === "test" && health.writes_armed === true) return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`backend-v2 did not become ready: ${String(lastError ?? "unknown")}`);
}

async function getJson(path) {
  return requestJson(path, { method: "GET" });
}

async function postJson(path, body) {
  return requestJson(path, { method: "POST", body });
}

async function patchJson(path, body) {
  return requestJson(path, { method: "PATCH", body });
}

async function deleteJson(path) {
  return requestJson(path, { method: "DELETE" });
}

async function requestJson(path, { method, body = undefined, expectedStatus = 200 }) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} returned non-JSON ${response.status}: ${text}`);
  }
  assert.equal(response.status, expectedStatus, `${method} ${path}: ${text}`);
  return payload;
}

function requireInsertId(result, label) {
  const value = String(result.insertId ?? "").trim();
  assert.match(value, /^[1-9][0-9]*$/, `${label} insert id missing`);
  return value;
}
