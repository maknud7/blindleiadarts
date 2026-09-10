import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, legacyApi } from "../shared/api";
import { clearKioskRuntime, ensureKioskToken, read, write } from "../shared/storage";
import type { Health, KioskMatch, KioskSnapshot, PlayerScore, TestBoard } from "../shared/types";

type PairingCreateResponse = { request: { request_code: string; expires_at?: string | null } };
type PairingStatusResponse = { status: string; kiosk?: { code?: string; name?: string }; snapshot?: KioskSnapshot | null };
type TestChooserResponse = { items: TestBoard[] };
type TestActivationResponse = { kiosk: { code: string; name?: string; board_number?: number }; source_board?: { id?: number }; physical_board?: { id?: number } };

function text(error: unknown): string {
  return error instanceof Error ? error.message : "Ukjent feil";
}

function matchIsAssigned(match: KioskMatch | null | undefined): boolean {
  if (!match) return false;
  return ["assigned", "ready", "pending"].includes(String(match.status || "").toLowerCase());
}

function currentPlayer(match: KioskMatch | null | undefined): PlayerScore | null {
  if (!match) return null;
  return Number(match.current_player_id) === Number(match.player_a.id) ? match.player_a : match.player_b;
}

function pairingAdminUrl(code: string): string {
  const url = new URL("/v2/equipment/", window.location.origin);
  url.searchParams.set("pairing", code);
  return url.toString();
}

function qrUrl(code: string): string {
  return `https://quickchart.io/qr?size=360&margin=2&text=${encodeURIComponent(pairingAdminUrl(code))}`;
}

export function KioskApp() {
  const [health, setHealth] = useState<Health | null>(null);
  const [kioskToken, setKioskToken] = useState(() => ensureKioskToken());
  const [kioskCode, setKioskCode] = useState(() => read("kioskCode"));
  const [pairingCode, setPairingCode] = useState(() => read("pairingRequest"));
  const [pairingExpires, setPairingExpires] = useState(() => read("pairingExpires"));
  const [snapshot, setSnapshot] = useState<KioskSnapshot | null>(null);
  const [testMode, setTestMode] = useState(() => read("testMode") === "1" || new URLSearchParams(window.location.search).get("testmode") === "1");
  const [testBoards, setTestBoards] = useState<TestBoard[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [score, setScore] = useState("");
  const [checkoutScore, setCheckoutScore] = useState<number | null>(null);
  const mounted = useRef(true);

  const kiosk = snapshot?.kiosk || null;
  const match = snapshot?.match || null;
  const throwing = currentPlayer(match);
  const isTestEnvironment = health?.environment === "test";
  const effectiveTestMode = isTestEnvironment && testMode;

  const loadState = useCallback(async (code = kioskCode, token = kioskToken) => {
    if (!code) return;
    try {
      const data = await api<KioskSnapshot>(`/kiosks/${encodeURIComponent(code)}/state`, { kioskToken: token });
      if (mounted.current) {
        setSnapshot(data);
        setError("");
      }
    } catch (cause) {
      if (cause instanceof ApiError && [401, 403, 404, 409].includes(cause.status)) {
        if (mounted.current) {
          setSnapshot(null);
          setKioskCode("");
          write("kioskCode", null);
          if (effectiveTestMode) {
            write("testPhysicalBoardId", null);
            write("testBoardLabel", null);
          }
        }
        return;
      }
      if (mounted.current) setError(text(cause));
    }
  }, [kioskCode, kioskToken, effectiveTestMode]);

  const loadTestBoards = useCallback(async () => {
    try {
      const data = await legacyApi<TestChooserResponse>("kiosk-test-mode.php");
      if (mounted.current) {
        setTestBoards(Array.isArray(data.items) ? data.items : []);
        setError("");
      }
    } catch (cause) {
      if (mounted.current) setError(text(cause));
    }
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
    } catch (cause) {
      if (mounted.current) setError(text(cause));
    }
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
    const query = new URLSearchParams(window.location.search);
    const requestedTest = query.get("testmode");
    if (requestedTest === "1") write("testMode", "1");
    if (requestedTest === "0") {
      write("testMode", null);
      setTestMode(false);
    }

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
      else if (effectiveTestMode) {
        if (!testBoards.length) void loadTestBoards();
      } else if (pairingCode) void checkPairing();
      else void createPairing();
    }, 1500);
    return () => window.clearInterval(handle);
  }, [busy, kioskCode, effectiveTestMode, pairingCode, testBoards.length, loadState, loadTestBoards, checkPairing, createPairing]);

  async function selectTestBoard(board: TestBoard) {
    setBusy(true);
    setError("");
    try {
      const data = await legacyApi<TestActivationResponse>("kiosk-test-mode.php", {
        method: "POST",
        kioskToken,
        body: { kiosk_id: Number(board.id), source: board.source || "physical" },
      });
      const code = String(data.kiosk?.code || "");
      if (!code) throw new Error("TEST-runtime mangler kiosk-kode.");
      write("testMode", "1");
      write("kioskCode", code);
      write("testPhysicalBoardId", data.source_board?.id || data.physical_board?.id || board.id);
      write("testBoardLabel", board.name || `Skive ${board.board_number}`);
      setTestMode(true);
      setKioskCode(code);
      setPairingCode("");
      write("pairingRequest", null);
      write("pairingExpires", null);
      await loadState(code, kioskToken);
    } catch (cause) {
      setError(text(cause));
    } finally {
      setBusy(false);
    }
  }

  async function mutate(action: () => Promise<KioskSnapshot>) {
    if (!kioskCode || busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await action();
      setSnapshot(data);
      setScore("");
    } catch (cause) {
      setError(text(cause));
      await loadState().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function startMatch() {
    await mutate(() => api<KioskSnapshot>(`/kiosks/${encodeURIComponent(kioskCode)}/start-match`, { method: "POST", kioskToken }));
  }

  async function undo() {
    await mutate(() => api<KioskSnapshot>(`/kiosks/${encodeURIComponent(kioskCode)}/undo`, { method: "POST", kioskToken }));
  }

  async function submitVisit(value: number, dartsUsed = 3) {
    await mutate(() => api<KioskSnapshot>(`/kiosks/${encodeURIComponent(kioskCode)}/visit`, {
      method: "POST",
      kioskToken,
      body: { score: value, darts_used: dartsUsed, input_mode: "sum" },
    }));
    setCheckoutScore(null);
  }

  function submitScore() {
    const value = Number(score || 0);
    if (!Number.isInteger(value) || value < 0 || value > 180) {
      setError("Score må være mellom 0 og 180.");
      return;
    }
    if (throwing && Number(throwing.remaining) - value === 0) {
      setCheckoutScore(value);
      return;
    }
    void submitVisit(value, 3);
  }

  async function resetTerminal() {
    setBusy(true);
    try {
      if (kioskCode) await api(`/kiosks/${encodeURIComponent(kioskCode)}/unpair`, { method: "POST", kioskToken }).catch(() => undefined);
      clearKioskRuntime();
      setKioskCode("");
      setSnapshot(null);
      setPairingCode("");
      setPairingExpires("");
      if (effectiveTestMode) await loadTestBoards();
      else {
        write("kioskToken", null);
        const token = ensureKioskToken();
        setKioskToken(token);
      }
    } finally {
      setBusy(false);
    }
  }

  function leaveTestMode() {
    clearKioskRuntime();
    write("testMode", null);
    setTestMode(false);
    setKioskCode("");
    setSnapshot(null);
    setTestBoards([]);
    setPairingCode("");
    void createPairing(true);
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

  return <div className="kiosk-shell">
    {effectiveTestMode && <div className="test-banner">TESTMODUS · kampdata går til TEST-runtime</div>}
    <header className="kiosk-topbar">
      <div className="v2-brand">
        <img className="v2-logo" src="/static/club-logos/blindleia-dartklubb-logo.png" alt="" />
        <div><strong>{kiosk?.name || "Blindleia skiveterminal"}</strong><span>Kiosk v2 {kiosk ? `· skive ${kiosk.board_number}` : ""}</span></div>
      </div>
      <div className="v2-top-actions">
        <span className={`pill ${kiosk ? "good" : ""}`}><span className="dot" />{kiosk ? "Tilkoblet" : "Ikke paret"}</span>
        {isTestEnvironment && <button className="button secondary small" onClick={() => {
          if (effectiveTestMode) leaveTestMode();
          else {
            write("testMode", "1");
            setTestMode(true);
            void resetTerminal().then(loadTestBoards);
          }
        }}>{effectiveTestMode ? "Avslutt TEST" : "Start TEST"}</button>}
        {kioskCode && <button className="button secondary small" disabled={busy} onClick={() => void resetTerminal()}>Nullstill</button>}
      </div>
    </header>

    <main className="kiosk-main">
      <section className="kiosk-card">
        {error && <div className="notice bad">{error}</div>}
        {view === "loading" && <div className="kiosk-hero"><span className="pill">Plattform v2</span><h2>Laster skiveterminal …</h2><p>Henter state fra samme canonical API som eksisterende kiosk.</p></div>}
        {view === "test-chooser" && <TestChooser boards={testBoards} busy={busy} onChoose={selectTestBoard} />}
        {view === "pairing" && <PairingView code={pairingCode} expires={pairingExpires} busy={busy} onNew={() => void createPairing(true)} />}
        {view === "idle" && kiosk && <div className="kiosk-hero"><span className="pill good"><span className="dot" />Klar</span><p>{kiosk.club?.name || "Blindleia Dartklubb"}</p><h1>Skive {kiosk.board_number}</h1><p>Venter på neste kamp · {kiosk.scoring_mode === "scolia" ? "Scolia scoring" : "manuell scoring"}</p></div>}
        {view === "assigned" && match && kiosk && <AssignedView match={match} board={kiosk.board_number} busy={busy} onStart={() => void startMatch()} />}
        {view === "match" && match && kiosk && <MatchView match={match} board={kiosk.board_number} scoringMode={kiosk.scoring_mode} score={score} busy={busy} onScore={setScore} onSubmit={submitScore} onUndo={() => void undo()} />}
      </section>
    </main>

    {checkoutScore !== null && <div className="login-shell" style={{ position: "fixed", inset: 0, background: "rgba(7,24,39,.6)", zIndex: 20 }}><div className="login-card"><span className="pill good">Checkout</span><h1>Hvor mange piler?</h1><p>Registrer hvor mange piler som ble brukt på checkouten.</p><div className="grid three">{[1,2,3].map((darts) => <button key={darts} className="button" disabled={busy} onClick={() => void submitVisit(checkoutScore, darts)}>{darts} pil{darts > 1 ? "er" : ""}</button>)}</div><button className="button secondary" style={{ marginTop: 12 }} onClick={() => setCheckoutScore(null)}>Avbryt</button></div></div>}
  </div>;
}

function TestChooser({ boards, busy, onChoose }: { boards: TestBoard[]; busy: boolean; onChoose: (board: TestBoard) => Promise<void> }) {
  return <div className="kiosk-hero"><span className="pill warn">TEST</span><h2>Velg fysisk skive</h2><p>Ingen pairing. Plattform v2 oppretter samme isolerte TEST-runtime som gammel kiosk.</p><div className="test-board-grid">{boards.map((board) => <button key={`${board.source || "physical"}-${board.id}`} className="test-board" disabled={busy} onClick={() => void onChoose(board)}><strong>Skive {board.board_number}</strong><span>{board.club_name}{board.scoring_mode === "scolia" ? " · Scolia" : " · Manuell"}</span></button>)}</div>{!boards.length && <div className="empty">Laster canonical skiveregister …</div>}</div>;
}

function PairingView({ code, expires, busy, onNew }: { code: string; expires: string; busy: boolean; onNew: () => void }) {
  return <div className="kiosk-hero"><span className="pill">Førstegangsoppsett</span><h2>Koble nettbrettet til en skive</h2>{code ? <><img src={qrUrl(code)} width="230" height="230" alt="QR-kode til Utstyr v2" /><div className="pair-code">{code}</div><p>Åpne Utstyr v2 på adminmobilen og velg skive. Terminalen går videre automatisk.{expires ? ` Koden utløper ${new Date(String(expires).replace(" ", "T")).toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" })}.` : ""}</p></> : <p>Lager pairingkode …</p>}<button className="button secondary" disabled={busy} onClick={onNew}>Lag ny kode</button></div>;
}

function AssignedView({ match, board, busy, onStart }: { match: KioskMatch; board: number; busy: boolean; onStart: () => void }) {
  return <div><div className="match-tools"><span className="pill good">Skive {board} · kamp klar</span><span className="pill">{match.round_label || match.bracket_label || "Kamp"} · best of {match.best_of_legs}</span></div><div className="versus"><div className="player-tile"><p>Spiller 1</p><h2>{match.player_a.display_name}</h2></div><div className="vs-mark">VS</div><div className="player-tile"><p>Spiller 2</p><h2>{match.player_b.display_name}</h2></div></div><button className="button" style={{ width: "100%", minHeight: 64, fontSize: 20 }} disabled={busy} onClick={onStart}>{busy ? "Starter …" : "Start kamp"}</button></div>;
}

function MatchView({ match, board, scoringMode, score, busy, onScore, onSubmit, onUndo }: { match: KioskMatch; board: number; scoringMode: string; score: string; busy: boolean; onScore: (value: string) => void; onSubmit: () => void; onUndo: () => void }) {
  const throwing = currentPlayer(match);
  const keys = ["1","2","3","4","5","6","7","8","9","del","0","ok"];
  return <div><div className="match-tools"><span className="pill good">Skive {board} · live</span><span className="pill">{match.round_label || match.bracket_label || "Kamp"}</span><button className="button secondary small" disabled={busy} onClick={onUndo}>Angre siste kast</button></div><div className="versus"><PlayerTile player={match.player_a} active={Number(match.current_player_id) === Number(match.player_a.id)} /><div className="vs-mark">Leg {match.current_leg || 1}</div><PlayerTile player={match.player_b} active={Number(match.current_player_id) === Number(match.player_b.id)} /></div>{scoringMode === "scolia" ? <div className="kiosk-hero" style={{ minHeight: 240 }}><span className="pill good">Scolia</span><h2>Venter på scoring fra skiva</h2><p>Kiosken viser state. Scolia-bridge registrerer kastene via backend.</p></div> : <div className="score-entry"><div className="panel-head"><div><h3>{throwing?.display_name || "Registrer kast"}</h3><p>Sum for tre piler</p></div></div><div className="score-display">{score || "0"}</div><div className="keypad">{keys.map((key) => <button key={key} className={key === "ok" ? "primary" : ""} disabled={busy} onClick={() => { if (key === "del") onScore(score.slice(0, -1)); else if (key === "ok") onSubmit(); else if (score.length < 3) onScore(score + key); }}>{key === "del" ? "⌫" : key === "ok" ? "Lagre" : key}</button>)}</div></div>}<div className="visits">{(match.recent_visits || []).slice(0, 5).map((visit, index) => <div className="visit" key={`${visit.visit_number || index}-${index}`}><span>{visit.player_name || "Spiller"}</span><strong>{Number(visit.score || 0)} {Number(visit.is_bust) === 1 ? "· Bust" : `→ ${Number(visit.remaining_after ?? 0)}`}</strong></div>)}</div></div>;
}

function PlayerTile({ player, active }: { player: PlayerScore; active: boolean }) {
  return <article className={`player-tile ${active ? "active" : ""}`}><p>{active ? "Kaster" : `${player.legs_won} legs`}</p><h2>{player.display_name}</h2><div className="remaining">{player.remaining}</div><p>{player.legs_won} legs</p></article>;
}
