import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const repository = readFileSync("apps/backend-v2/src/mysql/scolia-admin-repository.ts", "utf8");
const router = readFileSync("apps/backend-v2/src/runtime/equipment-admin-router.ts", "utf8");
const ui = readFileSync("apps/admin/scolia-release-control.js", "utf8");
const readonly = readFileSync("apps/admin/test-hardware-readonly.js", "utf8");
const admin = readFileSync("apps/admin/index.html", "utf8");

assert.match(repository, /payload\.bridge_attached !== undefined/);
assert.match(repository, /SET mode=\?,updated_by_user_id=\?/);
assert.match(repository, /Scolia frikoblet fra Blindleia av admin/);
assert.match(repository, /scolia_test_leases/);
assert.match(repository, /status='expired'/);
assert.match(repository, /bridge_released/);
assert.match(repository, /direct_scolia_ready/);
assert.match(repository, /can_change_bridge: this\.runtimePrefix === this\.hardwarePrefix/);

const releaseStart = repository.indexOf("  private async setBridgeAttachedWith(");
const releaseEnd = repository.indexOf("\n  private async getRuntimeStatusWith", releaseStart);
assert.ok(releaseStart >= 0 && releaseEnd > releaseStart, "setBridgeAttachedWith method must exist");
const releaseMethod = repository.slice(releaseStart, releaseEnd);
assert.doesNotMatch(releaseMethod, /UPDATE .*kiosks.*SET scoring_mode/s);
assert.match(releaseMethod, /UPDATE .*scolia_board_settings.*SET mode=/s);

assert.match(router, /assertProductionHardwareMutationAllowed\(this\.config\)/);
assert.match(router, /\/scolia\$\/\.exec\(path\)/);

assert.match(ui, /Frikoble Scolia/);
assert.match(ui, /Koble til Blindleia/);
assert.match(ui, /kan brukes direkte i Scolia/);
assert.match(ui, /release_effective_within_seconds/);
assert.match(ui, /data-scolia-action/);
assert.match(ui, /method: "PATCH"/);
assert.match(ui, /bridge_attached/);
assert.match(ui, /\/api\/v1\/clubs\//);
assert.doesNotMatch(ui, /scolia-bridge-control\.php/);
assert.match(ui, /let syncRunning = false/);
assert.match(ui, /if \(syncRunning\)/);
assert.match(ui, /mutations\.every\(mutationIsInternal\)/);
assert.match(ui, /if \(button\.textContent !== action\.label\)/);
assert.match(ui, /if \(status\.innerHTML !== statusHtml\)/);
assert.match(ui, /button\.className = "button secondary scolia-release-quick"/);
assert.doesNotMatch(ui, /button\.className = "[^"]*board-edit-button[^"]*scolia-release-quick/);

assert.match(readonly, /"boardEditorForm"/);
assert.match(readonly, /function lockBoardEditor\(\)/);
assert.match(readonly, /#boardScoliaActions button/);
assert.doesNotMatch(readonly, /test-hardware-readonly \.board-edit-button/);
assert.doesNotMatch(readonly, /#newBoardButton, \.board-edit-button/);
assert.match(admin, /scolia-release-control\.js\?v=/);

console.log("Scolia release control contract: backend-v2 OK");
