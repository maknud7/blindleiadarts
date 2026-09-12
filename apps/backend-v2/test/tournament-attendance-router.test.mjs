import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";

import { TournamentAttendanceRouter } from "../dist/runtime/tournament-attendance-router.js";

function request(body = {}, token = "token") {
  const stream = Readable.from([JSON.stringify(body)]);
  stream.headers = { authorization: `Bearer ${token}` };
  return stream;
}

const config = {
  environment: "test",
  mode: "test-write",
  prefixes: { runtime: "bd_test_", identity: "bd_test_", hardware: "bd_prod_" },
};

test("start finalizes draft attendance before starting", async () => {
  const calls = [];
  const identity = {
    findBySessionToken: async () => ({ id: "1", player_id: "2", role: "super_admin", admin_club_ids: "" }),
  };
  const attendance = {
    findTournament: async () => ({ id: 20, club_id: 1, status: "draft" }),
    finishCheckin: async () => { calls.push("finish"); return { status: "ready" }; },
  };
  const flow = {
    startTournament: async () => { calls.push("start"); return { tournament_id: "20", status: "in_progress" }; },
  };
  const router = new TournamentAttendanceRouter(config, identity, attendance, flow);
  const result = await router.handle("POST", "/v1/tournaments/20/start", request({}));
  assert.deepEqual(calls, ["finish", "start"]);
  assert.equal(result.payload.start.status, "in_progress");
});

test("check-in forwards code and authenticated player", async () => {
  const identity = {
    findBySessionToken: async () => ({ id: "1", player_id: "9223372036854775807", role: "player", admin_club_ids: "" }),
  };
  let seen = null;
  const attendance = {
    checkInPlayer: async (...args) => { seen = args; return { status: "checked_in" }; },
  };
  const router = new TournamentAttendanceRouter(config, identity, attendance, {});
  const result = await router.handle("POST", "/v1/tournaments/20/check-in", request({ code: "ABC" }));
  assert.deepEqual(seen, ["20", "9223372036854775807", "ABC"]);
  assert.equal(result.payload.registration.status, "checked_in");
});
