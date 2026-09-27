import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, legacyApi } from "../shared/api";
import { clearKioskRuntime, ensureKioskToken, read, write } from "../shared/storage";
import type { Health, KioskMatch, KioskSnapshot, PlayerScore, TestBoard, Visit } from "../shared/types";
import { useScoliaRuntime, type ScoliaDart, type ScoliaLastVisit, type ScoliaRuntimeBoard } from "./useScoliaRuntime";
import { useScoliaRealtimeInput, type ScoliaRealtimeMessage } from "./useScoliaRealtimeInput";

type PairingCreateResponse = { request: { request_code: string; expires_at?: string | null } };
type PairingStatusResponse = { status: string; kiosk?: { code?: string; name?: string }; snapshot?: KioskSnapshot | null };
type TestChooserResponse = { items: TestBoard[] };
type TestActivationResponse = { kiosk: { code: string; name?: string; board_number?: number }; source_board?: { id?: number }; physical_board?: { id?: number } };
type InputMode = "sum" | "per_dart";
type InputModeMap = Record<string, InputMode>;
type Multiplier = "S" | "D" | "T";
type ManualDart = { multiplier: Multiplier; value: number | "BULL" };
type RemainingPreview = { remaining: number; state: "live" | "bust" | "checkout" };
type EditableVisit = Visit & { id?: number; player_id?: number; darts_used?: number };
type PendingManualVisit = {
  requestId: string;
  clientTimestampMs: number;
  sequence: number;
  endpoint: "manual" | "scolia";
  body: Record<string, unknown>;
  optimisticMode: InputMode;
  optimisticScore: number;
  optimisticDarts: ManualDart[];
};
type ScoliaRealtimeTurn = {
  matchId: number;
  playerId: number;
  playerName: string;
  startedRemaining: number;
  darts: ManualDart[];
  sourceTokens: string[];
  bridgeSequences: number[];
};
type CompletedMatchSummary = {
  id?: number | string;
  tournament_name?: string;
  round_label?: string | null;
  bracket_label?: string | null;
  player_a_name?: string;
  player_b_name?: string;
  winner_name?: string;
  legs_a?: number;
  legs_b?: number;
};
type MatchReservation = {
  match_id?: number | string;
  player_a_name?: string;
  player_b_name?: string;
  round_label?: string | null;
  bracket_label?: string | null;
  remaining_seconds?: number;
};
type PostMatchResponse = {
  active_match?: boolean;
  last_completed_match?: CompletedMatchSummary | null;
  reservation?: MatchReservation | null;
  remaining_seconds?: number;
  result_display_seconds?: number;
};
type NextMatchResponse = {
  assignment?: { assigned?: boolean; reason?: string | null; reservation?: MatchReservation | null };
  state: KioskSnapshot;
};
type CompletionState = {
  matchId: number;
  localMatch: KioskMatch;
  serverMatch: CompletedMatchSummary | null;
  reservation: MatchReservation | null;
  remainingSeconds: number;
  confirmed: boolean;
};

function text(error: unknown): string { return error instanceof Error ? error.message : "Ukjent feil"; }
function matchIsAssigned(match: KioskMatch | null | undefined): boolean { return Boolean(match && ["assigned", "ready", "pending"].includes(String(match.status || "").toLowerCase())); }
function currentPlayer(match: KioskMatch | null | undefined): PlayerScore | null {
  if (!match) return null;
  return Number(match.current_player_id) === Number(match.player_a.id) ? match.player_a : match.player_b;
}
function pairingAdminUrl(code: string): string {
  const url = new URL("/v2/equipment/", window.location.origin);
  url.searchParams.set("pairing", code);
  return url.toString();
}
function qrUrl(code: string): string { return `https://quickchart.io/qr?size=360&margin=2&text=${encodeURIComponent(pairingAdminUrl(code))}`; }

function possibleVisitScores(): Set<number> {
  const singles = new Set<number>([0, 25, 50]);
  for (let i = 1; i <= 20; i += 1) { singles.add(i); singles.add(i * 2); singles.add(i * 3); }
  const values = [...singles];
  const totals = new Set<number>();
  for (const a of values) for (const b of values) for (const c of values) totals.add(a + b + c);
  return totals;
}
const POSSIBLE_VISIT_SCORES = possibleVisitScores();
function isCheckoutNumber(value: number): boolean { return value > 1 && value <= 170 && ![159, 162, 163, 165, 166, 168, 169].includes(value); }
function manualDartScore(dart: ManualDart): number {
  if (dart.value === "BULL") return dart.multiplier === "D" ? 50 : 25;
  if (dart.value === 0) return 0;
  return dart.value * (dart.multiplier === "T" ? 3 : dart.multiplier === "D" ? 2 : 1);
}
function manualDartLabel(dart?: ManualDart | null): string {
  if (!dart) return "—";
  if (dart.value === 0) return "MISS";
  if (dart.value === "BULL") return dart.multiplier === "D" ? "BULL" : "25";
  return `${dart.multiplier === "S" ? "" : dart.multiplier}${dart.value}`;
}
function isDoubleOut(darts: ManualDart[]): boolean {
  const last = [...darts].reverse().find((dart) => dart.value !== 0);
  return Boolean(last && last.multiplier === "D");
}

function boolValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function mapRealtimeScoliaDart(payload: Record<string, unknown>): ManualDart | null {
  const sector = String(payload.sector ?? "").trim();
  if (boolValue(payload.bounceout) || sector === "" || sector.toLowerCase() === "none") {
    return { multiplier: "S", value: 0 };
  }
  if (sector === "25") return { multiplier: "S", value: "BULL" };
  if (sector.toLowerCase() === "bull") return { multiplier: "D", value: "BULL" };
  const match = /^([sSdDtT])(\d{1,2})$/.exec(sector);
  if (!match) return null;
  const value = Number(match[2]);
  if (!Number.isInteger(value) || value < 1 || value > 20) return null;
  return { multiplier: match[1]!.toUpperCase() as Multiplier, value };
}

function optimisticManualSnapshot(
  snapshotValue: KioskSnapshot,
  inputMode: InputMode,
  visitScore: number,
  darts: ManualDart[],
): KioskSnapshot {
  const match = snapshotValue.match;
  const throwing = currentPlayer(match);
  if (!match || !throwing) return snapshotValue;

  const preview = manualRemainingPreview(
    throwing,
    inputMode,
    inputMode === "sum" ? String(visitScore) : "",
    darts,
  );
  if (!preview) return snapshotValue;

  const playerA = { ...match.player_a };
  const playerB = { ...match.player_b };
  const active = Number(throwing.id) === Number(playerA.id) ? playerA : playerB;
  const other = Number(active.id) === Number(playerA.id) ? playerB : playerA;
  const bust = preview.state === "bust";
  const checkout = preview.state === "checkout";

  active.remaining = preview.remaining;

  let status = match.status;
  let currentLeg = Number(match.current_leg || 1);
  let currentPlayerId = other.id;

  if (checkout) {
    active.legs_won = Number(active.legs_won || 0) + 1;
    const legsToWin = Math.floor(Number(match.best_of_legs || 1) / 2) + 1;
    if (active.legs_won >= legsToWin) {
      status = "completed";
      currentPlayerId = active.id;
    } else {
      currentLeg += 1;
      playerA.remaining = 501;
      playerB.remaining = 501;
      currentPlayerId = currentLeg % 2 === 1 ? playerA.id : playerB.id;
    }
  }

  const recent = ((match.recent_visits || []) as EditableVisit[]);
  const visitNumber = recent
    .filter((visit) => String(visit.player_name || "") === String(throwing.display_name || ""))
    .reduce((max, visit) => Math.max(max, Number(visit.visit_number || 0)), 0) + 1;
  const optimisticVisit: EditableVisit = {
    player_name: throwing.display_name,
    visit_number: visitNumber,
    score: visitScore,
    remaining_after: preview.remaining,
    is_bust: bust ? 1 : 0,
  };

  return {
    ...snapshotValue,
    match: {
      ...match,
      status,
      current_leg: currentLeg,
      current_player_id: currentPlayerId,
      player_a: playerA,
      player_b: playerB,
      recent_visits: [optimisticVisit, ...recent].slice(0, 4),
    },
  };
}

function readPlayerInputModes(): InputModeMap {
  const raw = read("kioskPlayerInputModes");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const modes: InputModeMap = {};
    for (const [playerId, mode] of Object.entries(parsed)) {
      if ((mode === "sum" || mode === "per_dart") && /^\d+$/.test(playerId)) modes[playerId] = mode;
    }
    return modes;
  } catch {
    return {};
  }
}
function manualRemainingPreview(player: PlayerScore | null, inputMode: InputMode, score: string, darts: ManualDart[]): RemainingPreview | null {
  if (!player) return null;
  const hasInput = inputMode === "sum" ? score !== "" : darts.length > 0;
  if (!hasInput) return null;
  const visitScore = inputMode === "sum"
    ? Number(score)
    : darts.reduce((sum, dart) => sum + manualDartScore(dart), 0);
  if (!Number.isFinite(visitScore) || visitScore < 0) return null;

  const candidate = Number(player.remaining) - visitScore;
  if (candidate < 0 || candidate === 1) return { remaining: Number(player.remaining), state: "bust" };
  if (candidate === 0) {
    if (inputMode === "per_dart" && !isDoubleOut(darts)) return { remaining: Number(player.remaining), state: "bust" };
    return { remaining: 0, state: "checkout" };
  }
  return { remaining: candidate, state: "live" };
}

export function KioskWorkspace() {
  const [health, setHealth] = useState<Health | null>(null);
  const [kioskToken, setKioskToken] = useState(() => ensureKioskToken());
  const [kioskCode, setKioskCode] = useState(() => read("kioskCode"));
  const [pairingCode, setPairingCode] = useState(() => read("pairingRequest"));
  const [pairingExpires, setPairingExpires] = useState(() => read("pairingExpires"));
  const [snapshot, setSnapshot] = useState<KioskSnapshot | null>(null);
  const [testMode, setTestMode] = useState(() => read("testMode") === "1");
  const [testBoards, setTestBoards] = useState<TestBoard[]>([]);
  const [busy, setBusy] = useState(false);
  const [manualQueueDepth, setManualQueueDepth] = useState(0);
  const [manualQueueError, setManualQueueError] = useState("");
  const [error, setError] = useState("");
  const [score, setScore] = useState("");
  const [playerInputModes, setPlayerInputModes] = useState<InputModeMap>(readPlayerInputModes);
  const [darts, setDarts] = useState<ManualDart[]>([]);
  const [multiplier, setMultiplier] = useState<Multiplier>("S");
  const [checkoutScore, setCheckoutScore] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [completion, setCompletion] = useState<CompletionState | null>(null);
  const [visitEditIndex, setVisitEditIndex] = useState<number | null>(null);
  const [visitEditId, setVisitEditId] = useState<number | null>(null);
  const [visitEditValue, setVisitEditValue] = useState("");
  const [visitEditError, setVisitEditError] = useState("");
  const [scoliaTurnActive, setScoliaTurnActive] = useState(false);
  const [scoliaRealtimeDarts, setScoliaRealtimeDarts] = useState<ManualDart[]>([]);
  const [scoliaRealtimeLastVisit, setScoliaRealtimeLastVisit] = useState<ScoliaLastVisit | null>(null);
  const mounted = useRef(true);
  const snapshotRef = useRef<KioskSnapshot | null>(null);
  const scoliaTurnRef = useRef<ScoliaRealtimeTurn | null>(null);
  const scoliaLastSequenceRef = useRef(0);
  const manualQueueRef = useRef<PendingManualVisit[]>([]);
  const manualQueueRunning = useRef(false);
  const manualQueuePaused = useRef(false);
  const manualQueueSequence = useRef(0);
  const skipNextThrowingReset = useRef(false);
  const lastActiveMatchRef = useRef<KioskMatch | null>(null);
  const postMatchBusy = useRef(false);
  const nextMatchBusy = useRef(false);

  const kiosk = snapshot?.kiosk || null;
  const match = snapshot?.match || null;
  const throwing = currentPlayer(match);
  const throwingPlayerId = throwing?.id ?? null;
  const inputMode: InputMode = throwingPlayerId !== null ? (playerInputModes[String(throwingPlayerId)] || "sum") : "sum";
  const isTestEnvironment = health?.environment === "test";
  const effectiveTestMode = Boolean(isTestEnvironment && testMode);
  const physicalBoardId = Number(read("testPhysicalBoardId") || 0);
  const testBoardLabel = read("testBoardLabel");
  const scoliaConfigured = String(kiosk?.scoring_mode || "manual").toLowerCase() === "scolia";

  const scolia = useScoliaRuntime({ environment: health?.environment, kioskCode, kioskToken, testMode: effectiveTestMode, physicalBoardId, enabled: scoliaConfigured });
  const effectiveScoringMode = !scoliaConfigured ? "manual" : scolia.leasePending ? "scolia-pending" : scolia.leaseFallback ? "manual" : (scolia.effectiveScoringMode || "scolia");

  const handleScoliaRealtimeInput = useCallback((input: ScoliaRealtimeMessage) => {
    if (!scoliaConfigured) return;
    const message = input.message;
    if (!message || typeof message !== "object") return;
    const type = String(message.type || "").toUpperCase();
    const rawSequence = input.bridge_sequence ?? message.bridgeSequence ?? 0;
    const bridgeSequence = Number(rawSequence || 0);
    if (Number.isFinite(bridgeSequence) && bridgeSequence > 0) {
      if (bridgeSequence <= scoliaLastSequenceRef.current) return;
      scoliaLastSequenceRef.current = bridgeSequence;
    }
    const payload = message.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
      ? message.payload
      : {};

    if (type === "THROW_DETECTED") {
      const current = snapshotRef.current;
      const activeMatch = current?.match;
      const player = currentPlayer(activeMatch);
      if (!activeMatch?.id || String(activeMatch.status || "") !== "in_progress" || !player) return;
      const dart = mapRealtimeScoliaDart(payload);
      if (!dart) return;

      let turn = scoliaTurnRef.current;
      if (!turn || turn.matchId !== Number(activeMatch.id) || turn.playerId !== Number(player.id)) {
        turn = {
          matchId: Number(activeMatch.id),
          playerId: Number(player.id),
          playerName: player.display_name,
          startedRemaining: Number(player.remaining),
          darts: [],
          sourceTokens: [],
          bridgeSequences: [],
        };
      }
      if (turn.darts.length >= 3) return;

      const sourceToken = bridgeSequence > 0
        ? `seq:${bridgeSequence}`
        : String(message.id || "").trim() ? `id:${String(message.id).trim()}` : "";
      const nextTurn: ScoliaRealtimeTurn = {
        ...turn,
        darts: [...turn.darts, dart],
        sourceTokens: sourceToken ? [...turn.sourceTokens, sourceToken] : [...turn.sourceTokens],
        bridgeSequences: bridgeSequence > 0 ? [...turn.bridgeSequences, bridgeSequence] : [...turn.bridgeSequences],
      };
      scoliaTurnRef.current = nextTurn;
      setScoliaTurnActive(true);
      setScoliaRealtimeDarts(nextTurn.darts);
      return;
    }

    if (type !== "TAKEOUT_FINISHED" || boolValue(payload.falseTakeout ?? payload.false_takeout ?? false)) return;

    const turn = scoliaTurnRef.current;
    scoliaTurnRef.current = null;
    setScoliaTurnActive(false);
    setScoliaRealtimeDarts([]);
    if (!turn || turn.darts.length === 0) return;

    const current = snapshotRef.current;
    const activeMatch = current?.match;
    const player = currentPlayer(activeMatch);
    if (!current || !activeMatch?.id || Number(activeMatch.id) !== turn.matchId || !player || Number(player.id) !== turn.playerId) {
      setManualQueueError("Scolia-kastet må avstemmes. Oppdater status før dere fortsetter.");
      return;
    }

    const total = turn.darts.reduce((sum, dart) => sum + manualDartScore(dart), 0);
    const optimistic = optimisticManualSnapshot(current, "per_dart", total, turn.darts);
    snapshotRef.current = optimistic;
    skipNextThrowingReset.current = true;
    setSnapshot(optimistic);

    const recent = ((optimistic.match?.recent_visits || []) as EditableVisit[])[0];
    setScoliaRealtimeLastVisit({
      player_name: turn.playerName,
      score: total,
      darts: turn.darts,
      darts_used: turn.darts.length,
      is_bust: Number(recent?.is_bust || 0) === 1,
      remaining_after: recent?.remaining_after ?? undefined,
    });

    if (optimistic.match?.status === "completed" && optimistic.match.id) {
      setCompletion({
        matchId: Number(optimistic.match.id),
        localMatch: optimistic.match,
        serverMatch: null,
        reservation: null,
        remainingSeconds: 30,
        confirmed: false,
      });
    }

    enqueueScoliaRealtimeVisit(turn);
  }, [scoliaConfigured]);

  useScoliaRealtimeInput({
    enabled: scoliaConfigured && !scolia.leaseFallback && !scolia.fallbackActive,
    kioskCode,
    onInput: handleScoliaRealtimeInput,
  });

  function resetInput(): void {
    setScore("");
    setDarts([]);
    setMultiplier("S");
    setCheckoutScore(null);
  }

  function recentEditableVisits(snapshotValue: KioskSnapshot | null = snapshot): EditableVisit[] {
    return ((snapshotValue?.match?.recent_visits || []) as EditableVisit[]).slice(0, 4);
  }

  const loadState = useCallback(async (code = kioskCode, token = kioskToken) => {
    if (!code) return;
    try {
      const data = await api<KioskSnapshot>(`/kiosks/${encodeURIComponent(code)}/state`, { kioskToken: token });
      if (mounted.current) {
        const previous = lastActiveMatchRef.current;
        if (!data.match && previous?.id && String(previous.status || "") === "in_progress" && !completion) {
          setCompletion({
            matchId: Number(previous.id),
            localMatch: previous,
            serverMatch: null,
            reservation: null,
            remainingSeconds: 30,
            confirmed: false,
          });
        }
        if (data.match && ["assigned", "ready", "pending", "in_progress"].includes(String(data.match.status || ""))) {
          lastActiveMatchRef.current = data.match;
        }
        setSnapshot(data);
        setError("");
      }
    } catch (cause) {
      if (cause instanceof ApiError && [401, 403, 404, 409].includes(cause.status)) {
        if (mounted.current) {
          setSnapshot(null);
          setKioskCode("");
          write("kioskCode", null);
          if (effectiveTestMode) { write("testPhysicalBoardId", null); write("testBoardLabel", null); }
        }
        return;
      }
      if (mounted.current) setError(text(cause));
    }
  }, [kioskCode, kioskToken, effectiveTestMode, completion]);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    scoliaTurnRef.current = null;
    scoliaLastSequenceRef.current = 0;
    setScoliaTurnActive(false);
    setScoliaRealtimeDarts([]);
    setScoliaRealtimeLastVisit(null);
  }, [kioskCode, match?.id]);

  const loadTestBoards = useCallback(async () => {
    try {
      const data = await legacyApi<TestChooserResponse>("kiosk-test-mode.php");
      if (mounted.current) { setTestBoards(Array.isArray(data.items) ? data.items : []); setError(""); }
    } catch (cause) { if (mounted.current) setError(text(cause)); }
  }, []);

  const createPairing = useCallback(async (force = false) => {
    if (effectiveTestMode || kioskCode) return;
    let token = kioskToken;
    if (force) {
      write("kioskToken", null);
      token = ensureKioskToken();
      setKioskToken(token);
      setPairingCode("");
      setPairingExpires("");
      write("pairingRequest", null);
      write("pairingExpires", null);
    }
    if (pairingCode && !force) return;
    try {
      const data = await legacyApi<PairingCreateResponse>("kiosk-pairing.php?action=create", {
        method: "POST",
        kioskToken: token,
        body: { device_name: `Kiosk v2 · ${navigator.platform || "nettbrett"}` },
      });
      const code = data.request.request_code;
      const expires = data.request.expires_at || "";
      if (!mounted.current) return;
      setPairingCode(code);
      setPairingExpires(expires);
      write("pairingRequest", code);
      write("pairingExpires", expires);
      setError("");
    } catch (cause) { if (mounted.current) setError(text(cause)); }
  }, [effectiveTestMode, kioskCode, kioskToken, pairingCode]);

  const checkPairing = useCallback(async () => {
    if (!pairingCode || effectiveTestMode || kioskCode) return;
    try {
      const data = await api<PairingStatusResponse>(`/kiosk-pairing-requests/${encodeURIComponent(pairingCode)}`, { kioskToken });
      if (data.status === "approved" && data.kiosk?.code) {
        const code = data.kiosk.code;
        write("kioskCode", code);
        write("pairingRequest", null);
        write("pairingExpires", null);
        if (!mounted.current) return;
        setKioskCode(code);
        setPairingCode("");
        setPairingExpires("");
        setSnapshot(data.snapshot || null);
        await loadState(code, kioskToken);
      }
    } catch (cause) {
      if (cause instanceof ApiError && [404, 409, 410].includes(cause.status)) {
        setPairingCode("");
        write("pairingRequest", null);
        write("pairingExpires", null);
        await createPairing(true);
        return;
      }
      if (mounted.current) setError(text(cause));
    }
  }, [pairingCode, effectiveTestMode, kioskCode, kioskToken, loadState, createPairing]);

  useEffect(() => {
    mounted.current = true;
    void api<Health>("/health").then((data) => {
      if (!mounted.current) return;
      setHealth(data);
      if (data.environment === "test" && testMode && !kioskCode) void loadTestBoards();
      else if (kioskCode) void loadState(kioskCode, kioskToken);
      else void createPairing();
    }).catch((cause) => setError(text(cause)));
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const handle = window.setInterval(() => {
      if (busy || manualQueueDepth > 0 || scoliaTurnActive || score !== "" || darts.length > 0 || checkoutScore !== null) return;
      if (kioskCode) void loadState();
      else if (effectiveTestMode) { if (!testBoards.length) void loadTestBoards(); }
      else if (pairingCode) void checkPairing();
      else void createPairing();
    }, 1500);
    return () => window.clearInterval(handle);
  }, [busy, manualQueueDepth, scoliaTurnActive, score, darts.length, checkoutScore, kioskCode, effectiveTestMode, pairingCode, testBoards.length, loadState, loadTestBoards, checkPairing, createPairing]);

  useEffect(() => {
    if (skipNextThrowingReset.current) {
      skipNextThrowingReset.current = false;
      return;
    }
    resetInput();
  }, [throwingPlayerId]);

  useEffect(() => {
    if (match && ["assigned", "ready", "pending", "in_progress"].includes(String(match.status || ""))) {
      lastActiveMatchRef.current = match;
    }
  }, [match?.id, match?.status, match?.current_leg, match?.current_player_id, match?.player_a?.legs_won, match?.player_b?.legs_won]);

  useEffect(() => {
    if (!completion || manualQueueDepth > 0 || manualQueueError) return;
    void refreshPostMatchState();
  }, [completion?.matchId, manualQueueDepth, manualQueueError, kioskCode]);

  useEffect(() => {
    if (!completion || completion.remainingSeconds <= 0) return;
    const handle = window.setInterval(() => {
      setCompletion((current) => {
        if (!current) return current;
        const next = Math.max(0, current.remainingSeconds - 1);
        if (next === 0) window.setTimeout(() => void finishCompletion(), 0);
        return { ...current, remainingSeconds: next };
      });
    }, 1000);
    return () => window.clearInterval(handle);
  }, [completion?.matchId]);

  useEffect(() => {
    if (!kioskCode || completion || match || busy || manualQueueDepth > 0 || manualQueueError) return;
    const attempt = () => void claimNextMatch({ quiet: true });
    attempt();
    const handle = window.setInterval(attempt, 2500);
    return () => window.clearInterval(handle);
  }, [kioskCode, completion?.matchId, match?.id, busy, manualQueueDepth, manualQueueError]);

  async function selectTestBoard(board: TestBoard) {
    setBusy(true);
    setError("");
    resetInput();
    try {
      const data = await legacyApi<TestActivationResponse>("kiosk-test-mode.php", {
        method: "POST",
        kioskToken,
        body: { kiosk_id: Number(board.id), source: board.source || "physical" },
      });
      const code = String(data.kiosk?.code || "");
      if (!code) throw new Error("TEST-runtime mangler kiosk-kode.");
      const label = `${board.club_name} · Skive ${board.board_number}`;
      write("testMode", "1");
      write("kioskCode", code);
      write("testPhysicalBoardId", data.source_board?.id || data.physical_board?.id || board.id);
      write("testBoardLabel", label);
      setTestMode(true);
      setKioskCode(code);
      setPairingCode("");
      write("pairingRequest", null);
      write("pairingExpires", null);
      await loadState(code, kioskToken);
    } catch (cause) { setError(text(cause)); }
    finally { setBusy(false); }
  }

  async function mutate(action: () => Promise<KioskSnapshot>) {
    if (!kioskCode || busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await action();
      setSnapshot(data);
      resetInput();
    } catch (cause) {
      setError(text(cause));
      await loadState().catch(() => undefined);
    } finally { setBusy(false); }
  }

  async function startMatch() {
    await mutate(() => api<KioskSnapshot>(`/kiosks/${encodeURIComponent(kioskCode)}/start-match`, { method: "POST", kioskToken }));
  }

  async function undo() {
    if (manualQueueDepth > 0) return;
    if (scolia.automatic && !scolia.fallbackActive) {
      await scolia.undo();
      await loadState();
      return;
    }
    await mutate(() => api<KioskSnapshot>(`/kiosks/${encodeURIComponent(kioskCode)}/undo`, { method: "POST", kioskToken }));
  }

  async function claimNextMatch({ quiet = true }: { quiet?: boolean } = {}) {
    if (!kioskCode || nextMatchBusy.current || completion || manualQueueDepth > 0 || manualQueueError) return;
    nextMatchBusy.current = true;
    try {
      const data = await api<NextMatchResponse>(`/kiosks/${encodeURIComponent(kioskCode)}/next-match`, {
        method: "POST",
        kioskToken,
      });
      if (data.assignment?.assigned) {
        if (mounted.current) {
          setSnapshot(data.state);
          resetInput();
          setError("");
        }
      } else if (!quiet && data.assignment?.reason && !["no_ready_match", "no_active_tournament", "no_auto_tournament", "reservation_wait"].includes(String(data.assignment.reason))) {
        setError("Kunne ikke hente neste kamp akkurat nå.");
      }
    } catch (cause) {
      if (!quiet && mounted.current) setError(text(cause));
    } finally {
      nextMatchBusy.current = false;
    }
  }

  async function refreshPostMatchState() {
    if (!kioskCode || !completion || postMatchBusy.current || manualQueueDepth > 0 || manualQueueError) return;
    postMatchBusy.current = true;
    try {
      const data = await api<PostMatchResponse>(`/kiosks/${encodeURIComponent(kioskCode)}/post-match`, { kioskToken });
      if (!mounted.current) return;
      const remaining = Math.max(0, Number(data.remaining_seconds ?? data.result_display_seconds ?? 30));
      setCompletion((current) => current ? {
        ...current,
        serverMatch: data.last_completed_match ?? current.serverMatch,
        reservation: data.reservation ?? null,
        remainingSeconds: remaining,
        confirmed: Boolean(data.last_completed_match),
      } : current);
      if (remaining <= 0) {
        await finishCompletion();
      }
    } catch (cause) {
      if (mounted.current) setError(text(cause));
    } finally {
      postMatchBusy.current = false;
    }
  }

  async function finishCompletion() {
    if (!kioskCode || nextMatchBusy.current) return;
    nextMatchBusy.current = true;
    try {
      const data = await api<NextMatchResponse>(`/kiosks/${encodeURIComponent(kioskCode)}/next-match`, {
        method: "POST",
        kioskToken,
      });
      if (!mounted.current) return;
      setCompletion(null);
      setSnapshot(data.state);
      resetInput();
      setError("");
    } catch (cause) {
      if (mounted.current) setError(text(cause));
    } finally {
      nextMatchBusy.current = false;
    }
  }

  async function drainManualVisitQueue() {
    if (!kioskCode || manualQueueRunning.current || manualQueuePaused.current) return;
    manualQueueRunning.current = true;
    try {
      while (manualQueueRef.current.length > 0 && !manualQueuePaused.current) {
        const next = manualQueueRef.current[0];
        if (!next) break;
        try {
          const visitPath = next.endpoint === "scolia"
            ? `/kiosks/${encodeURIComponent(kioskCode)}/scolia/visit`
            : `/kiosks/${encodeURIComponent(kioskCode)}/visit`;
          await api<Record<string, unknown>>(visitPath, {
            method: "POST",
            kioskToken,
            body: next.body,
          });
          manualQueueRef.current = manualQueueRef.current.filter((item) => item.requestId !== next.requestId);
          if (mounted.current) {
            setManualQueueDepth(manualQueueRef.current.length);
            setManualQueueError("");
          }
        } catch (cause) {
          manualQueuePaused.current = true;
          if (mounted.current) {
            setManualQueueError("Kunne ikke bekrefte siste kast. Oppdater status før dere fortsetter.");
          }
        }
      }
    } finally {
      manualQueueRunning.current = false;
    }
  }

  async function refreshManualStatus() {
    if (!kioskCode || busy) return;
    setBusy(true);
    setManualQueueError("");
    manualQueuePaused.current = false;
    try {
      await drainManualVisitQueue();
      if (manualQueueRef.current.length > 0 || manualQueuePaused.current) {
        setManualQueueError("Kunne ikke bekrefte siste kast. Oppdater status og prøv igjen.");
        return;
      }
      const fresh = await api<KioskSnapshot>(`/kiosks/${encodeURIComponent(kioskCode)}/state`, { kioskToken });
      if (mounted.current) {
        setSnapshot(fresh);
        resetInput();
        setError("");
      }
    } catch (cause) {
      if (mounted.current) {
        setManualQueueError(`Kunne ikke hente oppdatert kampstatus: ${text(cause)}`);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  function enqueueManualVisit(
    body: Record<string, unknown>,
    optimisticMode: InputMode,
    optimisticScore: number,
    optimisticDarts: ManualDart[],
  ) {
    if (!kioskCode || !snapshot?.match) return;
    const clientTimestampMs = Date.now();
    const sequence = ++manualQueueSequence.current;
    const requestId = `manual:${clientTimestampMs}:${sequence}:${crypto.randomUUID().slice(0, 8)}`;
    const pending: PendingManualVisit = {
      requestId,
      clientTimestampMs,
      sequence,
      endpoint: "manual",
      body: {
        ...body,
        request_id: requestId,
        client_timestamp_ms: clientTimestampMs,
        client_sequence: sequence,
      },
      optimisticMode,
      optimisticScore,
      optimisticDarts: [...optimisticDarts],
    };

    manualQueueRef.current = [...manualQueueRef.current, pending].sort((a, b) =>
      a.clientTimestampMs === b.clientTimestampMs
        ? a.sequence - b.sequence
        : a.clientTimestampMs - b.clientTimestampMs
    );
    setManualQueueDepth(manualQueueRef.current.length);
    setError("");
    const optimistic = optimisticManualSnapshot(snapshot, optimisticMode, optimisticScore, optimisticDarts);
    skipNextThrowingReset.current = true;
    setSnapshot(optimistic);
    if (optimistic.match?.status === "completed" && optimistic.match.id) {
      setCompletion({
        matchId: Number(optimistic.match.id),
        localMatch: optimistic.match,
        serverMatch: null,
        reservation: null,
        remainingSeconds: 30,
        confirmed: false,
      });
    }
    resetInput();

    if (!manualQueuePaused.current) {
      void drainManualVisitQueue();
    }
  }

  function enqueueScoliaRealtimeVisit(turn: ScoliaRealtimeTurn) {
    if (!kioskCode || turn.darts.length === 0) return;
    if (turn.bridgeSequences.length !== turn.darts.length) {
      setManualQueueError("Scolia-kastet mangler sikker eventrekkefølge. Oppdater status før dere fortsetter.");
      return;
    }

    const firstSequence = turn.bridgeSequences[0] || Date.now();
    const lastSequence = turn.bridgeSequences[turn.bridgeSequences.length - 1] || firstSequence;
    const requestId = `scolia-seq-${turn.bridgeSequences.join("-")}`;
    const pending: PendingManualVisit = {
      requestId,
      clientTimestampMs: firstSequence,
      sequence: lastSequence,
      endpoint: "scolia",
      body: {
        request_id: requestId,
        input_mode: "per_dart",
        darts_used: turn.darts.length,
        darts: turn.darts,
        client_timestamp_ms: firstSequence,
        client_sequence: lastSequence,
      },
      optimisticMode: "per_dart",
      optimisticScore: turn.darts.reduce((sum, dart) => sum + manualDartScore(dart), 0),
      optimisticDarts: [...turn.darts],
    };

    manualQueueRef.current = [...manualQueueRef.current, pending].sort((a, b) =>
      a.clientTimestampMs === b.clientTimestampMs
        ? a.sequence - b.sequence
        : a.clientTimestampMs - b.clientTimestampMs
    );
    setManualQueueDepth(manualQueueRef.current.length);
    if (!manualQueuePaused.current) void drainManualVisitQueue();
  }

  function submitSumVisit(value: number, dartsUsed = 3) {
    enqueueManualVisit(
      { score: value, darts_used: dartsUsed, input_mode: "sum" },
      "sum",
      value,
      [],
    );
  }

  function submitScore() {
    const value = Number(score || 0);
    if (!Number.isInteger(value) || value < 0 || !POSSIBLE_VISIT_SCORES.has(value)) {
      setError("Ugyldig score for tre piler.");
      return;
    }
    const remaining = Number(throwing?.remaining || 0);
    if (remaining - value === 0 && isCheckoutNumber(remaining)) {
      setCheckoutScore(value);
      return;
    }
    void submitSumVisit(value, 3);
  }

  function submitDartVisit() {
    if (!darts.length) {
      setError("Registrer minst én pil.");
      return;
    }
    const total = darts.reduce((sum, dart) => sum + manualDartScore(dart), 0);
    const remaining = Number(throwing?.remaining || 0);
    const checkout = remaining - total === 0 && isDoubleOut(darts);
    const payloadDarts = [...darts];
    while (!checkout && payloadDarts.length < 3) payloadDarts.push({ multiplier: "S", value: 0 });
    enqueueManualVisit(
      { input_mode: "per_dart", darts_used: checkout ? darts.length : 3, darts: payloadDarts },
      "per_dart",
      total,
      darts,
    );
  }

  function setManualMode(mode: InputMode) {
    if (!throwingPlayerId) return;
    setPlayerInputModes((current) => {
      const next = { ...current, [String(throwingPlayerId)]: mode };
      write("kioskPlayerInputModes", JSON.stringify(next));
      return next;
    });
    resetInput();
  }

  function addDart(value: number | "BULL", forcedMultiplier?: Multiplier) {
    if (busy || darts.length >= 3) return;
    const nextMultiplier = forcedMultiplier || multiplier;
    setDarts((current) => [...current, { multiplier: nextMultiplier, value }]);
  }

  function openVisitEditor(index: number) {
    if (busy || manualQueueDepth > 0 || String(kiosk?.scoring_mode || "manual") === "scolia") return;
    const visit = recentEditableVisits()[index];
    if (!visit?.id) return;
    setVisitEditIndex(index);
    setVisitEditId(Number(visit.id));
    setVisitEditValue(String(Number(visit.score || 0)));
    setVisitEditError("");
  }

  function editVisitKey(key: string) {
    if (busy) return;
    setVisitEditError("");
    if (key === "del") {
      setVisitEditValue((current) => current.slice(0, -1));
      return;
    }
    setVisitEditValue((current) => current.length >= 3 ? current : (current === "0" ? key : `${current}${key}`));
  }

  function closeVisitEditor() {
    if (busy) return;
    setVisitEditIndex(null);
    setVisitEditId(null);
    setVisitEditValue("");
    setVisitEditError("");
  }

  async function saveVisitEdit() {
    if (busy || manualQueueDepth > 0 || visitEditIndex === null || visitEditId === null || !kioskCode) return;
    const correctedScore = Number(visitEditValue || 0);
    if (!POSSIBLE_VISIT_SCORES.has(correctedScore)) {
      setVisitEditError("Denne summen kan ikke oppnås med tre piler.");
      return;
    }

    setBusy(true);
    setVisitEditError("Oppdaterer kast …");
    try {
      const fresh = await api<KioskSnapshot>(`/kiosks/${encodeURIComponent(kioskCode)}/state`, { kioskToken });
      const freshVisits = recentEditableVisits(fresh);
      const selected = freshVisits[visitEditIndex];
      if (!selected || Number(selected.id || 0) !== visitEditId) {
        setVisitEditError("Kampen har endret seg. Lukk og åpne kastet på nytt.");
        return;
      }

      const affected = freshVisits.slice(0, visitEditIndex + 1);
      const newerChronological = affected.slice(0, visitEditIndex).reverse();
      let next = fresh;

      for (let index = 0; index <= visitEditIndex; index += 1) {
        next = await api<KioskSnapshot>(`/kiosks/${encodeURIComponent(kioskCode)}/undo`, { method: "POST", kioskToken });
      }

      next = await api<KioskSnapshot>(`/kiosks/${encodeURIComponent(kioskCode)}/visit`, {
        method: "POST",
        kioskToken,
        body: { input_mode: "sum", score: correctedScore, darts_used: Number(selected.darts_used || 3) },
      });

      for (const visit of newerChronological) {
        next = await api<KioskSnapshot>(`/kiosks/${encodeURIComponent(kioskCode)}/visit`, {
          method: "POST",
          kioskToken,
          body: { input_mode: "sum", score: Number(visit.score || 0), darts_used: Number(visit.darts_used || 3) },
        });
      }

      setSnapshot(next);
      resetInput();
      setVisitEditIndex(null);
      setVisitEditId(null);
      setVisitEditValue("");
      setVisitEditError("");
    } catch (cause) {
      setVisitEditError(text(cause));
      await loadState().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function resetTerminal() {
    setBusy(true);
    setError("");
    try {
      await scolia.releaseLease();
      if (kioskCode) await api(`/kiosks/${encodeURIComponent(kioskCode)}/unpair`, { method: "POST", kioskToken }).catch(() => undefined);
      clearKioskRuntime();
      resetInput();
      setKioskCode("");
      setSnapshot(null);
      setPairingCode("");
      setPairingExpires("");
      setSettingsOpen(false);
      if (effectiveTestMode) await loadTestBoards();
      else {
        write("kioskToken", null);
        const token = ensureKioskToken();
        setKioskToken(token);
      }
    } finally { setBusy(false); }
  }

  async function leaveTestMode() {
    setBusy(true);
    setError("");
    try {
      await scolia.releaseLease();
      clearKioskRuntime();
      resetInput();
      write("testMode", null);
      setTestMode(false);
      setKioskCode("");
      setSnapshot(null);
      setTestBoards([]);
      setPairingCode("");
      setSettingsOpen(false);
    } finally { setBusy(false); }
  }

  const view = useMemo(() => {
    if (!health) return "loading";
    if (effectiveTestMode && !kioskCode) return "test-chooser";
    if (!kioskCode) return "pairing";
    if (!snapshot?.kiosk) return "loading";
    if (completion) return "completed";
    if (!match) return "idle";
    if (matchIsAssigned(match)) return "assigned";
    return "match";
  }, [health, effectiveTestMode, kioskCode, snapshot, match, completion]);

  const headerTitle = kiosk?.name || (effectiveTestMode ? "Testterminal" : "Skiveterminal");
  const headerSubtitle = kiosk?.club?.name || (effectiveTestMode ? "Isolert TEST-runtime" : "Blindleia Darts");
  const connectionLabel = kiosk ? `Skive ${kiosk.board_number}` : effectiveTestMode ? "TEST" : "Ikke paret";

  return <div className="kiosk-shell">
    {effectiveTestMode && <div className="test-banner">TESTMODUS · isolert fra PROD{testBoardLabel ? ` · ${testBoardLabel}` : " · velg skive"}</div>}

    <header className="kiosk-topbar">
      <div className="v2-brand">
        <img className="v2-logo" src={kiosk?.club?.logo_url || "/static/club-logos/blindleia-dartklubb-logo.png"} alt="" />
        <div><strong>{headerTitle}</strong><span>{headerSubtitle}</span></div>
      </div>
      <div className="v2-top-actions">
        <span className={`pill ${kiosk ? "good" : effectiveTestMode ? "warn" : ""}`}><span className="dot" />{connectionLabel}</span>
        <button className="kiosk-settings-button" type="button" aria-label="Innstillinger" onClick={() => setSettingsOpen(true)}>⚙</button>
      </div>
    </header>

    <main className="kiosk-main"><section className="kiosk-card">
      {error && <div className="notice bad">{error}</div>}
      {manualQueueError && <div className="notice bad"><span>{manualQueueError}</span><button className="button secondary small" disabled={busy} onClick={() => void refreshManualStatus()}>Oppdater status</button></div>}
      {kioskCode && scoliaConfigured && <ScoliaRuntimePanel snapshotMode={kiosk?.scoring_mode || "manual"} board={scolia.board} leasePending={scolia.leasePending} leaseFallback={scolia.leaseFallback} leaseError={scolia.leaseError} runtimeError={scolia.runtimeError} available={scolia.available} fallbackActive={scolia.fallbackActive} automatic={scolia.automatic} remaining={scolia.fallbackRemainingSeconds} busy={scolia.busy} onRetryLease={scolia.retryLease} onFallback={scolia.fallback} onResume={scolia.resume} onResetPhase={scolia.resetPhase} />}

      {view === "loading" && <div className="kiosk-hero"><span className="pill">Skiveterminal</span><h2>Starter terminalen …</h2><p>Henter skive og kampstatus.</p></div>}
      {view === "test-chooser" && <TestChooser boards={testBoards} busy={busy} onChoose={selectTestBoard} onExit={() => void leaveTestMode()} />}
      {view === "pairing" && <PairingView code={pairingCode} expires={pairingExpires} busy={busy} onNew={() => void createPairing(true)} />}
      {view === "idle" && kiosk && <div className="kiosk-hero"><span className="pill good"><span className="dot" />Klar</span><p>{kiosk.club?.name || "Blindleia Dartklubb"}</p><h1>Skive {kiosk.board_number}</h1>{snapshot?.active_tournament?.name ? <><span className="pill">{snapshot.active_tournament.name}</span><p>Venter på kamp i aktiv turnering</p></> : <><span className="pill">Ingen aktiv turnering</span><p>Skiva er klar, men er ikke med i en aktiv turnering akkurat nå.</p></>}</div>}
      {view === "completed" && completion && kiosk && <CompletionView completion={completion} board={kiosk.board_number} busy={busy || nextMatchBusy.current} onNext={() => void finishCompletion()} />}
      {view === "assigned" && match && kiosk && <AssignedView match={match} board={kiosk.board_number} busy={busy} onStart={() => void startMatch()} />}
      {view === "match" && match && kiosk && <MatchView match={match} board={kiosk.board_number} scoringMode={effectiveScoringMode} scoliaBoard={scoliaRealtimeDarts.length > 0 ? { ...(scolia.board || {}), buffer: { ...(scolia.board?.buffer || {}), darts: scoliaRealtimeDarts } } as ScoliaRuntimeBoard : scolia.board} lastScoliaVisit={scoliaRealtimeLastVisit || scolia.lastVisit} inputMode={inputMode} multiplier={multiplier} darts={darts} score={score} busy={busy || Boolean(scolia.busy) || Boolean(manualQueueError)} manualQueueDepth={manualQueueDepth} onMode={setManualMode} onMultiplier={setMultiplier} onDart={addDart} onDartBack={() => setDarts((current) => current.slice(0, -1))} onDartSubmit={() => void submitDartVisit()} onScore={setScore} onSubmit={submitScore} onUndo={() => void undo()} onEditVisit={openVisitEditor} visitEditingAllowed={String(kiosk?.scoring_mode || "manual") !== "scolia"} />}
    </section></main>

    {settingsOpen && <SettingsDialog isTest={effectiveTestMode} hasKiosk={Boolean(kioskCode)} busy={busy} manualQueueDepth={manualQueueDepth} manualQueueError={manualQueueError} onRefreshStatus={() => void refreshManualStatus()} onClose={() => setSettingsOpen(false)} onReload={() => window.location.reload()} onReset={() => void resetTerminal()} onExitTest={() => void leaveTestMode()} />}

    {checkoutScore !== null && <div className="login-shell kiosk-dialog-overlay"><div className="login-card kiosk-dialog-card"><span className="pill good">Checkout</span><h1>Hvor mange piler?</h1><p>Registrer hvor mange piler som ble brukt på checkouten.</p><div className="grid three">{[1, 2, 3].map((used) => <button key={used} className="button" disabled={busy} onClick={() => submitSumVisit(checkoutScore, used)}>{used} pil{used > 1 ? "er" : ""}</button>)}</div><button className="button secondary" onClick={() => setCheckoutScore(null)}>Avbryt</button></div></div>}

    {visitEditIndex !== null && (() => {
      const selected = recentEditableVisits().find((visit) => Number(visit.id || 0) === visitEditId);
      if (!selected) return null;
      return <div className="visit-edit-overlay-v2" role="presentation"><section className="visit-edit-dialog-v2" role="dialog" aria-modal="true" aria-label="Rediger kast"><div className="visit-edit-head-v2"><div><span>Rediger kast</span><h2>{selected.player_name || "Spiller"}</h2></div><button type="button" className="kiosk-settings-button" disabled={busy} onClick={closeVisitEditor}>×</button></div><p>Kast #{Number(selected.visit_number || 0)} · {Number(selected.score || 0)} poeng · gjenstod {Number(selected.remaining_after ?? 0)}</p><div className="visit-edit-display-v2">{visitEditValue || "0"}</div><div className="visit-edit-keypad-v2">{["1", "2", "3", "4", "5", "6", "7", "8", "9", "del", "0", "save"].map((key) => <button type="button" key={key} className={key === "save" ? "primary" : ""} disabled={busy} onClick={() => key === "save" ? void saveVisitEdit() : editVisitKey(key)}>{key === "del" ? "⌫" : key === "save" ? "✓" : key}</button>)}</div><p className={visitEditError && visitEditError !== "Oppdaterer kast …" ? "visit-edit-error-v2" : "visit-edit-note-v2"}>{visitEditError || "Kastene etter dette regnes om automatisk."}</p></section></div>;
    })()}
  </div>;
}

function SettingsDialog({ isTest, hasKiosk, busy, manualQueueDepth, manualQueueError, onRefreshStatus, onClose, onReload, onReset, onExitTest }: {
  isTest: boolean;
  hasKiosk: boolean;
  busy: boolean;
  manualQueueDepth: number;
  manualQueueError: string;
  onRefreshStatus: () => void;
  onClose: () => void;
  onReload: () => void;
  onReset: () => void;
  onExitTest: () => void;
}) {
  return <div className="kiosk-dialog-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="kiosk-settings-dialog" role="dialog" aria-modal="true" aria-label="Skiveterminal innstillinger">
      <div className="kiosk-settings-head"><div><span>Skiveterminal</span><h2>Innstillinger</h2></div><button className="kiosk-settings-button" type="button" aria-label="Lukk" onClick={onClose}>×</button></div>
      <div className="kiosk-settings-actions">
        <div className="notice"><strong>Lagringsstatus</strong><span>{manualQueueError ? "Krever avstemming" : manualQueueDepth > 0 ? `${manualQueueDepth} kast venter på bekreftelse` : "Alle kast er bekreftet"}</span>{(manualQueueDepth > 0 || manualQueueError) && <button className="button secondary small" disabled={busy} onClick={onRefreshStatus}>Oppdater status</button>}</div>
        <button className="button secondary" disabled={busy} onClick={onReload}>Last inn terminalen på nytt</button>
        {hasKiosk && <button className="button secondary" disabled={busy} onClick={onReset}>{isTest ? "Bytt testskive" : "Fjern pairing"}</button>}
        {isTest && <button className="button danger" disabled={busy} onClick={onExitTest}>Avslutt testmodus</button>}
      </div>
    </section>
  </div>;
}

function ScoliaRuntimePanel({ snapshotMode, board, leasePending, leaseFallback, leaseError, runtimeError, available, fallbackActive, automatic, remaining, busy, onRetryLease, onFallback, onResume, onResetPhase }: {
  snapshotMode: string;
  board: ScoliaRuntimeBoard | null;
  leasePending: boolean;
  leaseFallback: boolean;
  leaseError: string;
  runtimeError: string;
  available: boolean;
  fallbackActive: boolean;
  automatic: boolean;
  remaining: number;
  busy: string;
  onRetryLease: () => Promise<void>;
  onFallback: () => Promise<void>;
  onResume: () => Promise<void>;
  onResetPhase: () => Promise<void>;
}) {
  const relevant = snapshotMode === "scolia" || leasePending || leaseFallback || board?.mode === "live" || fallbackActive || Boolean(board?.serial_number);
  if (!relevant) return null;
  if (leasePending) return <div className="scolia-kiosk-strip warn"><div><strong>TEST kobler til fysisk Scolia …</strong><span>{leaseError || "Oppretter midlertidig lease. Manuell scoring er sperret mens tilkoblingen etableres."}</span></div><span className="pill warn">TEST · Scolia</span></div>;
  if (leaseFallback) return <div className="scolia-kiosk-strip warn"><div><strong>Scolia kunne ikke kobles til · manuell scoring aktiv</strong><span>{leaseError || "TEST-leasen kunne ikke etableres. Kampen kan fortsette manuelt."}</span></div><button className="button secondary small" disabled={Boolean(busy)} onClick={() => void onRetryLease()}>Prøv Scolia igjen</button></div>;
  if (fallbackActive) return <div className="scolia-kiosk-strip warn"><div><strong>{available ? "Scolia er tilbake – score må avstemmes" : "Scolia offline · manuell fallback"}</strong><span>{available ? "Fortsett manuelt til scoren er kontrollert." : "Kampen kan fortsette manuelt mens kiosken følger forbindelsen."}</span>{runtimeError && <span className="error-copy">{runtimeError}</span>}</div><div className="row-actions">{available && <button className="button small" disabled={Boolean(busy)} onClick={() => void onResume()}>Score avstemt · bruk Scolia</button>}<button className="button secondary small" disabled={Boolean(busy)} onClick={() => void onResetPhase()}>Reset fase</button></div></div>;
  if (automatic && !available) return <div className="scolia-kiosk-strip warn"><div><strong>Scolia-forbindelsen er brutt</strong><span>Prøver igjen. Manuell fallback {remaining > 0 ? `om ca. ${remaining} sek` : "aktiveres nå"}.</span>{runtimeError && <span className="error-copy">{runtimeError}</span>}</div><button className="button secondary small" disabled={Boolean(busy)} onClick={() => void onFallback()}>Bruk manuell nå</button></div>;
  if (automatic && available) return <div className="scolia-kiosk-strip good"><div><strong>Scolia tilkoblet · automatisk scoring</strong><span>{board?.physical_board_status || board?.board_status || "Online"}{board?.board_phase ? ` · ${board.board_phase}` : ""}</span></div><div className="row-actions"><span className="pill good"><span className="dot" />Live</span><button className="button secondary small" disabled={Boolean(busy)} onClick={() => void onResetPhase()}>Reset fase</button></div></div>;
  return <div className="scolia-kiosk-strip"><div><strong>Scolia er ikke aktiv</strong><span>{runtimeError || "Kiosken bruker manuell scoring."}</span></div><span className="pill">Manuell</span></div>;
}

function TestChooser({ boards, busy, onChoose, onExit }: { boards: TestBoard[]; busy: boolean; onChoose: (board: TestBoard) => Promise<void>; onExit: () => void }) {
  return <div className="kiosk-hero test-chooser"><span className="pill warn">TEST</span><h2>Velg skiva du vil teste</h2><p>Ingen pairing. Velg den fysiske skiva du vil simulere; kamp og scoring går kun til TEST.</p><div className="test-board-grid">{boards.map((board) => <button key={`${board.source || "physical"}-${board.id}`} className="test-board" disabled={busy} onClick={() => void onChoose(board)}><strong>Skive {board.board_number}</strong><span>{board.club_name}{board.scoring_mode === "scolia" ? " · Scolia" : " · Manuell"}</span></button>)}</div>{!boards.length && <div className="empty">Laster skiver …</div>}<button className="button secondary test-exit" disabled={busy} onClick={onExit}>Tilbake til PROD</button></div>;
}

function PairingView({ code, expires, busy, onNew }: { code: string; expires: string; busy: boolean; onNew: () => void }) {
  return <div className="kiosk-hero pairing-view"><span className="pill">Førstegangsoppsett</span><h2>Koble nettbrettet til riktig skive</h2>{code ? <><img src={qrUrl(code)} width="230" height="230" alt="QR-kode til Utstyr" /><div className="pair-code">{code}</div><p>Scan QR-koden med adminmobilen, eller skriv koden inne på skiva i Utstyr. Terminalen går videre automatisk.{expires ? ` Koden utløper ${new Date(String(expires).replace(" ", "T")).toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" })}.` : ""}</p></> : <p>Lager pairingkode …</p>}<button className="button secondary" disabled={busy} onClick={onNew}>Lag ny kode</button></div>;
}

function CompletionView({ completion, board, busy, onNext }: {
  completion: CompletionState;
  board: number;
  busy: boolean;
  onNext: () => void;
}) {
  const local = completion.localMatch;
  const server = completion.serverMatch;
  const aName = server?.player_a_name || local.player_a.display_name;
  const bName = server?.player_b_name || local.player_b.display_name;
  const aLegs = Number(server?.legs_a ?? local.player_a.legs_won ?? 0);
  const bLegs = Number(server?.legs_b ?? local.player_b.legs_won ?? 0);
  const winner = server?.winner_name || (aLegs > bLegs ? aName : bName);
  const next = completion.reservation;
  return <div className="assigned-view">
    <div className="match-tools"><span className="pill good">Skive {board} · resultat registrert</span><span className="pill">{server?.round_label || server?.bracket_label || local.round_label || local.bracket_label || "Kamp"}</span></div>
    <div className="kiosk-hero">
      <span className="pill good">KAMP FERDIG</span>
      <h1>{winner} vinner</h1>
      <div className="versus assigned-versus">
        <div className="player-tile"><p>{aName}</p><div className="remaining">{aLegs}</div></div>
        <div className="vs-mark">–</div>
        <div className="player-tile"><p>{bName}</p><div className="remaining">{bLegs}</div></div>
      </div>
      {next ? <div className="notice"><strong>Neste kamp</strong><span>{next.player_a_name || "Spiller"} – {next.player_b_name || "Spiller"} · {next.round_label || next.bracket_label || "Kamp"}</span></div> : <p>Skiva følger kampkøen og klargjør neste kvalifiserte kamp.</p>}
      <p>{completion.confirmed ? `Neste kamp vises om ${completion.remainingSeconds} sek` : "Bekrefter resultatet …"}</p>
      <button className="button start-match-button" disabled={busy || !completion.confirmed} onClick={onNext}>Vis neste kamp nå</button>
    </div>
  </div>;
}

function AssignedView({ match, board, busy, onStart }: { match: KioskMatch; board: number; busy: boolean; onStart: () => void }) {
  return <div className="assigned-view"><div className="match-tools"><span className="pill good">Skive {board} · kamp klar</span><span className="pill">{match.round_label || match.bracket_label || "Kamp"} · best of {match.best_of_legs}</span></div><div className="versus assigned-versus"><div className="player-tile"><p>Spiller 1</p><h2>{match.player_a.display_name}</h2></div><div className="vs-mark">VS</div><div className="player-tile"><p>Spiller 2</p><h2>{match.player_b.display_name}</h2></div></div><button className="button start-match-button" disabled={busy} onClick={onStart}>{busy ? "Starter …" : "Start kamp"}</button></div>;
}

function MatchView({ match, board, scoringMode, scoliaBoard, lastScoliaVisit, inputMode, multiplier, darts, score, busy, manualQueueDepth, onMode, onMultiplier, onDart, onDartBack, onDartSubmit, onScore, onSubmit, onUndo, onEditVisit, visitEditingAllowed }: {
  match: KioskMatch;
  board: number;
  scoringMode: string;
  scoliaBoard: ScoliaRuntimeBoard | null;
  lastScoliaVisit: ScoliaLastVisit | null;
  inputMode: InputMode;
  multiplier: Multiplier;
  darts: ManualDart[];
  score: string;
  busy: boolean;
  manualQueueDepth: number;
  onMode: (mode: InputMode) => void;
  onMultiplier: (value: Multiplier) => void;
  onDart: (value: number | "BULL", forcedMultiplier?: Multiplier) => void;
  onDartBack: () => void;
  onDartSubmit: () => void;
  onScore: (value: string) => void;
  onSubmit: () => void;
  onUndo: () => void;
  onEditVisit: (index: number) => void;
  visitEditingAllowed: boolean;
}) {
  const throwing = currentPlayer(match);
  const automatic = scoringMode === "scolia" || scoringMode === "scolia-pending";
  const preview = automatic ? null : manualRemainingPreview(throwing, inputMode, score, darts);
  const playerAActive = Number(match.current_player_id) === Number(match.player_a.id);
  const playerBActive = Number(match.current_player_id) === Number(match.player_b.id);
  const recentVisits = ((match.recent_visits || []) as EditableVisit[]).slice(0, 4);
  return <div className="match-view"><div className="match-tools"><span className="pill good">Skive {board} · live</span><span className="pill">{match.round_label || match.bracket_label || "Kamp"}</span><button className="button secondary small" disabled={busy || manualQueueDepth > 0} onClick={onUndo}>Angre siste kast</button></div><div className="versus"><PlayerTile player={match.player_a} active={playerAActive} /><div className="vs-mark">Leg {match.current_leg || 1}</div><PlayerTile player={match.player_b} active={playerBActive} /></div>{automatic ? <ScoliaScoreSurface pending={scoringMode === "scolia-pending"} board={scoliaBoard} lastVisit={lastScoliaVisit} throwing={throwing} /> : <ManualScoreSurface inputMode={inputMode} multiplier={multiplier} darts={darts} score={score} preview={preview} busy={busy} onMode={onMode} onMultiplier={onMultiplier} onDart={onDart} onDartBack={onDartBack} onDartSubmit={onDartSubmit} onScore={onScore} onSubmit={onSubmit} />}<div className="visits"><div className="editable-visits-v2" aria-label="Siste fire kast">{recentVisits.length ? recentVisits.map((visit, index) => { const bust = Number(visit.is_bust) === 1; const editable = visitEditingAllowed && Boolean(visit.id); return <button type="button" className="visit visit-editable-v2" key={`${visit.id || visit.visit_number || index}-${index}`} disabled={!editable || busy || manualQueueDepth > 0} onClick={() => onEditVisit(index)} aria-label={editable ? `Rediger kast ${Number(visit.score || 0)} av ${visit.player_name || "spiller"}` : undefined}><span><strong>{visit.player_name || "Spiller"}</strong><small>#{Number(visit.visit_number || 0)}</small></span><span><strong>{Number(visit.score || 0)}</strong><small>{bust ? "Bust" : `→ ${Number(visit.remaining_after ?? 0)}`}</small></span>{editable && <span className="visit-edit-icon-v2" aria-hidden="true">✎</span>}</button>; }) : <div className="empty">Ingen kast registrert ennå.</div>}</div></div></div>;
}

function ManualScoreSurface({ inputMode, multiplier, darts, score, preview, busy, onMode, onMultiplier, onDart, onDartBack, onDartSubmit, onScore, onSubmit }: {
  inputMode: InputMode;
  multiplier: Multiplier;
  darts: ManualDart[];
  score: string;
  preview: RemainingPreview | null;
  busy: boolean;
  onMode: (mode: InputMode) => void;
  onMultiplier: (value: Multiplier) => void;
  onDart: (value: number | "BULL", forcedMultiplier?: Multiplier) => void;
  onDartBack: () => void;
  onDartSubmit: () => void;
  onScore: (value: string) => void;
  onSubmit: () => void;
}) {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "del", "0", "ok"];
  const dartTotal = darts.reduce((sum, dart) => sum + manualDartScore(dart), 0);
  const previewText = preview
    ? preview.state === "bust"
      ? ` · Bust · ${preview.remaining} står`
      : preview.state === "checkout"
        ? " · Checkout"
        : ` · Etter kast ${preview.remaining}`
    : "";
  return <div className={`score-entry ${inputMode === "per_dart" ? "dart-entry-active" : ""}`}>
    <div className="panel-head scoring-head"><div><h3>Registrer kast</h3><p>{inputMode === "sum" ? "Sum for tre piler" : `Per pil · sum ${dartTotal}`}{previewText}</p></div><div className="manual-mode-switch"><button className={inputMode === "sum" ? "active" : ""} disabled={busy} onClick={() => onMode("sum")}>Sum</button><button className={inputMode === "per_dart" ? "active" : ""} disabled={busy} onClick={() => onMode("per_dart")}>Per pil</button></div></div>
    {inputMode === "sum" ? <><div className="score-display">{score || "0"}</div><div className="keypad">{keys.map((key) => <button key={key} className={key === "ok" ? "primary" : ""} disabled={busy} onClick={() => { if (key === "del") onScore(score.slice(0, -1)); else if (key === "ok") onSubmit(); else if (score.length < 3) onScore(score + key); }}>{key === "del" ? "⌫" : key === "ok" ? "Lagre" : key}</button>)}</div></> : <PerDartEntry darts={darts} multiplier={multiplier} total={dartTotal} busy={busy} onMultiplier={onMultiplier} onDart={onDart} onBack={onDartBack} onSubmit={onDartSubmit} />}
  </div>;
}

function PerDartEntry({ darts, multiplier, total, busy, onMultiplier, onDart, onBack, onSubmit }: {
  darts: ManualDart[];
  multiplier: Multiplier;
  total: number;
  busy: boolean;
  onMultiplier: (value: Multiplier) => void;
  onDart: (value: number | "BULL", forcedMultiplier?: Multiplier) => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  return <div className="manual-dart-entry"><div className="dart-summary-v2">{[0, 1, 2].map((index) => <div key={index}><span>Pil {index + 1}</span><strong>{manualDartLabel(darts[index])}</strong></div>)}<div className="dart-total-v2"><span>Sum</span><strong>{total}</strong></div></div><div className="dart-pick-area"><div className="multiplier-column">{(["S", "D", "T"] as Multiplier[]).map((value) => <button key={value} className={multiplier === value ? "active" : ""} disabled={busy} onClick={() => onMultiplier(value)}>{value}</button>)}</div><div className="number-grid-v2">{Array.from({ length: 20 }, (_, index) => index + 1).map((value) => <button key={value} disabled={busy || darts.length >= 3} onClick={() => onDart(value)}>{value}</button>)}<button disabled={busy || darts.length >= 3} onClick={() => onDart("BULL", "S")}>25</button><button disabled={busy || darts.length >= 3} onClick={() => onDart("BULL", "D")}>Bull</button><button disabled={busy || darts.length >= 3} onClick={() => onDart(0, "S")}>Miss</button></div></div><div className="dart-entry-actions"><button className="button secondary" disabled={busy || !darts.length} onClick={onBack}>⌫ Siste pil</button><button className="button" disabled={busy || !darts.length} onClick={onSubmit}>Lagre kast · {total}</button></div></div>;
}

function dartLabel(dart?: ScoliaDart | null): string {
  if (!dart) return "—";
  const multiplier = String(dart.multiplier || dart.m || "S").toUpperCase();
  const raw = dart.value ?? dart.v ?? 0;
  if (String(raw).toUpperCase() === "BULL") return multiplier === "D" ? "BULL" : "25";
  const value = Number(raw || 0);
  if (!Number.isFinite(value) || value <= 0) return "MISS";
  return `${multiplier === "S" ? "" : multiplier}${value}`;
}
function dartScore(dart?: ScoliaDart | null): number {
  if (!dart) return 0;
  const multiplier = String(dart.multiplier || dart.m || "S").toUpperCase();
  const raw = dart.value ?? dart.v ?? 0;
  if (String(raw).toUpperCase() === "BULL") return multiplier === "D" ? 50 : 25;
  const value = Number(raw || 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return multiplier === "T" ? value * 3 : multiplier === "D" ? value * 2 : value;
}
function ScoliaScoreSurface({ pending, board, lastVisit, throwing }: { pending: boolean; board: ScoliaRuntimeBoard | null; lastVisit: ScoliaLastVisit | null; throwing: PlayerScore | null }) {
  if (pending) return <div className="kiosk-hero scolia-wait"><span className="pill warn">Scolia</span><h2>Kobler til skiva …</h2><p>TEST-leasen etableres før automatisk scoring starter.</p></div>;
  const buffer = board?.buffer?.darts || [];
  const showingBuffer = buffer.length > 0;
  const darts = showingBuffer ? buffer : (lastVisit?.darts || []);
  const total = showingBuffer ? darts.reduce((sum, dart) => sum + dartScore(dart), 0) : (lastVisit?.score ?? null);
  const title = showingBuffer ? "Kaster nå" : lastVisit ? "Siste kast" : "Klar for kast";
  const player = showingBuffer ? throwing?.display_name : lastVisit?.player_name;
  return <div className="scolia-score-v2"><div className="scolia-score-head"><div><span className="pill good">Scolia live</span><h3>{title}</h3><p>{showingBuffer ? `${darts.length}/3 piler${player ? ` · ${player}` : ""}` : (player || "Kast når du er klar")}</p></div><div className={`scolia-score-total ${lastVisit?.is_bust && !showingBuffer ? "bust" : ""}`}><span>{lastVisit?.is_bust && !showingBuffer ? "Bust" : "Sum"}</span><strong>{total === null ? "—" : total}</strong></div></div><div className="scolia-darts-v2">{[0, 1, 2].map((index) => <div className={darts[index] ? "has-dart" : ""} key={index}><span>Pil {index + 1}</span><strong>{dartLabel(darts[index])}</strong></div>)}</div></div>;
}

function PlayerTile({ player, active }: { player: PlayerScore; active: boolean }) {
  return <article className={`player-tile ${active ? "active" : ""}`}><p>{active ? "Kaster" : `${player.legs_won} legs`}</p><h2>{player.display_name}</h2><div className="remaining">{player.remaining}</div><p>{player.legs_won} legs</p></article>;
}
