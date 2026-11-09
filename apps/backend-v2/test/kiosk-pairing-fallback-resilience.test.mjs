import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { MySqlEquipmentAdminRepository } from "../dist/mysql/equipment-admin-repository.js";

function fixture(initial = [], { concurrentPending = null } = {}) {
  const rows = initial.map((row) => ({ ...row }));
  const statements = [];
  let pendingReads = 0;
  const db = {
    async query(sql, params = []) {
      if (sql.includes("WHERE pairing_token_fingerprint=? AND status='pending'")) {
        pendingReads += 1;
        if (concurrentPending && pendingReads > 1) return [{ ...concurrentPending }];
        const row = rows.find((item) => item.status === "pending");
        return row ? [{ ...row }] : [];
      }
      if (sql.includes("WHERE request_code=?")) {
        const row = rows.find((item) => item.request_code === params[0]);
        if (sql.includes("SELECT id FROM")) return row ? [{ id: row.id }] : [];
        return row ? [{ ...row }] : [];
      }
      throw Error("Unexpected SQL: " + sql);
    },
    async execute(sql, params = []) {
      statements.push(sql);
      if (sql.includes("SET status='cancelled'")) throw Error("Expired pending rows must not become cancelled");
      if (sql.includes("SET club_id=?,request_code=?")) {
        const existing = rows.find((row) => row.id === params[4]);
        assert.ok(existing, "must update the existing pending row");
        existing.club_id = params[0];
        existing.request_code = params[1];
        existing.device_name = params[3];
        existing.status = "pending";
        existing.is_fresh = 1;
        return { affectedRows: 1 };
      }
      if (sql.includes("INSERT INTO") && sql.includes("kiosk_pairing_requests")) {
        if (concurrentPending) {
          throw Object.assign(
            new Error("Duplicate entry (redacted) for key 'uniq_kiosk_pairing_request_fingerprint_status'"),
            { code: "ER_DUP_ENTRY" },
          );
        }
        rows.push({
          id: String(200 + rows.length), club_id: null,
          request_code: params[1], device_name: params[4],
          status: "pending", is_fresh: 1, expires_at: "2026-11-09",
        });
        return { affectedRows: 1 };
      }
      throw Error("Unexpected mutation: " + sql);
    },
  };
  const repo = new MySqlEquipmentAdminRepository(
    { async withTransaction(callback) { return callback(db); } },
    "bd_test_", "bd_prod_",
  );
  return { repo, rows, statements };
}

test("expired pending pairing is renewed in place even when an old cancelled row exists", async () => {
  const { repo, rows, statements } = fixture([
    { id: "41", request_code: "OLD111", status: "cancelled", is_fresh: 0 },
    { id: "42", request_code: "OLD222", status: "pending", is_fresh: 0, expires_at: "2020-01-01" },
  ]);
  const result = await repo.createPairingRequest("test-device-token-12345", "Club tablet");
  assert.equal(result.id, "42");
  assert.equal(result.device_name, "Club tablet");
  assert.notEqual(result.request_code, "OLD222");
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.id === "42").status, "pending");
  assert.equal(statements.filter((sql) => sql.includes("UPDATE")).length, 1);
  assert.equal(statements.filter((sql) => sql.includes("INSERT")).length, 0);
});

test("fresh pending pairing reuses the existing request without mutation", async () => {
  const { repo, statements } = fixture([
    { id: "11", request_code: "KEEP12", status: "pending", is_fresh: 1 },
  ]);
  const result = await repo.createPairingRequest("test-device-token-12345", "Club tablet");
  assert.equal(result.request_code, "KEEP12");
  assert.deepEqual(statements, []);
});

test("first pairing can be inserted while an old cancelled record exists", async () => {
  const { repo, rows, statements } = fixture([
    { id: "17", request_code: "OLD111", status: "cancelled", is_fresh: 0 },
  ]);
  const result = await repo.createPairingRequest("test-device-token-12345", "Club tablet");
  assert.equal(result.status, "pending");
  assert.equal(rows.length, 2);
  assert.equal(statements.filter((sql) => sql.includes("INSERT")).length, 1);
});

test("concurrent duplicate fingerprint is reconciled by reading the winner, never retrying INSERT", async () => {
  const winning = {
    id: "9007199254740993", request_code: "WINNER", status: "pending",
    device_name: "Club tablet", is_fresh: 1,
  };
  const { repo, statements } = fixture([], { concurrentPending: winning });
  const result = await repo.createPairingRequest("test-device-token-12345", "Club tablet");
  assert.equal(result.id, winning.id);
  assert.equal(result.request_code, winning.request_code);
  assert.equal(statements.filter((sql) => sql.includes("INSERT")).length, 1);
});

test("manual v1 kiosk never issues Scolia status requests; Scolia kiosk polls at a controlled rate", async () => {
  const source = fs.readFileSync("apps/kiosk/scolia-live-ux.js", "utf8");
  const timers = [];
  let mode = "manual";
  let fetches = 0;
  const classList = { add() {}, remove() {} };
  const style = { removeProperty() {}, setProperty() {} };
  function node() {
    return {
      parentNode: { insertBefore() {} },
      style, classList, setAttribute() {},
      querySelector() { return null; },
      innerHTML: "",
    };
  }
  const original = node();
  const manual = node();
  const context = {
    window: {
      setTimeout(callback, ms) { timers.push({ callback, ms }); return timers.length; },
      clearTimeout() {},
      addEventListener() {},
    },
    document: {
      getElementById(id) { return id === "scoliaScoring" ? original : id === "manualScoring" ? manual : null; },
      querySelector() { return node(); },
      createElement: node,
      body: { dataset: { appEnv: "prod" }, classList },
    },
    localStorage: { getItem(key) { return key === "bd:kioskCode" ? "BOARD" : key === "bd:kioskPairingToken" ? "TOKEN" : null; } },
    currentKiosk() { return { scoring_mode: mode }; },
    fetch: async () => {
      fetches += 1;
      return { ok: true, async json() { return { ok: true, data: { board: { mode: "off" } } }; } };
    },
    AbortController,
    console,
    Date,
    Math,
  };
  vm.runInNewContext(source, context, { filename: "scolia-live-ux.js" });
  assert.equal(timers[0].ms, 100);
  await timers.shift().callback();
  assert.equal(fetches, 0, "manual kiosk must have zero Scolia API calls");
  assert.equal(timers[0].ms, 3000, "normal poll interval must be at least 3s");

  mode = "scolia";
  await timers.shift().callback();
  assert.equal(fetches, 1);
  assert.equal(timers[0].ms, 3000);
});

test("v1 and v2 never blindly repeat fallback mutations after an unknown server outcome", () => {
  const v1 = fs.readFileSync("apps/kiosk/scolia-live-ux.js", "utf8");
  const v2 = fs.readFileSync("apps/platform-v2/src/kiosk/useScoliaRuntime.ts", "utf8");
  const compat = fs.readFileSync("apps/kiosk/realtime-refresh-compat.js", "utf8");
  assert.match(v1, /autoFallbackAttempted = true/);
  assert.match(v1, /autoFallbackAttempted \|\| autoFallbackBusy/);
  assert.match(v1, /const fresh = await request\("status"\)/);
  assert.doesNotMatch(v1, /setInterval\(\(\) => poll\(\).*750/);
  assert.match(v2, /fallbackAttempted\.current = true/);
  assert.match(v2, /!runtimeBusy\.current && !fallbackAttempted\.current/);
  assert.match(v2, /const fresh = await readStatus\(\)/);
  assert.doesNotMatch(compat, /return nativeFetch\(input, init\);\s*\}\s*\}\)\(\);/);
  assert.doesNotMatch(compat, /if \(!isPairingCreate\) throw error/);
});
