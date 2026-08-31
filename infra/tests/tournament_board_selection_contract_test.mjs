import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const boardUx = readFileSync("apps/admin/tournament-board-selection.js", "utf8");
const leaderAdapter = readFileSync("apps/admin/tournament-leader-v2-board-state.js", "utf8");
const attendance = readFileSync("apps/api/src/TournamentAttendanceApplication.php", "utf8");
const flow = readFileSync("apps/api/src/Repository/TournamentFlowRepository.php", "utf8");

assert.match(boardUx, /selectionIsExplicit\(\)/);
assert.match(boardUx, /const selected = explicit && Boolean\(board\.selected\)/);
assert.match(boardUx, /Skiver for denne turneringen/);
assert.match(boardUx, /Bekreft skiver/);
assert.match(boardUx, /Nye kamper sendes bare til disse/);
assert.match(leaderAdapter, /const MIN_PLAYERS = 2/);
assert.match(leaderAdapter, /Ingen skiver er bekreftet/);
assert.match(attendance, /private const MIN_PLAYERS = 2/);
assert.match(flow, /private const MIN_PLAYERS = 2/);

console.log("Tournament board selection and flow consistency checks passed.");
