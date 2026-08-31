import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const endpoint = readFileSync("apps/api/test-player-candidates.php", "utf8");
const client = readFileSync("apps/admin/test-tournament-tools.js", "utf8");
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
assert.match(importProbe, /preg_replace\('\/\^Champion\\s\+\/iu'/);
assert.match(tournamentProbe, /preg_replace\('\/\^Champion\\s\+\/iu'/);
assert.match(cleanup, /Historical import label accidentally stored as TEST player name/);

console.log("TEST player candidate contract checks passed.");
