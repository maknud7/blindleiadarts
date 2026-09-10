import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../shared/api";
import { read, write } from "../shared/storage";
import type { Board, Club, EquipmentScope, Health, PairingRequest, ScreenDevice, User } from "../shared/types";
import { BoardEditor } from "./BoardEditor";
import { ScoliaPanel } from "./ScoliaPanel";

type LoadErrors = { inventory?: string; boards?: string; pairing?: string; screens?: string };
type BoardResponse = EquipmentScope & { club_id: number; items: Board[] };
type AuthResponse = { access_token: string; user: User };
type CreateBoardResponse = EquipmentScope & { kiosk: Board };

const SERIAL_PATTERN = /^[A-Za-z0-9._:-]{3,120}$/;

function text(error: unknown): string { return error instanceof Error ? error.message : "Ukjent feil"; }
function formatDate(value?: string | null): string {
  if (!value) return "Aldri";
  const date = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}
function isActive(board: Board): boolean { return Number(board.is_active ?? 1) === 1; }
function pairingCode(value?: string | null): string { return String(value || "").trim().toUpperCase(); }

function Login({ onLogin }: { onLogin: (email: string, password: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setError("");
    try { await onLogin(String(form.get("email") || "").trim(), String(form.get("password") || "")); }
    catch (cause) { setError(text(cause)); }
    finally { setBusy(false); }
  }
  return <div className="login-shell"><form className="login-card" onSubmit={submit}>
    <span className="pill">Blindleia Darts</span><h1>Utstyr</h1><p>Administrer skiver, nettbrett, Scolia og venue-skjermer.</p>
    {error && <div className="notice bad">{error}</div>}
    <label className="field"><span>E-postadresse</span><input type="email" name="email" autoComplete="email" required /></label>
    <label className="field"><span>Passord</span><input type="password" name="password" autoComplete="current-password" required /></label>
    <button className="button" disabled={busy}>{busy ? "Logger inn …" : "Logg inn"}</button>
  </form></div>;
}

export function EquipmentWorkspace() {
  const [token, setToken] = useState(() => read("adminToken"));
  const [health, setHealth] = useState<Health | null>(null);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [clubId, setClubId] = useState(() => Number(read("selectedClub") || 0));
  const [inventoryBoards, setInventoryBoards] = useState<Board[]>([]);
  const [activeBoards, setActiveBoards] = useState<Board[]>([]);
  const [pairing, setPairing] = useState<PairingRequest[]>([]);
  const [pairingLoaded, setPairingLoaded] = useState(false);
  const [requestedPairing, setRequestedPairing] = useState(() => pairingCode(new URLSearchParams(window.location.search).get("pairing")));
  const [screens, setScreens] = useState<ScreenDevice[]>([]);
  const [scope, setScope] = useState<EquipmentScope>({});
  const [errors, setErrors] = useState<LoadErrors>({});
  const [loading, setLoading] = useState(false);
  const [booting, setBooting] = useState(Boolean(token));
  const [mutation, setMutation] = useState("");
  const [notice, setNotice] = useState("");
  const [editingBoard, setEditingBoard] = useState<Board | null>(null);
  const [newBoardScoring, setNewBoardScoring] = useState<"manual" | "scolia">("manual");

  const selectedClub = useMemo(() => clubs.find((club) => Number(club.id) === clubId) || null, [clubs, clubId]);
  const masterReadOnly = health?.environment === "test" && scope.configuration_scope === "production_hardware";
  const inactiveCount = inventoryBoards.filter((board) => !isActive(board)).length;
  const targetPairing = useMemo(() => requestedPairing ? pairing.find((request) => pairingCode(request.request_code) === requestedPairing) || null : null, [pairing, requestedPairing]);
  const orderedPairing = useMemo(() => requestedPairing ? [...pairing].sort((left, right) => Number(pairingCode(right.request_code) === requestedPairing) - Number(pairingCode(left.request_code) === requestedPairing)) : pairing, [pairing, requestedPairing]);

  const loadEquipment = useCallback(async (activeClubId: number, activeToken: string) => {
    if (!activeClubId) return;
    setLoading(true); setPairingLoaded(false);
    const result = await Promise.allSettled([
      api<BoardResponse>(`/clubs/${activeClubId}/equipment/boards`, { token: activeToken }),
      api<BoardResponse>(`/clubs/${activeClubId}/kiosks`),
      api<{ items: PairingRequest[] }>(`/clubs/${activeClubId}/kiosk-pairing-requests`, { token: activeToken }),
      api<{ items: ScreenDevice[] }>(`/clubs/${activeClubId}/screen-devices`, { token: activeToken }),
    ]);
    const next: LoadErrors = {};
    let activeItems: Board[] = [];
    if (result[1].status === "fulfilled") {
      activeItems = result[1].value.items || [];
      setActiveBoards(activeItems);
      setScope({ configuration_scope: result[1].value.configuration_scope, shared_across_environments: result[1].value.shared_across_environments });
    } else { setActiveBoards([]); next.boards = text(result[1].reason); }
    if (result[0].status === "fulfilled") setInventoryBoards(result[0].value.items || []);
    else { setInventoryBoards(activeItems); next.inventory = text(result[0].reason); }
    if (result[2].status === "fulfilled") setPairing(result[2].value.items || []); else { setPairing([]); next.pairing = text(result[2].reason); }
    setPairingLoaded(true);
    if (result[3].status === "fulfilled") setScreens(result[3].value.items || []); else { setScreens([]); next.screens = text(result[3].reason); }
    setErrors(next); setLoading(false);
  }, []);

  useEffect(() => {
    if (!token) { setBooting(false); return; }
    let cancelled = false;
    void (async () => {
      try {
        const [meData, healthData, clubData] = await Promise.all([
          api<{ user: User }>("/auth/me", { token }), api<Health>("/health"), api<{ items: Club[] }>("/clubs"),
        ]);
        if (cancelled) return;
        if (!["club_admin", "super_admin"].includes(meData.user.role)) throw new Error("Denne kontoen har ikke administratortilgang.");
        setHealth(healthData);
        const available = meData.user.role === "club_admin" && meData.user.player?.club_id
          ? clubData.items.filter((club) => Number(club.id) === Number(meData.user.player?.club_id)) : clubData.items;
        setClubs(available);
        const resolved = available.some((club) => Number(club.id) === clubId) ? clubId : Number(available[0]?.id || 0);
        setClubId(resolved); write("selectedClub", resolved || null);
        await loadEquipment(resolved, token);
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 401) { write("adminToken", null); setToken(""); }
        else setNotice(text(cause));
      } finally { if (!cancelled) setBooting(false); }
    })();
    return () => { cancelled = true; };
  }, [token, loadEquipment]);

  async function login(email: string, password: string) {
    const data = await api<AuthResponse>("/auth/login", { method: "POST", body: { email, password } });
    if (!["club_admin", "super_admin"].includes(data.user.role)) throw new Error("Denne kontoen har ikke administratortilgang.");
    write("adminToken", data.access_token); setToken(data.access_token);
  }
  function logout() { write("adminToken", null); setToken(""); setInventoryBoards([]); setActiveBoards([]); setPairing([]); setScreens([]); setEditingBoard(null); }
  function clearPairingDeepLink() {
    const url = new URL(window.location.href); url.searchParams.delete("pairing"); history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`); setRequestedPairing("");
  }

  async function mutate(label: string, action: () => Promise<unknown>, success: string): Promise<boolean> {
    setMutation(label); setNotice("");
    try { await action(); setNotice(success); await loadEquipment(clubId, token); return true; }
    catch (cause) { setNotice(text(cause)); return false; }
    finally { setMutation(""); }
  }

  async function createBoard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (masterReadOnly) return;
    const element = event.currentTarget;
    const form = new FormData(element);
    const number = Number(form.get("board_number") || 0);
    const serial = String(form.get("scolia_serial_number") || "").trim().toUpperCase();
    if (newBoardScoring === "scolia" && !SERIAL_PATTERN.test(serial)) {
      setNotice("Scolia-skiva må ha en gyldig Scolia-ID / serienummer.");
      return;
    }
    await mutate("create-board", async () => {
      const created = await api<CreateBoardResponse>(`/clubs/${clubId}/kiosks`, { method: "POST", token, body: { board_number: number, name: String(form.get("name") || "").trim() || `Skive ${number}`, scoring_mode: newBoardScoring } });
      if (newBoardScoring === "scolia") {
        await api(`/clubs/${clubId}/kiosks/${created.kiosk.id}/scolia`, { method: "PATCH", token, body: { serial_number: serial, mode: "live", auto_fallback_to_manual: true } });
      }
    }, `Skive ${number} er opprettet.`);
    element.reset(); setNewBoardScoring("manual");
  }

  async function createScreen(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const element = event.currentTarget; const form = new FormData(element); const label = String(form.get("label") || "").trim();
    if (!label) return;
    await mutate("create-screen", () => api(`/clubs/${clubId}/screen-devices`, { method: "POST", token, body: { label } }), `Venue-skjermen «${label}» er opprettet.`);
    element.reset();
  }

  if (!token) return <Login onLogin={login} />;
  if (booting) return <div className="login-shell"><div className="login-card"><h1>Utstyr</h1><p>Laster utstyr …</p></div></div>;

  return <div className="v2-shell">
    <header className="v2-topbar"><div className="v2-brand"><img className="v2-logo" src="/static/club-logos/blindleia-dartklubb-logo.png" alt="" /><div><strong>Blindleia Darts</strong><span>Utstyr</span></div></div>
      <div className="v2-top-actions"><span className="pill dark">{health?.environment?.toUpperCase() || "—"}</span><button className="button small" onClick={logout}>Logg ut</button></div>
    </header>
    <main className="v2-main">
      <div className="v2-heading"><div><h1>Utstyr</h1><p>Skiva er den faste enheten. Nettbrett og Scolia er måter å registrere scoring på den samme skiva.</p></div><div className="v2-top-actions">
        {clubs.length > 1 && <select value={clubId} onChange={(event) => { const id = Number(event.target.value); setEditingBoard(null); setClubId(id); write("selectedClub", id); void loadEquipment(id, token); }}>{clubs.map((club) => <option key={club.id} value={club.id}>{club.name}</option>)}</select>}
        <button className="button secondary" disabled={loading} onClick={() => void loadEquipment(clubId, token)}>{loading ? "Oppdaterer …" : "Oppdater"}</button>
      </div></div>
      {masterReadOnly && <div className="notice warn"><strong>TEST bruker samme fysiske skiveoppsett som PROD.</strong> Du kan teste pairing og kampflyt, men ikke endre det fysiske oppsettet her.</div>}
      {notice && <div className="notice">{notice}</div>}

      <section className="panel"><div className="panel-head"><div><h2>Skiver</h2><p>{selectedClub?.name || "Klubb"} · {activeBoards.length} aktive{inactiveCount ? ` · ${inactiveCount} deaktiverte` : ""}</p></div><span className={`pill ${errors.boards || errors.inventory ? "warn" : "good"}`}>{errors.boards ? "Feil" : errors.inventory ? "Delvis lastet" : "Klar"}</span></div>
        {errors.boards && <div className="notice bad">Kunne ikke laste aktive skiver: {errors.boards}</div>}
        {errors.inventory && <div className="notice warn">Kunne ikke laste hele skivelisten. Viser aktive skiver: {errors.inventory}</div>}

        {(errors.pairing || pairing.length > 0 || requestedPairing) && <div className="pairing-task">
          <div className="pairing-task-head"><div><span className="section-label">Nettbrett</span><h3>Koble nettbrett til skive</h3><p>Velg skiva nettbrettet fysisk står ved. Nettbrettet blir en tilkobling til skiva – ikke en egen skive.</p></div><span className={`pill ${errors.pairing ? "bad" : pairing.length ? "warn" : "good"}`}>{errors.pairing ? "Utilgjengelig" : `${pairing.length} venter`}</span></div>
          {errors.pairing && <div className="notice bad">{errors.pairing}</div>}
          {requestedPairing && pairingLoaded && targetPairing && <div className="notice good"><strong>Terminal {requestedPairing} er gjenkjent.</strong> Velg skiva og trykk Koble.</div>}
          {requestedPairing && pairingLoaded && !targetPairing && !errors.pairing && <div className="notice warn"><strong>Terminal {requestedPairing} finnes ikke lenger i pairingkøen.</strong> Lag en ny kode på Kiosk hvis terminalen ikke allerede er koblet.</div>}
          <div className="equipment-list">{orderedPairing.map((request) => <PairingRow key={request.request_code} request={request} boards={activeBoards} busy={Boolean(mutation)} focused={pairingCode(request.request_code) === requestedPairing} onApprove={async (boardId) => {
            const success = await mutate(`pair-${request.request_code}`, () => api(`/clubs/${clubId}/kiosk-pairing-requests/${encodeURIComponent(request.request_code)}/approve`, { method: "POST", token, body: { kiosk_id: boardId } }), `Nettbrettet er koblet til skive ${activeBoards.find((board) => board.id === boardId)?.board_number || ""}.`);
            if (success && pairingCode(request.request_code) === requestedPairing) clearPairingDeepLink();
          }} />)}</div>
        </div>}

        {!masterReadOnly && <form className="inline-create board-create" onSubmit={createBoard}><label className="field"><span>Skivenummer</span><input name="board_number" type="number" min="1" required /></label><label className="field"><span>Scoring</span><select name="scoring_mode" value={newBoardScoring} onChange={(event) => setNewBoardScoring(event.target.value === "scolia" ? "scolia" : "manual")}><option value="manual">Manuell</option><option value="scolia">Scolia</option></select></label><label className="field grow"><span>Navn</span><input name="name" placeholder="Skive 1" /></label>{newBoardScoring === "scolia" && <label className="field grow"><span>Scolia-ID / serienummer</span><input name="scolia_serial_number" maxLength={120} required placeholder="ID fra Scolia" /></label>}<button className="button" disabled={mutation === "create-board"}>+ Ny skive</button></form>}

        <div className="equipment-list board-list">{inventoryBoards.length === 0 && !errors.boards && <div className="empty">Ingen skiver.</div>}{inventoryBoards.map((board) => <article className={`board-row ${isActive(board) ? "" : "is-inactive"}`} key={board.id}><div className="board-number">{board.board_number}</div><div className="row-main"><strong>{board.name || `Skive ${board.board_number}`}</strong><div className="row-meta"><span>{board.scoring_mode === "scolia" ? "Scolia" : "Manuell scoring"}</span><span>{board.is_paired ? `Nettbrett: ${board.paired_device_name || "paret"}` : "Nettbrett: ikke paret"}</span>{board.sponsor_label ? <span>Presentert av {board.sponsor_label}</span> : null}</div></div><div className="row-actions"><span className={`pill ${isActive(board) ? "good" : "warn"}`}>{isActive(board) ? "Aktiv" : "Deaktivert"}</span><button className="button secondary small" disabled={Boolean(mutation)} onClick={() => setEditingBoard(board)}>{masterReadOnly ? "Detaljer" : "Rediger"}</button>{isActive(board) && board.is_paired ? <button className="button secondary small" disabled={Boolean(mutation)} onClick={() => void mutate(`reset-${board.id}`, () => api(`/clubs/${clubId}/kiosks/${board.id}/reset-pairing`, { method: "POST", token }), `Pairing for skive ${board.board_number} er nullstilt.`)}>Bytt / koble fra nettbrett</button> : null}</div></article>)}</div>
      </section>

      <ScoliaPanel clubId={clubId} token={token} environment={health?.environment} boards={activeBoards} onEquipmentRefresh={() => loadEquipment(clubId, token)} />

      <section className="panel"><div className="panel-head"><div><h2>Venue-skjermer</h2><p>Skjermer for livevisning i lokalet.</p></div><span className={`pill ${errors.screens ? "bad" : "good"}`}>{errors.screens ? "Feil" : `${screens.length} stk`}</span></div>{errors.screens && <div className="notice bad">{errors.screens}</div>}<form onSubmit={createScreen} className="inline-create"><label className="field grow"><span>Ny venue-skjerm</span><input name="label" placeholder="Bar-TV" required /></label><button className="button" disabled={mutation === "create-screen"}>Lag skjermkode</button></form><div className="equipment-list">{screens.map((screen) => <article className="screen-row" key={screen.id}><div className="board-number">TV</div><div className="row-main"><strong>{screen.label}</strong><div className="row-meta"><span>Kode: {screen.access_code}</span><span>Sist tilkoblet: {formatDate(screen.last_connected_at)}</span></div></div><span className={`pill ${Number(screen.is_active ?? 1) === 1 ? "good" : "bad"}`}>{Number(screen.is_active ?? 1) === 1 ? "Aktiv" : "Inaktiv"}</span></article>)}</div></section>
    </main>

    {editingBoard && <BoardEditor board={editingBoard} clubId={clubId} token={token} readOnly={masterReadOnly} onClose={() => setEditingBoard(null)} onSaved={async () => {
      await loadEquipment(clubId, token);
      setNotice(`Skive ${editingBoard.board_number} er oppdatert.`);
    }} />}
  </div>;
}

function PairingRow({ request, boards, busy, focused, onApprove }: { request: PairingRequest; boards: Board[]; busy: boolean; focused: boolean; onApprove: (boardId: number) => Promise<unknown> }) {
  const [boardId, setBoardId] = useState(Number(boards[0]?.id || 0));
  const row = useRef<HTMLElement | null>(null);
  useEffect(() => { if (!boards.some((board) => board.id === boardId)) setBoardId(Number(boards[0]?.id || 0)); }, [boards, boardId]);
  useEffect(() => { if (focused) row.current?.scrollIntoView({ behavior: "smooth", block: "center" }); }, [focused]);
  return <article ref={row} className={`pair-row ${focused ? "is-focused" : ""}`}><div className="board-number">↔</div><div className="row-main"><strong>{request.device_name || "Nettbrett"}</strong><div className="row-meta"><span>Kode: {request.request_code}</span><span>Utløper: {formatDate(request.expires_at)}</span></div></div><div className="row-actions"><select value={boardId} disabled={!boards.length} onChange={(event) => setBoardId(Number(event.target.value))}>{boards.map((board) => <option key={board.id} value={board.id}>Skive {board.board_number} · {board.name}</option>)}</select><button className="button small" autoFocus={focused} disabled={busy || !boardId} onClick={() => void onApprove(boardId)}>Koble</button></div></article>;
}
