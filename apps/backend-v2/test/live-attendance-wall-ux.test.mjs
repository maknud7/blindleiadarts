import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { MySqlPublicLiveReadRepository } from "../dist/mysql/public-live-read-repository.js";
import { MySqlTournamentAttendanceRepository } from "../dist/mysql/tournament-attendance-repository.js";

const read = (path) => fs.readFileSync(path, "utf8");
function extract(path, start, end) {
  const source = read(path);
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Could not extract ${start} from ${path}`);
  return source.slice(from, to);
}

function publicDisplayFixture({ method = "admin_only", code = null } = {}) {
  const sqls = [];
  const participants = [
    { player_id: "101", display_name: "Ada", status: "checked_in", checked_in_at: "2026-11-04 18:15:00" },
    { player_id: "102", display_name: "Ben", status: "checked_in", checked_in_at: "2026-11-04 18:16:00" },
    { player_id: "103", display_name: "Cam", status: "registered", checked_in_at: null },
    { player_id: "104", display_name: "Dan", status: "waitlisted", checked_in_at: null },
  ];
  const session = {
    withConnection: async (fn) => fn({
      query: async (sql, params) => {
        sqls.push({ sql, params });
        if (sql.includes("FROM `bd_test_clubs` WHERE slug=?")) return [{ id: "7" }];
        if (sql.includes("FROM `bd_test_tournaments` t")) return [{
          id: "99", name: "Mandagsserien", start_at: "2026-11-09 18:30:00",
          checkin_code: code, effective_method: method,
          effective_checkin_opens_at: "2026-11-09 17:30:00",
        }];
        if (sql.includes("FROM `bd_test_tournament_players` tp")) return participants;
        throw new Error(`Unexpected SQL: ${sql}`);
      },
      execute: async () => { throw new Error("Public Live display must never mutate TEST or PROD"); },
    }),
  };
  return { repo: new MySqlPublicLiveReadRepository(session, "bd_test_", "bd_prod_"), sqls };
}

test("Live displays admin-only check-in without code while preserving canonical statuses", async () => {
  const h = publicDisplayFixture();
  const display = await h.repo.publicCheckinDisplay({ clubSlug: "blindleia-dartklubb" });
  assert.equal(display.active, true);
  assert.equal(display.checkin.method, "admin_only");
  assert.equal(display.checkin.code, null);
  assert.equal(display.checkin.code_allowed, false);
  assert.equal(display.checkin.checked_in_count, 2);
  assert.equal(display.checkin.participant_count, 3);
  assert.equal(display.checkin.waitlisted_count, 1);
  assert.deepEqual(display.checkin.participants.map(({ status }) => status), [
    "checked_in", "checked_in", "registered", "waitlisted",
  ]);
  assert.equal(h.sqls.some(({ sql }) => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)), false);
});

test("Public Live never generates missing check-in codes on reads", async () => {
  const h = publicDisplayFixture({ method: "code", code: null });
  const display = await h.repo.publicCheckinDisplay({ clubSlug: "blindleia-dartklubb" });
  assert.equal(display.active, false);
  assert.equal(h.sqls.some(({ sql }) => sql.includes("bd_test_tournament_players")), false);
});

test("Live retains the 3-second code-based wall and counts when code exists", async () => {
  const h = publicDisplayFixture({ method: "admin_or_code", code: "ABC" });
  const display = await h.repo.publicCheckinDisplay({ clubSlug: "blindleia-dartklubb" });
  assert.equal(display.active, true);
  assert.equal(display.checkin.code, "ABC");
  assert.equal(display.checkin.code_allowed, true);
});

test("Rendered Live wall guides admin-only attendees without inventing a code", () => {
  const source = extract("apps/live/app.js", "function renderCheckin(data) {", "function markCheckinRefreshProblem()");
  function textEl() { return { textContent: "", classList: { toggle() {} }, dataset: {}, style: {} }; }
  const ids = ["clubName","tournamentName","tournamentMeta","connectionLabel","checkinTournamentName",
    "checkinCode","checkinWindow","checkinCount","checkinProgressBar","checkinRosterCount",
    "checkinParticipants","checkinLead","checkinCodeLabel","checkinCodeCard","checkinUpdatedAt"];
  const el = Object.fromEntries(ids.map((id) => [id, textEl()]));
  const state = { phase: "standby", checkin: null, payload: null, checkinFetchedAt: 0 };
  const scope = {
    state, el, document: { title: "" }, Date,
    Intl, Math, Number, String,
    formatDateTime: () => "09.11. kl. 18:30",
    formatTime: () => "18:30",
    esc: (v) => String(v),
    participantStatus: (v) => v, participantClass: (v) => v,
  };
  const render = vm.runInNewContext(source + "\nrenderCheckin;", scope);
  const success = render({
    active: true,
    checkin: { tournament_name: "Mandagsserien", method: "admin_only", code: null,
      participants: [{ display_name: "Ada", status: "checked_in" }],
      participant_count: 2, checked_in_count: 1 },
  });
  assert.equal(success, true);
  assert.equal(el.checkinCode.textContent, "Hos turneringsleder");
  assert.match(el.checkinLead.textContent, /hos turneringsleder/);
  assert.equal(el.checkinCount.textContent, "1 av 2 sjekket inn");
  assert.equal(el.checkinUpdatedAt.dataset.stale, "0");
});

test("Transient Live check-in failure warns that the last attendance snapshot is stale", () => {
  const source = extract("apps/live/app.js", "function markCheckinRefreshProblem() {", "function renderProgress(");
  const el = { checkinUpdatedAt: { dataset: {}, textContent: "" }, connectionLabel: { textContent: "" } };
  const scope = { state: { phase: "checkin", checkinFetchedAt: Date.now() - 10000 }, el, Date, Intl };
  const mark = vm.runInNewContext(source + "\nmarkCheckinRefreshProblem;", scope);
  mark();
  assert.equal(el.checkinUpdatedAt.dataset.stale, "1");
  assert.match(el.checkinUpdatedAt.textContent, /siste bekreftede oppmøte/);
  assert.equal(el.connectionLabel.textContent, "Oppdatering forsinket");
});

test("Attendance closure rejects an old confirmation BEFORE marking anybody as a no-show", async () => {
  const executes = [];
  const session = {
    withTransaction: async (fn) => fn({
      query: async (sql, params) => {
        if (sql.includes("FROM `bd_test_tournaments` t"))
          return [{ id: "99", club_id: "7", status: "draft", start_at: "2026-11-09 18:30:00" }];
        if (sql.includes("COUNT(*)")) {
          const types = params.slice(1);
          return [{ cnt: types.includes("checked_in") ? 16 : types.includes("registered") ? 2 : 1 }];
        }
        throw new Error(sql);
      },
      execute: async (sql) => { executes.push(sql); return { affectedRows: 1 }; },
    }),
  };
  const repo = new MySqlTournamentAttendanceRepository(session, "bd_test_");
  await assert.rejects(
    repo.finishCheckin("99", { checked_in_count: 15, not_checked_in_count: 3, waitlisted_count: 1 }),
    (error) => error?.code === "attendance_changed_since_confirmation" && error?.status === 409,
  );
  assert.equal(executes.length, 0);
  const successful = await repo.finishCheckin("99", { checked_in_count: 16, not_checked_in_count: 2, waitlisted_count: 1 });
  assert.equal(successful.checked_in_count, 16);
  assert.ok(executes.some((sql) => sql.includes("status='no_show'")));
});

test("Leader UX requires explicit closure preflight and auto-refreshes draft attendance", () => {
  const leader = read("apps/admin/tournament-canonical-ux.js");
  const room = read("apps/admin/tournament-admin.js");
  const display = read("apps/live/app.js");
  const wizard = read("apps/admin/tournament-wizard-v2.js");
  const discovery = read("apps/player/tournament-discovery-ux.js");
  assert.match(leader, /confirmAttendanceClosure\(snapshot\)/);
  assert.match(leader, /if \(!confirmed \|\| currentTournamentId\(\) !== id\) return/);
  assert.match(leader, /checked_in_count: snapshot\.checked\.length/);
  assert.match(leader, /not_checked_in_count: snapshot\.pending\.length/);
  assert.match(leader, /waitlisted_count: snapshot\.waitlist\.length/);
  assert.match(room, /setInterval\(\(\) => refreshAttendanceSilently\(\)\.catch\(\(\) => undefined\), 8000\)/);
  assert.match(room, /state\.view !== "checkin"/);
  assert.match(room, /attendanceRevision\(next\) === attendanceRevision\(state\.tournament\)/);
  assert.match(display, /setInterval\(\(\) => load\(\)\.catch\(\(\) => undefined\), 3000\)/);
  assert.match(wizard, /stenger når du trykker «Avslutt innsjekk»/);
  assert.match(discovery, /eligibility\?\.can_register === false/);
  assert.match(discovery, /data-action="payments"/);
});
