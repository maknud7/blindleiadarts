import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";

import { TournamentAttendanceRouter } from "../dist/runtime/tournament-attendance-router.js";

const config = {
  environment: "test",
  mode: "test-write",
  prefixes: { runtime: "bd_test_", identity: "bd_test_", hardware: "bd_prod_" },
};

function req() {
  const stream = Readable.from(["{}"]);
  stream.headers = { authorization: "Bearer token" };
  return stream;
}

test("start rejects states that have not completed attendance", async () => {
  const identity = { findBySessionToken: async () => ({ id: "1", player_id: "2", role: "super_admin" }) };
  const attendance = { findTournament: async () => ({ id: 20, club_id: 1, status: "cancelled" }) };
  const router = new TournamentAttendanceRouter(config, identity, attendance, {});
  await assert.rejects(
    () => router.handle("POST", "/v1/tournaments/20/start", req()),
    (error) => error.code === "checkin_must_be_finished" && error.statusCode === 409,
  );
});
