import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { composePlayerEloTournamentTimeline } from "../dist/domain/elo-tournament-timeline.js";

const event = (id, season, date) => ({
  id, season_id: season, name: "ELO-turnering " + String(id),
  status: "completed", start_at: date, end_at: date,
});

test("one ELO point per eligible tournament including all missed tournaments", () => {
  const events = [
    event("9007199254740993", "101", "2026-08-10"),
    event("9007199254740994", "101", "2026-08-17"),
    event("9007199254740995", "101", "2026-08-24"),
    event("9007199254740996", "101", "2026-08-31"),
    event("9007199254740997", "102", "2027-01-04"),
    event("9007199254740998", "102", "2027-01-11"),
  ];
  const snaps = [
    { tournament_id: "9007199254740994", rating_before: 1000, rating_after: 1035,
      tournament_matches: 4, matches_before: 0, matches_after: 4 },
    { tournament_id: "9007199254740996", rating_before: 1035, rating_after: 1015,
      tournament_matches: 3, matches_before: 4, matches_after: 7 },
  ];
  const result = composePlayerEloTournamentTimeline(events, snaps);
  assert.equal(result.length, events.length);
  assert.deepEqual(result.map((row) => row.rating_after), [1000, 1035, 1035, 1015, 1000, 1000]);
  assert.deepEqual(result.map((row) => row.delta), [0, 35, 0, -20, 0, 0]);
  assert.deepEqual(result.map((row) => row.played_elo), [false, true, false, true, false, false]);
  assert.deepEqual(result.map((row) => row.completed), [true, true, true, true, true, true]);
  assert.equal(String(result[0].tournament_id), "9007199254740993");
  assert.equal(String(result[5].tournament_id), "9007199254740998");
});

test("a partially captured tournament cannot invent an ELO change", () => {
  const result = composePlayerEloTournamentTimeline(
    [event("9", "1", "2026-10-01"), event("10", "1", "2026-10-08")],
    [{ tournament_id: "9", rating_before: 1000, rating_after: 1040, tournament_matches: 2 },
     { tournament_id: "10", rating_before: 1070, rating_after: null, tournament_matches: 0 }],
  );
  assert.equal(result[0].rating_after, 1040);
  assert.equal(result[1].rating_before, 1040);
  assert.equal(result[1].rating_after, 1040);
  assert.equal(result[1].delta, 0);
});

test("both Node and legacy PHP player ELO readers use ELO-enabled completed club tournaments", () => {
  const nodeSource = fs.readFileSync("apps/backend-v2/src/mysql/player-live-read-repository.ts", "utf8");
  const phpSource = fs.readFileSync("apps/api/player-elo-tournaments.php", "utf8");
  assert.match(nodeSource, /elo_enabled=1 AND status='completed'/);
  assert.match(nodeSource, /composePlayerEloTournamentTimeline/);
  assert.match(phpSource, /elo_enabled=1 AND status="completed"/);
  assert.match(phpSource, /\$lastBySeason\[\$season\] = \$after;/);
});

test("player graph is the sole ELO renderer with keyboard-accessible selection and internal overflow", () => {
  const graph = fs.readFileSync("apps/player/elo-history-exact.js", "utf8");
  const stats = fs.readFileSync("apps/player/statistics-ux.js", "utf8");
  const css = fs.readFileSync("apps/player/statistics-ux.css", "utf8");
  assert.match(graph, /data-elo-interactive-chart/);
  assert.match(graph, /data-elo-point-index/);
  assert.match(graph, /bindChartSelection/);
  assert.match(graph, /Ett punkt for hver ELO-tellende turnering/);
  assert.doesNotMatch(stats, /eloSection\.innerHTML/);
  assert.match(css, /\.player-card\[hidden\]\{display:none!important\}/);
  assert.match(css, /\.table-scroll\{display:block;max-width:100%/);
});
