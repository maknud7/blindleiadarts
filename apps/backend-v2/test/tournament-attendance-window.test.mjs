import assert from "node:assert/strict";
import test from "node:test";

import { MySqlTournamentAttendanceRepository } from "../dist/mysql/tournament-attendance-repository.js";

function provider(db) {
  return { withConnection: async (fn) => fn(db), withTransaction: async (fn) => fn(db) };
}

test("check-in rejects before effective opening time", async () => {
  const db = {
    query: async (sql) => {
      if (sql.includes("FROM `bd_test_tournaments` t")) {
        return [{
          id: "20", club_id: "1", status: "draft", start_at: "2026-09-13 18:00:00",
          checkin_opens_at: "2026-09-13 17:00:00", checkin_method: "code", checkin_code: "ABC",
          effective_method: "code", window_open: 0,
        }];
      }
      return [{ id: "10", tournament_id: "20", player_id: "30", status: "registered", checked_in_at: null, checkin_source: null }];
    },
    execute: async () => ({ affectedRows: 1 }),
  };
  const repo = new MySqlTournamentAttendanceRepository(provider(db), "bd_test_");
  await assert.rejects(
    () => repo.checkInPlayer("20", "30", "ABC"),
    (error) => error.code === "checkin_not_open" && error.statusCode === 409,
  );
});
