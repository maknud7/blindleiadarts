import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");

test("Live polling never owns board, group or ELO rotation clocks", () => {
  const live = read("apps/live/app.js");
  const board = read("apps/live/venue-wall-boards.js");
  const v2 = read("apps/live/live-v2.js");
  assert.match(live, /setInterval\(\(\) => load\(\)\.catch\(\(\) => undefined\), 3000\)/);
  assert.match(board, /const ROTATE_MS = 6000/);
  assert.match(board, /window\.setInterval\(\(\) => \{/);
  assert.match(v2, /\}, 20000\)/);
  assert.match(v2, /if \(liveV2State\.tableTimer\) return/);
  assert.match(v2, /if \(liveV2State\.eloTimer\) return/);
});

test("Live does not drop back to standby on transient failed API reads", () => {
  const live = read("apps/live/app.js");
  assert.match(live, /state\.phase === "checkin" && checkinResult\.status === "rejected"/);
  assert.match(live, /state\.phase === "live" && liveResult\.status === "rejected"/);
  assert.match(live, /if \(checkin\?\.active && renderCheckin\(checkin\)\)/);
  assert.match(live, /if \(state\.phase === "checkin"\) \{\s*load\(\)\.catch/);
  assert.match(live, /const live = message\?\.payload\?\.live \|\| null/);
});

test("all visible player check-in entry points open one code/window method", () => {
  const main = read("apps/player/app.js");
  const home = read("apps/player/player-ux.js");
  const details = read("apps/player/tournament-discovery-ux.js");
  const checkin = read("apps/player/checkin-runtime.js");

  assert.match(main, /BlindleiaCheckinWindow\.open\(tournamentId\)/);
  assert.match(home, /window\.BlindleiaCheckinWindow\?\.open/);
  assert.match(details, /await window\.BlindleiaCheckinWindow\.open\(id\)/);
  assert.doesNotMatch(details, /if\(action==="checkin"\) await api\(/);
  assert.match(checkin, /open: \(tournamentId\) => openCheckin\(Number\(tournamentId\)\)/);
  assert.match(checkin, /status\.window_state === "not_open"/);
  assert.match(checkin, /status\.method === "admin_only"/);
  assert.match(checkin, /status\.code_allowed === false/);
  assert.match(checkin, /status\.registration_status !== "registered"/);
});

test("check-in confirmation refreshes player state without page reload or jumping scroll", () => {
  const checkin = read("apps/player/checkin-runtime.js");
  const main = read("apps/player/app.js");
  assert.match(checkin, /await window\.BlindleiaPlayerRuntime\?\.refresh\?\.\(\)/);
  assert.match(checkin, /checkinSubmitting = true/);
  assert.match(checkin, /if \(checkinSubmitting \|\| !activeTournamentId\) return/);
  assert.match(checkin, /bd:player-state-changed/);
  assert.doesNotMatch(checkin, /window\.location\.reload\(/);
  assert.doesNotMatch(checkin, /root\.scrollIntoView/);
  assert.match(main, /refresh: async \(\) =>/);
});

test("registration and withdrawal reject duplicate taps while canonical request is pending", () => {
  const main = read("apps/player/app.js");
  assert.match(main, /const pendingTournamentActions = new Set\(\)/);
  assert.match(main, /if \(pendingTournamentActions\.has\(key\)\) return/);
  assert.match(main, /node\.disabled = true/);
  assert.match(main, /await runTournamentAction\("register", tournamentId/);
  assert.match(main, /await runTournamentAction\("withdraw", tournamentId/);
});

test("tournament-detail action errors stay visible and do not replace button labels", () => {
  const details = read("apps/player/tournament-discovery-ux.js");
  assert.match(details, /note\.className="tdx-action-error"/);
  assert.match(details, /note\.setAttribute\("role","alert"\)/);
  assert.match(details, /actionPending=true/);
  assert.doesNotMatch(details, /if\(b\) b\.textContent=error\.message/);
});
