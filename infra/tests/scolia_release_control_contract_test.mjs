import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const api = readFileSync("apps/api/scolia-bridge-control.php", "utf8");
const ui = readFileSync("apps/admin/scolia-release-control.js", "utf8");
const admin = readFileSync("apps/admin/index.html", "utf8");

assert.match(api, /SET mode=\?,updated_by_user_id=\?/);
assert.match(api, /Scolia frikoblet fra Blindleia av admin/);
assert.match(api, /DELETE FROM `\{\$leaseTable\}` WHERE physical_kiosk_id=\?/);
assert.match(api, /status='expired'/);
assert.match(api, /production_hardware_read_only/);
assert.match(api, /\$dataPrefix === \$hardwarePrefix/);
assert.doesNotMatch(api, /UPDATE `\{\$[^}]*kiosks[^}]*\}` SET scoring_mode/);

assert.match(ui, /Frikoble Scolia/);
assert.match(ui, /Koble til Blindleia/);
assert.match(ui, /kan brukes direkte i Scolia/);
assert.match(ui, /release_effective_within_seconds/);
assert.match(ui, /data-scolia-action/);
assert.match(admin, /scolia-release-control\.js\?v=/);

console.log("Scolia release control contract: OK");
