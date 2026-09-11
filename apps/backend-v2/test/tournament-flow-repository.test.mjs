import assert from "node:assert/strict";
import test from "node:test";

import { MySqlTournamentFlowRepository } from "../dist/mysql/tournament-flow-repository.js";

class FakeExecutor {
  constructor(plan) {
    this.plan = plan;
    this.executed = [];
  }
  async query(sql, params = []) {
    this.executed.push({ kind: "query", sql, params });
    if (sql.includes("FROM `bd_test_tournaments`")) return [this.plan.tournament];
    if (sql.includes("FROM `bd_test_matches`")) return [{ cnt: this.plan.matchCount ?? 0 }];
    if (sql.includes("FROM `bd_test_tournament_players`")) {
      const statuses = params.slice(1);
      if (statuses.includes("checked_in")) return [{ cnt: this.plan.checkedIn ?? 0 }];
      if (statuses.includes("registered") || statuses.includes("paused")) return [{ cnt: this.plan.registered ?? 0 }];
      if (statuses.includes("waitlisted")) return [{ cnt: this.plan.waitlisted ?? 0 }];
      if (statuses.includes("no_show")) return [{ cnt: this.plan.noShow ?? 0 }];
    }
    return [];
  }
  async execute(sql, params = []) {
    this.executed.push({ kind: "execute", sql, params });
    return { affectedRows: 1 };
  }
}

class FakeSessions {
  constructor(plan) {
    this.db = new FakeExecutor(plan);
    this.transactions = 0;
  }
  async withConnection(work) {
    return work(this.db);
  }
  async withTransaction(work) {
    this.transactions += 1;
    return work(this.db);
  }
}

function tournament(status = "ready") {
  return {
    id: "17",
    club_id: "1",
    name: "Mandagsserien #6",
    status,
    start_at: "2026-09-14 18:30:00",
    registration_opens_at: null,
    registration_closes_at: null,
  };
}

test("requires at least two checked-in players before tournament start", async () => {
  const sessions = new FakeSessions({ tournament: tournament(), checkedIn: 1, matchCount: 0 });
  const repo = new MySqlTournamentFlowRepository(sessions, "bd_test_");
  await assert.rejects(() => repo.startTournament("17"), (error) => {
    assert.equal(error.code, "not_enough_checked_in_players");
    assert.equal(error.statusCode, 422);
    return true;
  });
  assert.equal(sessions.transactions, 0);
});

test("starts tournament atomically with no-show cleanup and immutable ELO boundary", async () => {
  const sessions = new FakeSessions({
    tournament: tournament(),
    checkedIn: 8,
    registered: 2,
    waitlisted: 1,
    matchCount: 0,
  });
  const repo = new MySqlTournamentFlowRepository(sessions, "bd_test_");
  const result = await repo.startTournament("17");

  assert.equal(sessions.transactions, 1);
  assert.deepEqual(result, {
    tournament_id: "17",
    status: "in_progress",
    checked_in_count: 8,
    no_show_count: 2,
    withdrawn_waitlist_count: 1,
    already_started: false,
  });
  const writes = sessions.db.executed.filter((entry) => entry.kind === "execute").map((entry) => entry.sql);
  assert.ok(writes.some((sql) => sql.includes("status='no_show'")));
  assert.ok(writes.some((sql) => sql.includes("status='withdrawn'")));
  assert.ok(writes.some((sql) => sql.includes("status='in_progress'")));
  assert.ok(writes.some((sql) => sql.includes("INSERT IGNORE INTO `bd_test_tournament_elo_snapshots`")));
});

test("already-started tournament is idempotent and only backfills missing ELO snapshot", async () => {
  const sessions = new FakeSessions({ tournament: tournament("in_progress"), checkedIn: 6, noShow: 3, matchCount: 12 });
  const repo = new MySqlTournamentFlowRepository(sessions, "bd_test_");
  const result = await repo.startTournament("17");
  assert.equal(result.already_started, true);
  assert.equal(result.no_show_count, 3);
  assert.equal(sessions.transactions, 0);
  assert.ok(sessions.db.executed.some((entry) => entry.kind === "execute" && entry.sql.includes("tournament_elo_snapshots")));
});
