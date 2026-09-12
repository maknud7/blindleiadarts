import assert from "node:assert/strict";
import test from "node:test";

import { MySqlTournamentAttendanceRepository } from "../dist/mysql/tournament-attendance-repository.js";

function provider(script) {
  return {
    withConnection: async (fn) => fn(script),
    withTransaction: async (fn) => fn(script),
  };
}

test("check-in enforces code and records PHP-compatible source", async () => {
  const calls = [];
  let registration = {
    id: "10",
    tournament_id: "20",
    player_id: "30",
    status: "registered",
    checked_in_at: null,
    checkin_source: null,
  };
  const db = {
    query: async (sql) => {
      calls.push(sql);
      if (sql.includes("FROM `bd_test_tournaments` t")) {
        return [{
          id: "20", club_id: "1", status: "draft", start_at: "2026-09-13 18:00:00",
          checkin_opens_at: "2026-09-12 17:00:00", checkin_method: "code", checkin_code: "ABC",
          effective_checkin_opens_at: "2026-09-12 17:00:00", effective_method: "code", window_open: 1,
        }];
      }
      if (sql.includes("FROM `bd_test_tournament_players`")) return [registration];
      return [];
    },
    execute: async (sql) => {
      calls.push(sql);
      registration = { ...registration, status: "checked_in", checked_in_at: "2026-09-12 18:00:00.000", checkin_source: "player_code" };
      return { affectedRows: 1 };
    },
  };
  const repo = new MySqlTournamentAttendanceRepository(provider(db), "bd_test_");
  await assert.rejects(() => repo.checkInPlayer("20", "30", null), (error) => error.code === "checkin_code_required");
  await assert.rejects(() => repo.checkInPlayer("20", "30", "ZZZ"), (error) => error.code === "checkin_code_invalid");
  const result = await repo.checkInPlayer("20", "30", "a-b-c");
  assert.equal(result.status, "checked_in");
  assert.equal(result.checkin_source, "player_code");
  assert.equal(result.already_checked_in, false);
  assert.ok(calls.some((sql) => sql.includes("checked_in_at=NOW(3)")));
});

test("finish-checkin moves no-shows and waitlist before ready", async () => {
  const executed = [];
  const db = {
    query: async (sql) => {
      if (sql.includes("FROM `bd_test_tournaments` t")) {
        return [{ id: "20", club_id: "1", status: "draft", start_at: "2026-09-13 18:00:00", window_open: 1 }];
      }
      if (sql.includes("COUNT(*)")) return [{ cnt: 2 }];
      return [];
    },
    execute: async (sql) => {
      executed.push(sql);
      if (sql.includes("status='no_show'")) return { affectedRows: 3 };
      if (sql.includes("status='withdrawn'")) return { affectedRows: 1 };
      return { affectedRows: 1 };
    },
  };
  const repo = new MySqlTournamentAttendanceRepository(provider(db), "bd_test_");
  const result = await repo.finishCheckin("20");
  assert.equal(result.status, "ready");
  assert.equal(result.checked_in_count, 2);
  assert.equal(result.no_show_count, 3);
  assert.equal(result.withdrawn_waitlist_count, 1);
  assert.ok(executed.some((sql) => sql.includes("checkin_closes_at=NOW()")));
  assert.ok(executed.some((sql) => sql.includes("registration_closes_at=NOW()")));
});
