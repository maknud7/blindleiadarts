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

assert.equal(
  resolveBoardScoringMode({ scoring_mode: "manual" }, canonicalScolia),
  "scolia",
  "TEST runtime must display the physical board's canonical Scolia mode",
);
assert.equal(
  resolveBoardScoringMode({ scoring_mode: "scolia" }, {
    scoring_mode: "manual",
    mode: "off",
    physical_kiosk_id: 4,
    configuration_scope: "production_hardware",
  }),
  "manual",
  "Canonical physical mode must win over stale runtime state",
);
assert.equal(resolveBoardScoringMode({ scoring_mode: "scolia" }, null), "scolia");
assert.equal(
  shouldPersistRuntimeScoring({ isTestEnvironment: true, configurationScope: "production_hardware" }),
  false,
  "Saving canonical hardware from TEST must not turn the TEST alias into a physical Scolia board",
);
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

console.log("Board admin canonical Scolia and resilient equipment loading checks passed.");
