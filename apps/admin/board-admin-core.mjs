export function resolveBoardScoringMode(runtimeBoard = {}, canonicalBoard = null) {
  if (canonicalBoard && typeof canonicalBoard === "object") {
    const physicalMode = String(canonicalBoard.scoring_mode || "").trim().toLowerCase();
    const scoliaMode = String(canonicalBoard.mode || "").trim().toLowerCase();
    const serial = String(canonicalBoard.serial_number || "").trim();
    const isCanonicalHardware = canonicalBoard.configuration_scope === "production_hardware"
      || Number(canonicalBoard.physical_kiosk_id || 0) > 0;

    if (isCanonicalHardware) {
      return physicalMode === "scolia" || (["live", "shadow"].includes(scoliaMode) && serial !== "")
        ? "scolia"
        : "manual";
    }
  }

  return String(runtimeBoard?.scoring_mode || "").trim().toLowerCase() === "scolia"
    ? "scolia"
    : "manual";
}

export function shouldPersistRuntimeScoring({ isTestEnvironment = false, configurationScope = "" } = {}) {
  return !(isTestEnvironment && configurationScope === "production_hardware");
}
