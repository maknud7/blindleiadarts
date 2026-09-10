import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, legacyApi } from "../shared/api";
import { clearKioskRuntime, ensureKioskToken, read, write } from "../shared/storage";
import type { Health, KioskMatch, KioskSnapshot, PlayerScore, TestBoard } from "../shared/types";
import { useScoliaRuntime, type ScoliaDart, type ScoliaLastVisit, type ScoliaRuntimeBoard } from "./useScoliaRuntime";

type PairingCreateResponse = { request: { request_code: string; expires_at?: string | null } };
type PairingStatusResponse = { status: string; kiosk?: { code?: string; name?: string }; snapshot?: KioskSnapshot | null };
type TestChooserResponse = { items: TestBoard[] };
type TestActivationResponse = { kiosk: { code: string; name?: string; board_number?: number }; source_board?: { id?: number }; physical_board?: { id?: number } };
type InputMode = "sum" | "per_dart";
type InputModeMap = Record<string, InputMode>;
type Multiplier = "S" | "D" | "T";
type ManualDart = { multiplier: Multiplier; value: number | "BULL" };
type RemainingPreview = { remaining: number; state: "live" | "bust" | "checkout" };

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
  const [error, setError] = useState("");
  const [score, setScore] = useState("");
  const [playerInputModes, setPlayerInputModes] = useState<InputModeMap>(readPlayerInputModes);
  const [darts, setDarts] = useState<ManualDart[]>([]);
  const [multiplier, setMultiplier] = useState<Multiplier>("S");
  const [checkoutScore, setCheckoutScore] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const mounted = useRef(true);

  const kiosk = snapshot?.kiosk || null;
  const match = snapshot?.match || null;
  const throwing = currentPlayer(match);
  const throwingPlayerId = throwing?.id ?? null;
  const inputMode: InputMode = throwingPlayerId !== null ? (playerInputModes[String(throwingPlayerId)] || "sum") : "sum";
  const isTestEnvironment = health?.environment === "test";
  const effectiveTestMode = Boolean(isTestEnvironment && testMode);
  const physicalBoardId = Number(read("testPhysicalBoardId") || 0);
  const testBoardLabel = read("testBoardLabel");

  const scolia = useScoliaRuntime({ environment: health?.environment, kioskCode, kioskToken, testMode: effectiveTestMode, physicalBoardId });
  const effectiveScoringMode = scolia.leasePending ? "scolia-pending" : (scolia.effectiveScoringMode || kiosk?.scoring_mode || "manual");

  function resetInput(): void {
    setScore("");
    setDarts([]);
    setMultiplier("S");
    setCheckoutScore(null);
  }

  const loadState = useCallback(async (code = kioskCode, token = kioskToken) => {
    if (!code) return;
    try {
      const data = await api<KioskSnapshot>(`/kiosks/${encodeURIComponent(code)}/state`, { kioskToken: token });
      if (mounted.current) { setSnapshot(data); setError(""); }
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
  }, [kioskCode, kioskToken, effectiveTestMode]);

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
      if (busy) return;
      if (kioskCode) void loadState();
      else if (effectiveTestMode) { if (!testBoards.length) void loadTestBoards(); }
      else if (pairingCode) void checkPairing();
      else void createPairing();
    }, 1500);
    return () => window.clearInterval(handle);
  }, [busy, kioskCode, effectiveTestMode, pairingCode, testBoards.length, loadState, loadTestBoards, checkPairing, createPairing]);

  useEffect(() => {
    resetInput();
  }, [throwingPlayerId]);

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
    if (scolia.automatic && !scolia.fallbackActive) {
      await scolia.undo();
      await loadState();
      return;
    }
    await mutate(() => api<KioskSnapshot>(`/kiosks/${encodeURIComponent(kioskCode)}/undo`, { method: "POST", kioskToken }));
  }

  async function submitSumVisit(value: number, dartsUsed = 3) {
    await mutate(() => api<KioskSnapshot>(`/kiosks/${encodeURIComponent(kioskCode)}/visit`, {
      method: "POST",
      kioskToken,
      body: { score: value, darts_used: dartsUsed, input_mode: "sum" },
    }));
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

  async function submitDartVisit() {
    if (!darts.length) {
      setError("Registrer minst én pil.");
      return;
    }
    const total = darts.reduce((sum, dart) => sum + manualDartScore(dart), 0);
    const remaining = Number(throwing?.remaining || 0);
    const checkout = remaining - total === 0 && isDoubleOut(darts);
    const payloadDarts = [...darts];
    while (!checkout && payloadDarts.length < 3) payloadDarts.push({ multiplier: "S", value: 0 });
    await mutate(() => api<KioskSnapshot>(`/kiosks/${encodeURIComponent(kioskCode)}/visit`, {
      method: "POST",
      kioskToken,
      body: { input_mode: "per_dart", darts_used: checkout ? darts.length : 3, darts: payloadDarts },
    }));
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
    if (!match) return "idle";
    if (matchIsAssigned(match)) return "assigned";
    return "match";
  }, [health, effectiveTestMode, kioskCode, snapshot, match]);

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
      {kioskCode && <ScoliaRuntimePanel snapshotMode={kiosk?.scoring_mode || "manual"} board={scolia.board} leasePending={scolia.leasePending} leaseError={scolia.leaseError} runtimeError={scolia.runtimeError} available={scolia.available} fallbackActive={scolia.fallbackActive} automatic={scolia.automatic} remaining={scolia.fallbackRemainingSeconds} busy={scolia.busy} onFallback={scolia.fallback} onResume={scolia.resume} onResetPhase={scolia.resetPhase} />}

      {view === "loading" && <div className="kiosk-hero"><span className="pill">Skiveterminal</span><h2>Starter terminalen …</h2><p>Henter skive og kampstatus.</p></div>}
      {view === "test-chooser" && <TestChooser boards={testBoards} busy={busy} onChoose={selectTestBoard} onExit={() => void leaveTestMode()} />}
      {view === "pairing" && <PairingView code={pairingCode} expires={pairingExpires} busy={busy} onNew={() => void createPairing(true)} />}
      {view === "idle" && kiosk && <div className="kiosk-hero"><span className="pill good"><span className="dot" />Klar</span><p>{kiosk.club?.name || "Blindleia Dartklubb"}</p><h1>Skive {kiosk.board_number}</h1><p>Venter på neste kamp · {effectiveScoringMode.startsWith("scolia") ? "Scolia scoring" : "manuell scoring"}</p></div>}
      {view === "assigned" && match && kiosk && <AssignedView match={match} board={kiosk.board_number} busy={busy} onStart={() => void startMatch()} />}
      {view === "match" && match && kiosk && <MatchView match={match} board={kiosk.board_number} scoringMode={effectiveScoringMode} scoliaBoard={scolia.board} lastScoliaVisit={scolia.lastVisit} inputMode={inputMode} multiplier={multiplier} darts={darts} score={score} busy={busy || Boolean(scolia.busy)} onMode={setManualMode} onMultiplier={setMultiplier} onDart={addDart} onDartBack={() => setDarts((current) => current.slice(0, -1))} onDartSubmit={() => void submitDartVisit()} onScore={setScore} onSubmit={submitScore} onUndo={() => void undo()} />}
    </section></main>

    {settingsOpen && <SettingsDialog isTest={effectiveTestMode} hasKiosk={Boolean(kioskCode)} busy={busy} onClose={() => setSettingsOpen(false)} onReload={() => window.location.reload()} onReset={() => void resetTerminal()} onExitTest={() => void leaveTestMode()} />}

    {checkoutScore !== null && <div className="login-shell kiosk-dialog-overlay"><div className="login-card kiosk-dialog-card"><span className="pill good">Checkout</span><h1>Hvor mange piler?</h1><p>Registrer hvor mange piler som ble brukt på checkouten.</p><div className="grid three">{[1, 2, 3].map((used) => <button key={used} className="button" disabled={busy} onClick={() => void submitSumVisit(checkoutScore, used)}>{used} pil{used > 1 ? "er" : ""}</button>)}</div><button className="button secondary" onClick={() => setCheckoutScore(null)}>Avbryt</button></div></div>}
  </div>;
}

function SettingsDialog({ isTest, hasKiosk, busy, onClose, onReload, onReset, onExitTest }: {
  isTest: boolean;
  hasKiosk: boolean;
  busy: boolean;
  onClose: () => void;
  onReload: () => void;
  onReset: () => void;
  onExitTest: () => void;
}) {
  return <div className="kiosk-dialog-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="kiosk-settings-dialog" role="dialog" aria-modal="true" aria-label="Skiveterminal innstillinger">
      <div className="kiosk-settings-head"><div><span>Skiveterminal</span><h2>Innstillinger</h2></div><button className="kiosk-settings-button" type="button" aria-label="Lukk" onClick={onClose}>×</button></div>
      <div className="kiosk-settings-actions">
        <button className="button secondary" disabled={busy} onClick={onReload}>Last inn terminalen på nytt</button>
        {hasKiosk && <button className="button secondary" disabled={busy} onClick={onReset}>{isTest ? "Bytt testskive" : "Fjern pairing"}</button>}
        {isTest && <button className="button danger" disabled={busy} onClick={onExitTest}>Avslutt testmodus</button>}
      </div>
    </section>
  </div>;
}

function ScoliaRuntimePanel({ snapshotMode, board, leasePending, leaseError, runtimeError, available, fallbackActive, automatic, remaining, busy, onFallback, onResume, onResetPhase }: {
  snapshotMode: string;
  board: ScoliaRuntimeBoard | null;
  leasePending: boolean;
  leaseError: string;
  runtimeError: string;
  available: boolean;
  fallbackActive: boolean;
  automatic: boolean;
  remaining: number;
  busy: string;
  onFallback: () => Promise<void>;
  onResume: () => Promise<void>;
  onResetPhase: () => Promise<void>;
}) {
  const relevant = snapshotMode === "scolia" || leasePending || board?.mode === "live" || fallbackActive || Boolean(board?.serial_number);
  if (!relevant) return null;
  if (leasePending) return <div className="scolia-kiosk-strip warn"><div><strong>TEST kobler til fysisk Scolia …</strong><span>{leaseError || "Oppretter midlertidig lease. Manuell scoring er sperret mens tilkoblingen etableres."}</span></div><span className="pill warn">TEST · Scolia</span></div>;
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

function AssignedView({ match, board, busy, onStart }: { match: KioskMatch; board: number; busy: boolean; onStart: () => void }) {
  return <div className="assigned-view"><div className="match-tools"><span className="pill good">Skive {board} · kamp klar</span><span className="pill">{match.round_label || match.bracket_label || "Kamp"} · best of {match.best_of_legs}</span></div><div className="versus assigned-versus"><div className="player-tile"><p>Spiller 1</p><h2>{match.player_a.display_name}</h2></div><div className="vs-mark">VS</div><div className="player-tile"><p>Spiller 2</p><h2>{match.player_b.display_name}</h2></div></div><button className="button start-match-button" disabled={busy} onClick={onStart}>{busy ? "Starter …" : "Start kamp"}</button></div>;
}

function MatchView({ match, board, scoringMode, scoliaBoard, lastScoliaVisit, inputMode, multiplier, darts, score, busy, onMode, onMultiplier, onDart, onDartBack, onDartSubmit, onScore, onSubmit, onUndo }: {
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
  onMode: (mode: InputMode) => void;
  onMultiplier: (value: Multiplier) => void;
  onDart: (value: number | "BULL", forcedMultiplier?: Multiplier) => void;
  onDartBack: () => void;
  onDartSubmit: () => void;
  onScore: (value: string) => void;
  onSubmit: () => void;
  onUndo: () => void;
}) {
  const throwing = currentPlayer(match);
  const automatic = scoringMode === "scolia" || scoringMode === "scolia-pending";
  const preview = automatic ? null : manualRemainingPreview(throwing, inputMode, score, darts);
  const playerAActive = Number(match.current_player_id) === Number(match.player_a.id);
  const playerBActive = Number(match.current_player_id) === Number(match.player_b.id);
  return <div className="match-view"><div className="match-tools"><span className="pill good">Skive {board} · live</span><span className="pill">{match.round_label || match.bracket_label || "Kamp"}</span><button className="button secondary small" disabled={busy} onClick={onUndo}>Angre siste kast</button></div><div className="versus"><PlayerTile player={match.player_a} active={playerAActive} preview={playerAActive ? preview : null} /><div className="vs-mark">Leg {match.current_leg || 1}</div><PlayerTile player={match.player_b} active={playerBActive} preview={playerBActive ? preview : null} /></div>{automatic ? <ScoliaScoreSurface pending={scoringMode === "scolia-pending"} board={scoliaBoard} lastVisit={lastScoliaVisit} throwing={throwing} /> : <ManualScoreSurface throwing={throwing} inputMode={inputMode} multiplier={multiplier} darts={darts} score={score} busy={busy} onMode={onMode} onMultiplier={onMultiplier} onDart={onDart} onDartBack={onDartBack} onDartSubmit={onDartSubmit} onScore={onScore} onSubmit={onSubmit} />}<div className="visits">{(match.recent_visits || []).slice(0, 5).map((visit, index) => <div className="visit" key={`${visit.visit_number || index}-${index}`}><span>{visit.player_name || "Spiller"}</span><strong>{Number(visit.score || 0)} {Number(visit.is_bust) === 1 ? "· Bust" : `→ ${Number(visit.remaining_after ?? 0)}`}</strong></div>)}</div></div>;
}

function ManualScoreSurface({ throwing, inputMode, multiplier, darts, score, busy, onMode, onMultiplier, onDart, onDartBack, onDartSubmit, onScore, onSubmit }: {
  throwing: PlayerScore | null;
  inputMode: InputMode;
  multiplier: Multiplier;
  darts: ManualDart[];
  score: string;
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
  return <div className={`score-entry ${inputMode === "per_dart" ? "dart-entry-active" : ""}`}>
    <div className="panel-head scoring-head"><div><h3>{throwing?.display_name || "Registrer kast"}</h3><p>{inputMode === "sum" ? "Sum for tre piler" : `Per pil · sum ${dartTotal}`}</p></div><div className="manual-mode-switch"><button className={inputMode === "sum" ? "active" : ""} disabled={busy} onClick={() => onMode("sum")}>Sum</button><button className={inputMode === "per_dart" ? "active" : ""} disabled={busy} onClick={() => onMode("per_dart")}>Per pil</button></div></div>
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

function PlayerTile({ player, active, preview }: { player: PlayerScore; active: boolean; preview?: RemainingPreview | null }) {
  const remaining = active && preview ? preview.remaining : player.remaining;
  const footer = active && preview
    ? preview.state === "bust"
      ? "Bust · scoren står"
      : preview.state === "checkout"
        ? "Checkout"
        : "Igjen · live"
    : `${player.legs_won} legs`;
  return <article className={`player-tile ${active ? "active" : ""}`}><p>{active ? "Kaster" : `${player.legs_won} legs`}</p><h2>{player.display_name}</h2><div className="remaining">{remaining}</div><p>{footer}</p></article>;
}
