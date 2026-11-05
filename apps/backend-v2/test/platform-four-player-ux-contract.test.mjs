import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");

test("Tournament check-in closure and start enforce a consistent four-player minimum", () => {
  for (const path of [
    "apps/admin/tournament-canonical-ux.js",
    "apps/admin/tournament-admin.js",
    "apps/backend-v2/src/mysql/tournament-attendance-repository.ts",
    "apps/backend-v2/src/mysql/tournament-flow-repository.ts",
  ]) {
    assert.match(read(path), /(?:const |readonly )MIN_PLAYERS = 4;/, path);
    assert.doesNotMatch(read(path), /MIN_PLAYERS = 2;/, path);
  }
  assert.match(read("apps/backend-v2/src/mysql/tournament-attendance-repository.ts"), /checkedIn < MySqlTournamentAttendanceRepository\.MIN_PLAYERS/);
  assert.match(read("apps/backend-v2/src/mysql/tournament-flow-repository.ts"), /checkedIn < MySqlTournamentFlowRepository\.MIN_PLAYERS/);
});

test("Equipment navigation avoids repeated automatic Scolia API refreshes", () => {
  const loader = read("apps/admin/admin-section-loader.js");
  assert.match(loader, /equipmentRefreshedForClub\.has\(clubKey\)/);
  assert.match(loader, /currentTarget\(\) === "kiosks"/);
  assert.match(loader, /adminVisible && refreshButton/);
  assert.match(read("apps/admin/terminal-pairing-ux.js"), /requestAnimationFrame/);
});
