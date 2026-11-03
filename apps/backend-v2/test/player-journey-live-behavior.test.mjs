import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

function extract(file, start, end) {
  const source = fs.readFileSync(file, "utf8");
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing function boundary ${file}: ${start}`);
  return source.slice(from, to);
}

function liveHarness({ phase, liveResult, checkinResult }) {
  const actions = [];
  const state = { phase, loading: false, payload: { tournament: { status: "in_progress" } } };
  const api = async (url) => {
    if (url.includes("/check-in-display")) {
      if (checkinResult instanceof Error) throw checkinResult;
      return checkinResult;
    }
    if (liveResult instanceof Error) throw liveResult;
    return liveResult;
  };
  const code = extract("apps/live/app.js", "async function load() {", "async function realtimeConfig()");
  const scope = {
    state, api, clubSlug: "blindleia",
    renderCheckin(data) { actions.push("renderCheckin"); return Boolean(data?.checkin?.code); },
    render(data) { actions.push("renderLive"); state.payload = data; },
    renderStandby() { actions.push("renderStandby"); },
    livePayloadIsRelevant(data) { return Boolean(data?.tournament); },
    setPhase(next) { actions.push(`setPhase:${next}`); state.phase = next; },
    encodeURIComponent,
  };
  const load = vm.runInNewContext(`${code}\nload;`, scope);
  return { load, state, actions };
}

test("failed Live API read does not flash an active wall to standby", async () => {
  const h = liveHarness({
    phase: "live",
    liveResult: new Error("Temporary 502"),
    checkinResult: { active: false },
  });
  await h.load();
  assert.equal(h.state.phase, "live");
  assert.deepEqual(h.actions, []);
  assert.equal(h.state.loading, false);
});

test("failed check-in display read does not show Live over active check-in", async () => {
  const h = liveHarness({
    phase: "checkin",
    liveResult: { tournament: { status: "ready" } },
    checkinResult: new Error("Temporary gateway timeout"),
  });
  await h.load();
  assert.equal(h.state.phase, "checkin");
  assert.deepEqual(h.actions, []);
  assert.equal(h.state.loading, false);
});

test("successful authoritative phase transition from check-in to Live still works", async () => {
  const h = liveHarness({
    phase: "checkin",
    liveResult: { tournament: { status: "in_progress" } },
    checkinResult: { active: false },
  });
  await h.load();
  assert.equal(h.state.phase, "live");
  assert.deepEqual(h.actions, ["renderLive", "setPhase:live"]);
});

test("two visible check-in buttons for one tournament share one status request", async () => {
  const source = extract("apps/player/checkin-runtime.js", "async function getCheckinStatus(", "function ensureGateStyles()");
  const requests = [];
  const status = { registration_status: "registered", window_state: "open" };
  const scope = {
    checkinStatusCache: new Map(), checkinStatusInFlight: new Map(),
    CHECKIN_STATUS_CACHE_MS: 5000,
    api: async (path) => {
      requests.push(path);
      await Promise.resolve();
      return status;
    },
  };
  const getCheckinStatus = vm.runInNewContext(`${source}\ngetCheckinStatus;`, scope);
  const [one,two] = await Promise.all([getCheckinStatus(77), getCheckinStatus(77)]);
  assert.equal(one.registration_status, "registered");
  assert.equal(two.window_state, "open");
  assert.deepEqual(requests, ["/tournaments/77/check-in-status"]);
  await getCheckinStatus(77);
  assert.equal(requests.length, 1, "subsequent reads use cached status until stale");
});

function playerRefreshHarness(status) {
  const events = [];
  const state = { token: "existing-token", me: { id: 7 }, dashboard: { registrations: [{ status: "registered" }] } };
  const error = Object.assign(new Error("Temporary backend failure"), { status });
  const scope = {
    state,
    sharedApp: { session: {
      snapshot: () => ({ resolved: false }),
      resolve: async () => ({ id: 7 }),
      clear: () => events.push("clear-session"),
    } },
    api: async () => { throw error; },
    persistToken: (token) => { state.token = token; events.push("persist-token"); },
    renderAuth: () => events.push("render-auth"),
    renderDashboard: () => events.push("render-dashboard"),
    renderTournaments: () => events.push("render-tournaments"),
    emitPlayerData: (reason) => events.push(reason),
    setStatus: (message) => events.push(message),
  };
  const source = extract("apps/player/app.js", "async function loadCurrentUser() {", "function applyBranding()");
  return { state, events, refresh: vm.runInNewContext(`${source}\nloadCurrentUser;`, scope) };
}

test("temporary 502 during player refresh does not log out registered player", async () => {
  const h = playerRefreshHarness(502);
  await h.refresh();
  assert.equal(h.state.token, "existing-token");
  assert.equal(h.state.me.id, 7);
  assert.equal(h.state.dashboard.registrations[0].status, "registered");
  assert.ok(h.events.includes("user_refresh_error"));
  assert.ok(!h.events.includes("clear-session"));
  assert.ok(h.events.some((x) => String(x).includes("Innloggingen er beholdt")));
});

test("explicit 401 still clears invalid player credentials", async () => {
  const h = playerRefreshHarness(401);
  await h.refresh();
  assert.equal(h.state.token, "");
  assert.equal(h.state.me, null);
  assert.ok(h.events.includes("clear-session"));
  assert.ok(h.events.includes("session_error"));
});
