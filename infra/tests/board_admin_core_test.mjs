import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveBoardScoringMode, shouldPersistRuntimeScoring } from "../../apps/admin/board-admin-core.mjs";

const canonicalScolia = {
  scoring_mode: "scolia",
  mode: "live",
  serial_number: "QRXX-MHV7-RJQ7",
  physical_kiosk_id: 4,
  configuration_scope: "production_hardware",
};

assert.equal(resolveBoardScoringMode({ scoring_mode: "manual" }, canonicalScolia), "scolia", "TEST runtime must display the physical board's canonical Scolia mode");
assert.equal(
  resolveBoardScoringMode({ scoring_mode: "scolia" }, { scoring_mode: "manual", mode: "off", physical_kiosk_id: 4, configuration_scope: "production_hardware" }),
  "manual",
  "Canonical physical mode must win over stale runtime state",
);
assert.equal(resolveBoardScoringMode({ scoring_mode: "scolia" }, null), "scolia");
assert.equal(shouldPersistRuntimeScoring({ isTestEnvironment: true, configurationScope: "production_hardware" }), false, "Saving canonical hardware from TEST must not turn the TEST alias into a physical Scolia board");
assert.equal(shouldPersistRuntimeScoring({ isTestEnvironment: false, configurationScope: "production_hardware" }), true);
assert.equal(shouldPersistRuntimeScoring({ isTestEnvironment: true, configurationScope: "" }), true);

const adminApp = readFileSync("apps/admin/app.js", "utf8");
const loadKioskAdmin = adminApp.match(/async function loadKioskAdmin\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
assert.match(loadKioskAdmin, /const kiosks = await api\(`\/clubs\/\$\{state\.clubId\}\/kiosks`\)/);
assert.match(loadKioskAdmin, /state\.kiosks = kiosks\.items \|\| \[\]/);
assert.match(loadKioskAdmin, /try \{[\s\S]*kiosk-pairing-requests/);
assert.match(loadKioskAdmin, /catch \(error\) \{[\s\S]*state\.pairingRequests = \[\]/);
assert.doesNotMatch(loadKioskAdmin, /Promise\.all\(/, "Pairing failure must not prevent canonical boards from loading");
assert.match(adminApp, /Promise\.allSettled\(\[loadAdminData\(\), loadKioskAdmin\(\)\]\)/, "Admin must render independent data domains even when one fails");

const equipmentRepository = readFileSync("apps/api/src/Repository/EquipmentRepository.php", "utf8");
assert.match(equipmentRepository, /WHERE club_id=\? AND is_active=1 ORDER BY board_number,id/, "Runtime board registry must remain active-only");

const inventoryRepository = readFileSync("apps/api/src/Repository/EquipmentInventoryRepository.php", "utf8");
assert.match(inventoryRepository, /WHERE club_id=\? ORDER BY is_active DESC,board_number,id/, "Admin inventory must include inactive boards");
assert.match(inventoryRepository, /\$this->equipment->listBoards\(\$environmentClubId\)/, "Active runtime state must be reused rather than reimplemented");
assert.match(inventoryRepository, /function isActiveBoard\(/, "Pairing boundary needs a canonical activation lookup");

const equipmentApplication = readFileSync("apps/api/src/EquipmentApplication.php", "utf8");
assert.match(equipmentApplication, /v1\/clubs\/\(\\d\+\)\/equipment\/boards/);
assert.match(equipmentApplication, /equipment\/boards[\s\S]*requireAdmin\(\$request, \$users, \$clubId\)[\s\S]*inventory->listBoards/, "Inactive inventory must require admin access");
assert.match(equipmentApplication, /!\$inventory->isActiveBoard\(\$clubId, \$physicalId\)/, "Pairing must reject inactive physical boards server-side");
assert.match(equipmentApplication, /board_inactive/);

const v2Equipment = readFileSync("apps/platform-v2/src/equipment/EquipmentWorkspace.tsx", "utf8");
assert.match(v2Equipment, /equipment\/boards/);
assert.match(v2Equipment, /const \[inventoryBoards,/);
assert.match(v2Equipment, /const \[activeBoards,/);
assert.match(v2Equipment, /ScoliaPanel[\s\S]*boards=\{activeBoards\}/, "Inactive boards must not enter Scolia runtime controls");
assert.match(v2Equipment, /GlobalPairingClaim[\s\S]*boards=\{activeBoards\}/, "QR pairing must only receive active runtime boards");
assert.doesNotMatch(v2Equipment, /kiosk-pairing-requests/, "Platform v2 must not expose unclaimed terminals as a club-scoped inbox");

const globalPairing = readFileSync("apps/platform-v2/src/equipment/GlobalPairingClaim.tsx", "utf8");
assert.match(globalPairing, /Number\(board\.is_active \?\? 1\) === 1 && !board\.is_paired/, "QR pairing choices must exclude inactive and already paired boards");
assert.match(globalPairing, /1\. Klubb/);
assert.match(globalPairing, /kiosk-pairing\.php\?action=claim&club_id=/, "The club must be assigned only when the global terminal code is claimed");

const boardEditor = readFileSync("apps/platform-v2/src/equipment/BoardEditor.tsx", "utf8");
assert.match(boardEditor, /name="is_active"/);
assert.match(boardEditor, /is_active: active \? 1 : 0/);
assert.match(boardEditor, /Kode fra nettbrett/, "Manual pairing belongs on the board itself");
assert.match(boardEditor, /Number\(board\.is_active \?\? 1\) !== 1/, "Inactive boards must not accept manual tablet pairing");

console.log("Board admin canonical Scolia, resilient loading, equipment inventory, and global pairing checks passed.");
