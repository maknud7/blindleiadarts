import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, legacyApi } from "../shared/api";
import { clearTestLeaseMarkers, read, write } from "../shared/storage";
import type { EnvironmentName, ScoliaBoard } from "../shared/types";

type Options = {
  environment?: EnvironmentName;
  kioskCode: string;
  kioskToken: string;
  testMode: boolean;
  physicalBoardId: number;
};

type LeaseResponse = {
  leased?: boolean;
  active?: boolean;
  released?: boolean;
  reason?: string;
  physical_kiosk_id?: number;
  test_kiosk_id?: number;
  expires_in_seconds?: number;
};

export type ScoliaDart = {
  multiplier?: string;
  m?: string;
  value?: number | string;
  v?: number | string;
};

export type ScoliaLastVisit = {
  id?: number;
  player_name?: string;
  score?: number;
  darts?: ScoliaDart[];
  darts_used?: number;
  is_bust?: boolean;
  remaining_after?: number;
};

export type ScoliaRuntimeBoard = ScoliaBoard & {
  buffer?: { match_id?: number; player_id?: number; darts?: ScoliaDart[]; updated_at?: string | null } | null;
  reported_board_status?: string | null;
  physical_board_status?: string | null;
  physical_status_age_seconds?: number | null;
  physical_status_fresh?: boolean;
  bridge_heartbeat_age_seconds?: number | null;
  bridge_heartbeat_fresh?: boolean;
  physical_available?: boolean;
};

type RuntimeResponse = { board?: ScoliaRuntimeBoard; command?: unknown };
type UiResponse = { board?: ScoliaRuntimeBoard; match_id?: number | null; last_visit?: ScoliaLastVisit | null; action?: string };

const OFFLINE_FALLBACK_GRACE_MS = 30_000;
const STATUS_INTERVAL_MS = 500;
const LEASE_ENSURE_INTERVAL_MS = 1_000;
const LEASE_HEARTBEAT_MS = 60_000;

function yes(value: unknown): boolean { return value === true || Number(value || 0) === 1; }
function isAvailable(board: ScoliaRuntimeBoard | null): boolean {
  if (!board) return false;
  if (board.physical_available === false) return false;
  return board.connection_state === "connected" && String(board.board_status || "").toLowerCase() !== "offline";
}

export function useScoliaRuntime({ environment, kioskCode, kioskToken, testMode, physicalBoardId }: Options) {
  const [board, setBoard] = useState<ScoliaRuntimeBoard | null>(null);
  const [lastVisit, setLastVisit] = useState<ScoliaLastVisit | null>(null);
  const [leasePending, setLeasePending] = useState(read("testLeasePending") === "1");
  const [leaseError, setLeaseError] = useState(read("testLeaseError"));
  const [runtimeError, setRuntimeError] = useState("");
  const [busy, setBusy] = useState("");
  const offlineSince = useRef(0);
  const leaseBusy = useRef(false);
  const heartbeatBusy = useRef(false);
  const runtimeBusy = useRef(false);
  const statusBusy = useRef(false);

  const isTest = environment === "test";
  const fallbackActive = yes(board?.fallback_active) || yes(board?.needs_reconciliation);
  const automatic = board?.mode === "live" && board?.effective_scoring_mode === "scolia" && !fallbackActive;
  const available = isAvailable(board);

  useEffect(() => {
    setBoard(null);
    setLastVisit(null);
    setRuntimeError("");
    offlineSince.current = 0;
  }, [kioskCode, physicalBoardId]);

  const clearLeaseState = useCallback(() => {
    clearTestLeaseMarkers();
    setLeasePending(false);
    setLeaseError("");
  }, []);

  const releaseLease = useCallback(async () => {
    if (!isTest || leaseBusy.current) return;
    const active = read("testLeaseActive") === "1";
    const code = read("testLeaseCode");
    const physicalId = Number(read("testLeasePhysicalId") || 0);
    if (!active || !code || !physicalId || !kioskToken) { clearLeaseState(); return; }
    leaseBusy.current = true;
    try {
      await legacyApi<LeaseResponse>("kiosk-scolia-test-lease.php?action=release", { method: "POST", kioskToken, body: { test_kiosk_code: code, physical_kiosk_id: physicalId } });
    } catch {
      // Server-side lease expiry is the safety net if a best-effort release cannot complete.
    } finally {
      clearLeaseState();
      leaseBusy.current = false;
    }
  }, [isTest, kioskToken, clearLeaseState]);

  const ensureLease = useCallback(async () => {
    if (!isTest || leaseBusy.current) return;
    if (!testMode || !physicalBoardId || !kioskCode || !kioskToken) {
      if (read("testLeaseActive") === "1") await releaseLease();
      else if (!testMode || !physicalBoardId) clearLeaseState();
      return;
    }

    const activePhysical = Number(read("testLeasePhysicalId") || 0);
    const activeCode = read("testLeaseCode");
    const activeMatches = read("testLeaseActive") === "1" && activePhysical === physicalBoardId && activeCode === kioskCode;
    if (activeMatches) {
      setLeasePending(false); setLeaseError(""); write("testLeasePending", null); write("testLeaseError", null); return;
    }
    if (read("testLeaseActive") === "1") await releaseLease();

    const notApplicable = Number(read("testLeaseNotApplicablePhysicalId") || 0);
    if (notApplicable === physicalBoardId) { setLeasePending(false); write("testLeasePending", null); return; }
    if (notApplicable && notApplicable !== physicalBoardId) write("testLeaseNotApplicablePhysicalId", null);

    leaseBusy.current = true;
    setLeasePending(true); write("testLeasePending", "1");
    try {
      const data = await legacyApi<LeaseResponse>("kiosk-scolia-test-lease.php?action=acquire", { method: "POST", kioskToken, body: { test_kiosk_code: kioskCode, physical_kiosk_id: physicalBoardId } });
      if (data.leased) {
        write("testLeaseActive", "1"); write("testLeasePhysicalId", physicalBoardId); write("testLeaseCode", kioskCode); write("testLeaseNotApplicablePhysicalId", null);
      } else {
        write("testLeaseActive", null); write("testLeasePhysicalId", null); write("testLeaseCode", null); write("testLeaseNotApplicablePhysicalId", physicalBoardId);
      }
      write("testLeasePending", null); write("testLeaseError", null); setLeasePending(false); setLeaseError("");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Kunne ikke koble TEST til Scolia.";
      write("testLeasePending", "1"); write("testLeaseError", message); setLeasePending(true); setLeaseError(message);
    } finally { leaseBusy.current = false; }
  }, [isTest, testMode, physicalBoardId, kioskCode, kioskToken, releaseLease, clearLeaseState]);

  const heartbeatLease = useCallback(async () => {
    if (!isTest || heartbeatBusy.current || read("testLeaseActive") !== "1") return;
    const code = read("testLeaseCode"); const physicalId = Number(read("testLeasePhysicalId") || 0);
    if (!testMode || code !== kioskCode || physicalId !== physicalBoardId) { await releaseLease(); return; }
    heartbeatBusy.current = true;
    try {
      await legacyApi<LeaseResponse>("kiosk-scolia-test-lease.php?action=heartbeat", { method: "POST", kioskToken, body: { test_kiosk_code: code, physical_kiosk_id: physicalId } });
      write("testLeaseError", null); setLeaseError("");
    } catch (cause) {
      write("testLeaseActive", null); write("testLeasePending", "1");
      const message = cause instanceof Error ? cause.message : "Scolia-testleasen mistet forbindelsen.";
      write("testLeaseError", message); setLeasePending(true); setLeaseError(message); await ensureLease();
    } finally { heartbeatBusy.current = false; }
  }, [isTest, testMode, kioskCode, physicalBoardId, kioskToken, releaseLease, ensureLease]);

  const readStatus = useCallback(async (): Promise<UiResponse | null> => {
    if (!kioskCode || !kioskToken || leasePending || statusBusy.current) return null;
    statusBusy.current = true;
    try {
      const data = await legacyApi<UiResponse>(`kiosk-scolia-ui.php?action=status&kiosk_code=${encodeURIComponent(kioskCode)}`, { kioskToken });
      setBoard(data.board || null); setLastVisit(data.last_visit || null); setRuntimeError("");
      return data;
    } catch (cause) {
      if (cause instanceof ApiError && [404, 409].includes(cause.status)) { setBoard(null); setLastVisit(null); return null; }
      setRuntimeError(cause instanceof Error ? cause.message : "Scolia-status kunne ikke leses.");
      return null;
    } finally { statusBusy.current = false; }
  }, [kioskCode, kioskToken, leasePending]);

  const runtimeAction = useCallback(async (action: "fallback" | "resume" | "reset-phase", body?: unknown) => {
    if (!kioskCode || !kioskToken || runtimeBusy.current) return;
    runtimeBusy.current = true; setBusy(action); setRuntimeError("");
    try {
      const data = await api<RuntimeResponse>(`/kiosks/${encodeURIComponent(kioskCode)}/scolia/${action}`, { method: "POST", kioskToken, body });
      if (data.board) setBoard(data.board);
      await readStatus();
      offlineSince.current = 0;
    } catch (cause) { setRuntimeError(cause instanceof Error ? cause.message : "Scolia-handlingen feilet."); }
    finally { runtimeBusy.current = false; setBusy(""); }
  }, [kioskCode, kioskToken, readStatus]);

  const poll = useCallback(async () => {
    const data = await readStatus();
    const next = data?.board || null;
    if (!next || leasePending) return;
    const inFallback = yes(next.fallback_active) || yes(next.needs_reconciliation);
    const disconnected = !isAvailable(next);
    const shouldFallback = next.mode === "live" && next.effective_scoring_mode === "scolia" && !inFallback && yes(next.auto_fallback_to_manual ?? 1) && disconnected;
    if (!shouldFallback) offlineSince.current = 0;
    else if (!offlineSince.current) offlineSince.current = Date.now();
    else if (Date.now() - offlineSince.current >= OFFLINE_FALLBACK_GRACE_MS && !runtimeBusy.current) await runtimeAction("fallback");
  }, [readStatus, leasePending, runtimeAction]);

  const undoScolia = useCallback(async () => {
    if (!kioskCode || !kioskToken || runtimeBusy.current) return;
    const bufferDarts = board?.buffer?.darts || [];
    if (bufferDarts.length === 0 && !window.confirm("Ta pilene ut av skiva først. Angre siste Scolia-kast?")) return;
    runtimeBusy.current = true; setBusy("undo"); setRuntimeError("");
    try {
      const data = await legacyApi<UiResponse>("kiosk-scolia-ui.php?action=undo", { method: "POST", kioskToken, body: { kiosk_code: kioskCode } });
      setBoard(data.board || null); setLastVisit(data.last_visit || null);
    } catch (cause) { setRuntimeError(cause instanceof Error ? cause.message : "Kunne ikke angre Scolia-kastet."); }
    finally { runtimeBusy.current = false; setBusy(""); }
  }, [kioskCode, kioskToken, board?.buffer?.darts]);

  useEffect(() => {
    void ensureLease();
    if (!isTest) return;
    const timer = window.setInterval(() => void ensureLease(), LEASE_ENSURE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isTest, ensureLease]);
  useEffect(() => {
    if (!isTest) return;
    const timer = window.setInterval(() => void heartbeatLease(), LEASE_HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [isTest, heartbeatLease]);
  useEffect(() => {
    void poll();
    const timer = window.setInterval(() => void poll(), STATUS_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [poll]);

  const fallbackRemainingSeconds = useMemo(() => {
    if (!offlineSince.current || fallbackActive || available) return 0;
    return Math.max(0, Math.ceil((OFFLINE_FALLBACK_GRACE_MS - (Date.now() - offlineSince.current)) / 1000));
  }, [board, fallbackActive, available]);

  return {
    board,
    lastVisit,
    leasePending,
    leaseError,
    runtimeError,
    busy,
    available,
    fallbackActive,
    automatic,
    fallbackRemainingSeconds,
    effectiveScoringMode: fallbackActive ? "manual" : (board?.effective_scoring_mode || null),
    fallback: () => runtimeAction("fallback"),
    resume: () => runtimeAction("resume", { reconciled: true }),
    resetPhase: () => runtimeAction("reset-phase"),
    undo: undoScolia,
    releaseLease,
    refresh: poll,
  };
}
