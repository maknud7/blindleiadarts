import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");

test("Player registration and every check-in entry use the same guarded controller", () => {
  const detail = read("apps/player/tournament-discovery-ux.js");
  const home = read("apps/player/player-ux.js");
  const checkin = read("apps/player/checkin-runtime.js");
  assert.match(detail, /BlindleiaCheckinWindow\?\.open/);
  assert.doesNotMatch(detail, /if\(action==="checkin"\) await api/);
  assert.match(home, /BlindleiaPlayerRuntime\?\.register/);
  assert.match(checkin, /if \(checkinSubmitting \|\| !activeTournamentId\) return/);
  assert.match(checkin, /window\.BlindleiaPlayerRuntime\?\.refresh/);
  assert.doesNotMatch(checkin, /window\.location\.reload\(\)/);
});

test("Closing check-in requires visible attendance preflight and transaction guard", () => {
  const ui = read("apps/admin/tournament-canonical-ux.js");
  const backend = read("apps/backend-v2/src/mysql/tournament-attendance-repository.ts");
  assert.match(ui, /confirmAttendanceClosure\(snapshot\)/);
  assert.match(ui, /Bekreft avslutning/);
  assert.match(ui, /Disse blir markert som «Ikke møtt»/);
  assert.match(ui, /checked_in_count: snapshot\.checked\.length/);
  assert.match(ui, /waitlisted_count: snapshot\.waitlist\.length/);
  assert.match(backend, /not_checked_in_count/);
  assert.match(backend, /waitlisted_count/);
  assert.match(backend, /no_show/);
});

test("Clubadmin and leader refresh draft attendance without mutating registrations", () => {
  const leader = read("apps/admin/tournament-leader-v2.js");
  const admin = read("apps/admin/tournament-admin.js");
  assert.match(leader, /status\(\) === "draft" \? 8000 : 15000/);
  assert.match(leader, /bd:tournament-attendance-updated/);
  assert.match(leader, /rootCheckinFreshness/);
  assert.match(leader, /latest = await optional\(`\/tournaments\/\$\{id\}`\)/);
  assert.match(admin, /addEventListener\("bd:tournament-attendance-updated"/);
  assert.match(admin, /const before = JSON\.stringify\(state\.tournament\.registrations/);
  assert.match(admin, /if \(before === after\) return/);
  assert.match(admin, /state\.tournament = \{ \.\.\.state\.tournament, \.\.\.update\.tournament \}/);
});

test("Live wall reads canonical check-in roster every 3s with visible stale indicator", () => {
  const wall = read("apps/live/app.js");
  const db = read("apps/backend-v2/src/mysql/public-live-read-repository.ts");
  const page = read("apps/live/index.html");
  assert.match(wall, /setInterval\(\(\) => load\(\)\.catch\(\(\) => undefined\), 3000\)/);
  assert.match(wall, /checkinResult\.status === "rejected"/);
  assert.match(wall, /markCheckinRefreshProblem\(\)/);
  assert.match(wall, /state\.phase === "checkin"/);
  assert.match(wall, /checkin\.code_missing/);
  assert.match(wall, /if \(state\.lastCheckinRosterMarkup !== rosterMarkup\)/);
  assert.match(page, /id="checkinUpdatedAt"/);
  assert.match(db, /status IN \('checked_in','registered','waitlisted'\)/);
  assert.match(db, /code_allowed: codeAllowed && code !== null/);
  assert.doesNotMatch(db.slice(db.indexOf("private async publicDisplayForClub"), db.indexOf("private async", db.indexOf("private async publicDisplayForClub") + 1)), /\b(?:UPDATE|INSERT|DELETE)\s+`/i);
});

test("Admin asset versions expose updated attendance controller on browser cache", () => {
  assert.match(read("apps/admin/index.html"), /tournament-loader\.js\?v=20261105-journey-attendance-live-02/);
  assert.match(read("apps/admin/tournament-loader.js"), /MODULE_VERSION = "20261105-journey-attendance-live-02"/);
});
