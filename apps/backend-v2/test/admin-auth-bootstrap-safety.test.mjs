import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const core = fs.readFileSync("packages/ui-assets/app-core.js", "utf8");
const start = core.indexOf("async function resolve({ force = false } = {}) {");
const end = core.indexOf("\nfunction prime(", start);
assert.ok(start >= 0 && end > start, "shared auth resolve is located");

function makeHarness({ status = 200, previousUser = null, failsNetwork = false } = {}) {
  let currentToken = "verified-candidate";
  const state = { clears: 0, emits: 0 };
  const scope = {
    resolvedToken: previousUser ? currentToken : null,
    resolvedUser: previousUser || undefined,
    inFlight: null,
    token: () => currentToken,
    clear() { state.clears += 1; currentToken = ""; },
    emit() { state.emits += 1; },
    fetch: async () => {
      if (failsNetwork) throw new Error("Network error");
      return { ok: status === 200, status, json: async () => ({ ok: status === 200, data: { user: { id: "7", role: "club_admin" } } }) };
    },
    window: { setTimeout: () => 1, clearTimeout: () => {} },
    AbortController, URL, API_ROOT: new URL("https://example.test/api/v1/"),
  };
  vm.createContext(scope);
  const resolve = vm.runInContext(core.slice(start, end) + "\nresolve", scope);
  return { resolve, scope, state, getToken: () => currentToken };
}

test("HTTP 502 during first admin identity check raises retryable error, not a false logout", async () => {
  const h = makeHarness({ status: 502 });
  await assert.rejects(h.resolve(), /Kunne ikke bekrefte innloggingen/);
  assert.equal(h.getToken(), "verified-candidate");
  assert.equal(h.state.clears, 0);
});

test("network outage during first admin identity check retains token and fails visibly", async () => {
  const h = makeHarness({ failsNetwork: true });
  await assert.rejects(h.resolve(), /Network error/);
  assert.equal(h.state.clears, 0);
});

test("transient auth failure does not remove an already verified admin menu identity", async () => {
  const prior = { id: "7", role: "club_admin" };
  const h = makeHarness({ status: 502, previousUser: prior });
  const user = await h.resolve({ force: true });
  assert.equal(user, prior);
  assert.equal(h.state.clears, 0);
});

test("explicit HTTP 401 still clears invalid admin login", async () => {
  const h = makeHarness({ status: 401 });
  assert.equal(await h.resolve(), null);
  assert.equal(h.getToken(), "");
  assert.equal(h.state.clears, 1);
});

test("403 explicitly denies access rather than granting stale cached admin role", async () => {
  const prior = { id: "7", role: "club_admin" };
  const h = makeHarness({ status: 403, previousUser: prior });
  assert.equal(await h.resolve({ force: true }), null);
});

test("admin bootstrap is bounded and does not discard credentials on transient failures", () => {
  const admin = fs.readFileSync("apps/admin/app.js", "utf8");
  const shell = fs.readFileSync("index.html", "utf8");
  assert.match(core, /window\.setTimeout\(\(\) => controller\.abort\(\), 10000\)/);
  assert.match(core, /response\.status === 401/);
  assert.match(core, /if \(resolvedToken === currentToken && resolvedUser\) return resolvedUser/);
  assert.match(admin, /const unauthorized = Number\(error\?\.status \|\| 0\) === 401/);
  assert.match(admin, /if \(unauthorized\) \{\s*persistToken\(""/);
  assert.match(shell, /boot\(\)\.catch\(\(error\) =>/);
  assert.match(shell, /root\.querySelector\("\.retry"\)/);
});
