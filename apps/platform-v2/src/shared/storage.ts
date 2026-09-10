const KEYS = {
  adminToken: "bd:token",
  selectedClub: "bd:selectedClubId",
  kioskCode: "bd:kioskCode",
  kioskToken: "bd:kioskPairingToken",
  kioskPlayerInputModes: "bd:kioskPlayerInputModes",
  pairingRequest: "bd:kioskPairingRequestCode",
  pairingExpires: "bd:kioskPairingExpires",
  testMode: "bd:kioskTestMode",
  testPhysicalBoardId: "bd:kioskTestPhysicalBoardId",
  testBoardLabel: "bd:kioskTestBoardLabel",
  testReturnUrl: "bd:kioskTestReturnUrl",
  testEmbedded: "bd:kioskTestEmbedded",
  testLeaseActive: "bd:kioskScoliaLeaseActive",
  testLeaseCode: "bd:kioskScoliaLeaseKioskCode",
  testLeasePhysicalId: "bd:kioskScoliaLeasePhysicalId",
  testLeasePending: "bd:kioskScoliaLeasePending",
  testLeaseNotApplicablePhysicalId: "bd:kioskScoliaLeaseNotApplicablePhysicalId",
  testLeaseError: "bd:kioskScoliaLeaseError",
} as const;

export type StorageKey = keyof typeof KEYS;
export const STORAGE_EVENT = "bd:v2-storage";

export function read(key: StorageKey): string {
  return localStorage.getItem(KEYS[key]) || "";
}

export function write(key: StorageKey, value: string | number | null | undefined): void {
  const storageKey = KEYS[key];
  const normalized = value === null || value === undefined || String(value) === "" ? "" : String(value);
  if (!normalized) localStorage.removeItem(storageKey);
  else localStorage.setItem(storageKey, normalized);
  window.dispatchEvent(new CustomEvent(STORAGE_EVENT, { detail: { key, value: normalized } }));
}

export function ensureKioskToken(): string {
  const existing = read("kioskToken");
  if (existing) return existing;
  const token = globalThis.crypto?.randomUUID?.() || `board-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  write("kioskToken", token);
  return token;
}

export function clearTestLeaseMarkers(): void {
  write("testLeaseActive", null);
  write("testLeaseCode", null);
  write("testLeasePhysicalId", null);
  write("testLeasePending", null);
  write("testLeaseNotApplicablePhysicalId", null);
  write("testLeaseError", null);
}

export function clearKioskRuntime(): void {
  write("kioskCode", null);
  write("pairingRequest", null);
  write("pairingExpires", null);
  write("testPhysicalBoardId", null);
  write("testBoardLabel", null);
}
