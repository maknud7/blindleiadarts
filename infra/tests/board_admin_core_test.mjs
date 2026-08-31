import assert from "node:assert/strict";
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

console.log("Board admin canonical Scolia checks passed.");
