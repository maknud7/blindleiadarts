import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const endpoint = readFileSync("apps/api/test-player-candidates.php", "utf8");
const client = readFileSync("apps/admin/test-tournament-tools.js", "utf8");
const attendance = readFileSync("apps/api/src/TournamentAttendanceApplication.php", "utf8");
const flow = readFileSync("apps/api/src/Repository/TournamentFlowRepository.php", "utf8");
const importProbe = readFileSync("apps/api/atlas-import-probe.php", "utf8");
const tournamentProbe = readFileSync("apps/api/atlas-tournament-probe.php", "utf8");
const cleanup = readFileSync("infra/sql/migrations/0068_cleanup_test_champion_player_labels.php", "utf8");

assert.match(endpoint, /tp\.is_active=1/);
assert.match(endpoint, /tp\.merged_into_player_id IS NULL/);
assert.match(endpoint, /CASE WHEN ip\.id IS NULL THEN 'test_player' ELSE 'prod_identity' END/);
assert.doesNotMatch(endpoint, /account_status='active'/);
assert.doesNotMatch(client, /Number\(player\.member_id\) > 0/);
assert.doesNotMatch(client, /identity_source \|\| ""\) === "prod_identity"/);
assert.match(client, /alle aktive spillere i TEST/);

// Existing players added by admin/TEST must reach the canonical Application
// registration route instead of being rejected by the attendance layer.
assert.doesNotMatch(attendance, /legacyAdminRegistration/);
assert.doesNotMatch(attendance, /self_registration_required/);

// One Start action must be able to finalize draft attendance and continue into
// the canonical start handler. The UI already treats two checked-in players as
// the minimum, so both backend guards must agree with that rule.
assert.match(attendance, /private const MIN_PLAYERS = 2;/);
assert.match(flow, /private const MIN_PLAYERS = 2;/);
assert.match(attendance, /if \(\(string\) \$tournament\['status'\] === 'draft'\)/);
assert.match(attendance, /\$this->finishCheckin\(\$connection, \$prefix, \$tournament\);/);

assert.match(importProbe, /preg_replace\('\/\^Champion\\s\+\/iu'/);
assert.match(tournamentProbe, /preg_replace\('\/\^Champion\\s\+\/iu'/);
assert.match(cleanup, /Historical import label accidentally stored as TEST player name/);

console.log("TEST player and tournament admin contract checks passed.");
