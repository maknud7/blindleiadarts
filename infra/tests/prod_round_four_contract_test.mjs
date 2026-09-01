import fs from 'node:fs';
import assert from 'node:assert/strict';

const elo = fs.readFileSync('apps/api/src/Repository/EloReadRepository.php', 'utf8');
const cleanup = fs.readFileSync('infra/sql/migrations/0069_cleanup_prod_empty_elo_shadow_players.php', 'utf8');
const promoter = fs.readFileSync('infra/sql/atlas_promote_test_history_to_prod.php', 'utf8');
const summaryPublisher = fs.readFileSync('infra/sql/atlas_publish_round_four_summary_test.php', 'utf8');

assert.match(elo, /elo_source.*elo_ledger/s);
assert.match(elo, /\$byName/);
assert.match(cleanup, /prefix !== 'bd_prod_'/);
assert.match(cleanup, /all_foreign_key_references_verified_zero/);
assert.match(cleanup, /25 => 1/);
assert.match(cleanup, /36 => 2/);
assert.match(cleanup, /Active PROD player-name duplicates remain/);
assert.match(promoter, /incremental_existing_season/);
assert.match(promoter, /required for incremental promotion/);
assert.match(summaryPublisher, /Summary staging is TEST-only/);
assert.match(summaryPublisher, /jort2WSBWFwN/);

console.log('prod round four safety contract: ok');
