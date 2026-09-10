const KEYS = {
  adminToken: "bd:token",
  selectedClub: "bd:selectedClubId",
  kioskCode: "bd:kioskCode",
  kioskToken: "bd:kioskPairingToken",
  pairingRequest: "bd:kioskPairingRequestCode",
  pairingExpires: "bd:kioskPairingExpires",
  testMode: "bd:kioskTestMode",
  testPhysicalBoardId: "bd:kioskTestPhysicalBoardId",
  testBoardLabel: "bd:kioskTestBoardLabel",
} as const;

export function read(key: keyof typeof KEYS): string {
  return localStorage.getItem(KEYS[key]) || "";
}

export function write(key: keyof typeof KEYS, value: string | number | null | undefined): void {
  const storageKey = KEYS[key];
  if (value === null || value === undefined || String(value) === "") localStorage.removeItem(storageKey);
  else localStorage.setItem(storageKey, String(value));
}

export function ensureKioskToken(): string {
  const existing = read("kioskToken");
  if (existing) return existing;
  const token = globalThis.crypto?.randomUUID?.() || `board-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  write("kioskToken", token);
  return token;
}

export function clearKioskRuntime(): void {
  write("kioskCode", null);
  write("pairingRequest", null);
  write("pairingExpires", null);
  write("testPhysicalBoardId", null);
  write("testBoardLabel", null);
}
