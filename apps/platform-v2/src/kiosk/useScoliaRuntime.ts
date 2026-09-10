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

type RuntimeResponse = { board?: ScoliaBoard; command?: unknown };

const OFFLINE_FALLBACK_GRACE_MS = 30_000;
const STATUS_INTERVAL_MS = 1_500;
const LEASE_ENSURE_INTERVAL_MS = 1_000;
const LEASE_HEARTBEAT_MS = 60_000;

function yes(value: unknown): boolean {
  return value === true || Number(value || 0) === 1;
}

function isAvailable(board: ScoliaBoard | null): boolean {
  if (!board) return false;
  return board.connection_state === "connected" && String(board.board_status || "").toLowerCase() !== "offline";
}

export function useScoliaRuntime({ environment, kioskCode, kioskToken, testMode, physicalBoardId }: Options) {
  const [board, setBoard] = useState<ScoliaBoard | null>(null);
  const [leasePending, setLeasePending] = useState(read("testLeasePending") === "1");
  const [leaseError, setLeaseError] = useState(read("testLeaseError"));
  const [runtimeError, setRuntimeError] = useState("");
  const [busy, setBusy] = useState("");
  const offlineSince = useRef(0);
  const leaseBusy = useRef(false);
  const heartbeatBusy = useRef(false);
  const runtimeBusy = useRef(false);

  const isTest = environment === "test";
  const fallbackActive = yes(board?.fallback_active) || yes(board?.needs_reconciliation);
  const automatic = board?.mode === "live" && board?.effective_scoring_mode === "scolia" && !fallbackActive;
  const available = isAvailable(board);

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
    if (!active || !code || !physicalId || !kioskToken) {
      clearLeaseState();
      return;
    }
    leaseBusy.current = true;
    try {
      await legacyApi<LeaseResponse>("kiosk-scolia-test-lease.php?action=release", {
        method: "POST",
        kioskToken,
        body: { test_kiosk_code: code, physical_kiosk_id: physicalId },
      });
    } catch {
      // A TEST lease has a short server-side expiry; local cleanup must still succeed.
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
      if (leasePending) setLeasePending(false);
      if (leaseError) setLeaseError("");
      write("testLeasePending", null);
      write("testLeaseError", null);
      return;
    }
    if (read("testLeaseActive") === "1" && !activeMatches) await releaseLease();

    const notApplicable = Number(read("testLeaseNotApplicablePhysicalId") || 0);
    if (notApplicable === physicalBoardId) {
      setLeasePending(false);
      write("testLeasePending", null);
      return;
    }
    if (notApplicable && notApplicable !== physicalBoardId) write("testLeaseNotApplicablePhysicalId", null);

    leaseBusy.current = true;
    setLeasePending(true);
    write("testLeasePending", "1");
    try {
      const data = await legacyApi<LeaseResponse>("kiosk-scolia-test-lease.php?action=acquire", {
        method: "POST",
        kioskToken,
        body: { test_kiosk_code: kioskCode, physical_kiosk_id: physicalBoardId },
      });
      if (data.leased) {
        write("testLeaseActive", "1");
        write("testLeasePhysicalId", physicalBoardId);
        write("testLeaseCode", kioskCode);
        write("testLeaseNotApplicablePhysicalId", null);
        write("testLeasePending", null);
        write("testLeaseError", null);
        setLeasePending(false);
        setLeaseError("");
      } else {
        write("testLeaseActive", null);
        write("testLeasePhysicalId", null);
        write("testLeaseCode", null);
        write("testLeaseNotApplicablePhysicalId", physicalBoardId);
        write("testLeasePending", null);
        write("testLeaseError", null);
        setLeasePending(false);
        setLeaseError("");
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Kunne ikke koble TEST til Scolia.";
      write("testLeasePending", "1");
      write("testLeaseError", message);
      setLeasePending(true);
      setLeaseError(message);
    } finally {
      leaseBusy.current = false;
    }
  }, [isTest, testMode, physicalBoardId, kioskCode, kioskToken, releaseLease, clearLeaseState, leasePending, leaseError]);

  const heartbeatLease = useCallback(async () => {
    if (!isTest || heartbeatBusy.current || read("testLeaseActive") !== "1") return;
    const code = read("testLeaseCode");
    const physicalId = Number(read("testLeasePhysicalId") || 0);
    if (!testMode || code !== kioskCode || physicalId !== physicalBoardId) {
      await releaseLease();
      return;
    }
    heartbeatBusy.current = true;
    try {
      await legacyApi<LeaseResponse>("kiosk-scolia-test-lease.php?action=heartbeat", {
        method: "POST",
        kioskToken,
        body: { test_kiosk_code: code, physical_kiosk_id: physicalId },
      });
      write("testLeaseError", null);
      setLeaseError("");
    } catch (cause) {
      write("testLeaseActive", null);
      write("testLeasePending", "1");
      const message = cause instanceof Error ? cause.message : "Scolia-testleasen mistet forbindelsen.";
      write("testLeaseError", message);
      setLeasePending(true);
      setLeaseError(message);
      await ensureLease();
    } finally {
      heartbeatBusy.current = false;
    }
  }, [isTest, testMode, kioskCode, physicalBoardId, kioskToken, releaseLease, ensureLease]);

  const runtimeAction = useCallback(async (action: "fallback" | "resume" | "reset-phase", body?: unknown) => {
    if (!kioskCode || !kioskToken || runtimeBusy.current) return;
    runtimeBusy.current = true;
    setBusy(action);
    setRuntimeError("");
    try {
      const data = await api<RuntimeResponse>(`/kiosks/${encodeURIComponent(kioskCode)}/scolia/${action}`, {
        method: "POST",
        kioskToken,
        body,
      });
      if (data.board) setBoard(data.board);
      else {
        const refreshed = await api<RuntimeResponse>(`/kiosks/${encodeURIComponent(kioskCode)}/scolia/status`, { kioskToken });
        setBoard(refreshed.board || null);
      }
      offlineSince.current = 0;
    } catch (cause) {
      setRuntimeError(cause instanceof Error ? cause.message : "Scolia-handlingen feilet.");
    } finally {
      runtimeBusy.current = false;
      setBusy("");
    }
  }, [kioskCode, kioskToken]);

  const loadStatus = useCallback(async () => {
    if (!kioskCode || !kioskToken || leasePending) {
      if (!kioskCode) setBoard(null);
      return;
    }
    try {
      const data = await api<RuntimeResponse>(`/kiosks/${encodeURIComponent(kioskCode)}/scolia/status`, { kioskToken });
      const next = data.board || null;
      setBoard(next);
      setRuntimeError("");

      const inFallback = yes(next?.fallback_active) || yes(next?.needs_reconciliation);
      const disconnected = next?.connection_state === "disconnected" || next?.connection_state === "error" || String(next?.board_status || "").toLowerCase() === "offline";
      const shouldFallback = next?.mode === "live" && next?.effective_scoring_mode === "scolia" && !inFallback && yes(next?.auto_fallback_to_manual ?? 1) && disconnected;
      if (!shouldFallback) {
        offlineSince.current = 0;
      } else if (!offlineSince.current) {
        offlineSince.current = Date.now();
      } else if (Date.now() - offlineSince.current >= OFFLINE_FALLBACK_GRACE_MS && !runtimeBusy.current) {
        await runtimeAction("fallback");
      }
    } catch (cause) {
      if (cause instanceof ApiError && [404, 409].includes(cause.status)) {
        setBoard(null);
        return;
      }
      setRuntimeError(cause instanceof Error ? cause.message : "Scolia-status kunne ikke leses.");
    }
  }, [kioskCode, kioskToken, leasePending, runtimeAction]);

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
    void loadStatus();
    const timer = window.setInterval(() => void loadStatus(), STATUS_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadStatus]);

  const fallbackRemainingSeconds = useMemo(() => {
    if (!offlineSince.current || fallbackActive || available) return 0;
    return Math.max(0, Math.ceil((OFFLINE_FALLBACK_GRACE_MS - (Date.now() - offlineSince.current)) / 1000));
  }, [board, fallbackActive, available]);

  return {
    board,
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
    releaseLease,
    refresh: loadStatus,
  };
}
