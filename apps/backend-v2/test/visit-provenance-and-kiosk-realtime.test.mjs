import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

test("additive visit source migration keeps unknown historical provenance as legacy", () => {
  const migration = read("infra/sql/migrations/0089_add_visit_source.php");
  assert.match(migration, /ADD COLUMN `source` VARCHAR\(24\) NOT NULL DEFAULT 'legacy'/);
  assert.match(migration, /source='scolia'/);
  assert.match(migration, /request_key LIKE 'scolia-%'/);
  assert.match(migration, /source='manual'/);
  assert.match(migration, /request_key LIKE 'manual:%'/);
  assert.match(migration, /information_schema\.COLUMNS/);
  assert.doesNotMatch(migration, /DELETE FROM|DROP TABLE/i);
});

test("Node and PHP canonical scoring writers both persist explicit source", () => {
  const node = read("apps/backend-v2/src/mysql/canonical-scoring-repository.ts");
  const phpRepo = read("apps/api/src/Repository/MatchScoringRepository.php");
  const phpService = read("apps/api/src/Service/CanonicalScoringService.php");
  assert.match(node, /request_key, source\)/);
  assert.match(node, /requestKey,\s*source,\s*\]/);
  assert.match(phpRepo, /request_key, source\)/);
  assert.match(phpRepo, /\$storedRequestKey,\s*\$source/);
  assert.match(phpRepo, /invalid_scoring_source/);
  assert.match(phpService, /recordVisit\(\$kioskId, \$payload, \$source\)/);
});

test("canonical kiosk and Scolia views expose persisted source rather than guessing", () => {
  const kioskRead = read("apps/backend-v2/src/mysql/scolia-kiosk-auth-repository.ts");
  const scoliaRead = read("apps/backend-v2/src/mysql/scolia-command-repository.ts");
  assert.match(kioskRead, /v\.input_mode,v\.source/);
  assert.match(kioskRead, /source: String\(row\.source \?\? "legacy"\)/);
  assert.match(scoliaRead, /v\.request_key,v\.source/);
  assert.match(scoliaRead, /source: stringValue\(row\.source\)/);
  assert.match(scoliaRead, /v\.source='scolia'/);
});

test("Platform v2 kiosk subscribes to canonical snapshot notifications independently of Scolia", () => {
  const hook = read("apps/platform-v2/src/kiosk/useKioskSnapshotRealtime.ts");
  const workspace = read("apps/platform-v2/src/kiosk/KioskWorkspace.tsx");
  assert.match(hook, /kiosk:\$\{kioskCode\}/);
  assert.match(hook, /club:\$\{String\(clubId\)\}/);
  assert.match(hook, /message\.event !== "snapshot"/);
  assert.match(hook, /refreshRef\.current\(\)/);
  assert.match(hook, /window\.setTimeout\(\(\) => void connect\(\), 2500\)/);
  assert.match(workspace, /useKioskSnapshotRealtime\(\{/);
  assert.match(workspace, /enabled: Boolean\(kioskCode\)/);
  assert.match(workspace, /manualQueueRef\.current\.length > 0/);
  // The independent canonical polling fallback is retained.
  assert.match(workspace, /\}, 1500\);/);
});
