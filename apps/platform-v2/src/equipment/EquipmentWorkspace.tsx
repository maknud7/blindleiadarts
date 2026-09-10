import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../shared/api";
import { read, write } from "../shared/storage";
import type { Board, Club, EquipmentScope, Health, PairingRequest, ScreenDevice, User } from "../shared/types";
import { ScoliaPanel } from "./ScoliaPanel";

type LoadErrors = { boards?: string; pairing?: string; screens?: string };
type BoardResponse = EquipmentScope & { club_id: number; items: Board[] };
type AuthResponse = { access_token: string; user: User };

function text(error: unknown): string { return error instanceof Error ? error.message : "Ukjent feil"; }
function formatDate(value?: string | null): string {
  if (!value) return "Aldri";
  const date = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

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
    <span className="pill">BD · Plattform v2</span><h1>Utstyr</h1><p>Canonical skiver, pairing, venue-skjermer og Scolia i én arbeidsflate.</p>
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
  const [boards, setBoards] = useState<Board[]>([]);
  const [pairing, setPairing] = useState<PairingRequest[]>([]);
  const [screens, setScreens] = useState<ScreenDevice[]>([]);
  const [scope, setScope] = useState<EquipmentScope>({});
  const [errors, setErrors] = useState<LoadErrors>({});
  const [loading, setLoading] = useState(false);
  const [booting, setBooting] = useState(Boolean(token));
  const [mutation, setMutation] = useState("");
  const [notice, setNotice] = useState("");

  const selectedClub = useMemo(() => clubs.find((club) => Number(club.id) === clubId) || null, [clubs, clubId]);
  const masterReadOnly = health?.environment === "test" && scope.configuration_scope === "production_hardware";

  const loadEquipment = useCallback(async (activeClubId: number, activeToken: string) => {
    if (!activeClubId) return;
    setLoading(true);
    const result = await Promise.allSettled([
      api<BoardResponse>(`/clubs/${activeClubId}/kiosks`),
      api<{ items: PairingRequest[] }>(`/clubs/${activeClubId}/kiosk-pairing-requests`, { token: activeToken }),
      api<{ items: ScreenDevice[] }>(`/clubs/${activeClubId}/screen-devices`, { token: activeToken }),
    ]);
    const next: LoadErrors = {};
    if (result[0].status === "fulfilled") {
      setBoards(result[0].value.items || []);
      setScope({ configuration_scope: result[0].value.configuration_scope, shared_across_environments: result[0].value.shared_across_environments });
    } else { setBoards([]); next.boards = text(result[0].reason); }
    if (result[1].status === "fulfilled") setPairing(result[1].value.items || []); else { setPairing([]); next.pairing = text(result[1].reason); }
    if (result[2].status === "fulfilled") setScreens(result[2].value.items || []); else { setScreens([]); next.screens = text(result[2].reason); }
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
  function logout() { write("adminToken", null); setToken(""); setBoards([]); setPairing([]); setScreens([]); }

  async function mutate(label: string, action: () => Promise<unknown>, success: string) {
    setMutation(label); setNotice("");
    try { await action(); setNotice(success); await loadEquipment(clubId, token); }
    catch (cause) { setNotice(text(cause)); }
    finally { setMutation(""); }
  }

  async function createBoard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (masterReadOnly) return;
    const element = event.currentTarget; const form = new FormData(element); const number = Number(form.get("board_number") || 0);
    await mutate("create-board", () => api(`/clubs/${clubId}/kiosks`, { method: "POST", token, body: { board_number: number, name: String(form.get("name") || "").trim() || `Skive ${number}`, scoring_mode: String(form.get("scoring_mode") || "manual") } }), `Skive ${number} er opprettet.`);
    element.reset();
  }

  async function createScreen(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const element = event.currentTarget; const form = new FormData(element); const label = String(form.get("label") || "").trim();
    if (!label) return;
    await mutate("create-screen", () => api(`/clubs/${clubId}/screen-devices`, { method: "POST", token, body: { label } }), `Venue-skjermen «${label}» er opprettet.`);
    element.reset();
  }

  if (!token) return <Login onLogin={login} />;
  if (booting) return <div className="login-shell"><div className="login-card"><h1>Utstyr v2</h1><p>Laster canonical utstyr …</p></div></div>;

  return <div className="v2-shell">
    <header className="v2-topbar"><div className="v2-brand"><img className="v2-logo" src="/static/club-logos/blindleia-dartklubb-logo.png" alt="" /><div><strong>Blindleia Darts</strong><span>Plattform v2 · Utstyr</span></div></div>
      <div className="v2-top-actions"><span className="pill dark">{health?.environment?.toUpperCase() || "—"}</span><a className="button secondary small" href="/v2/kiosk/">Kiosk v2</a><a className="button secondary small" href="/admin/#kiosks">Gammel admin</a><button className="button small" onClick={logout}>Logg ut</button></div>
    </header>
    <main className="v2-main">
      <div className="v2-heading"><div><h1>Utstyr</h1><p>Fysisk utstyr, terminaler og Scolia er eksplisitte domener i samme workspace – uten DOM-koblinger mellom feature-scripts.</p></div><div className="v2-top-actions">
        {clubs.length > 1 && <select value={clubId} onChange={(event) => { const id = Number(event.target.value); setClubId(id); write("selectedClub", id); void loadEquipment(id, token); }}>{clubs.map((club) => <option key={club.id} value={club.id}>{club.name}</option>)}</select>}
        <button className="button secondary" disabled={loading} onClick={() => void loadEquipment(clubId, token)}>{loading ? "Oppdaterer …" : "Oppdater alt"}</button>
      </div></div>
      {masterReadOnly && <div className="notice warn"><strong>TEST bruker PROD sitt fysiske skiveregister.</strong> Fysisk masterdata er skrivebeskyttet; pairing og TEST-runtime er fortsatt tilgjengelig.</div>}
      {notice && <div className="notice">{notice}</div>}

      <section className="panel"><div className="panel-head"><div><h2>Skiver</h2><p>{selectedClub?.name || "Klubb"} · {boards.length} aktive skiver</p></div><span className={`pill ${errors.boards ? "bad" : "good"}`}>{errors.boards ? "Feil" : "Canonical"}</span></div>
        {errors.boards && <div className="notice bad">Kunne ikke laste skiver: {errors.boards}</div>}
        {!masterReadOnly && <form className="inline-create" onSubmit={createBoard}><label className="field"><span>Skivenummer</span><input name="board_number" type="number" min="1" required /></label><label className="field"><span>Scoring</span><select name="scoring_mode"><option value="manual">Manuell</option><option value="scolia">Scolia</option></select></label><label className="field grow"><span>Navn</span><input name="name" placeholder="Skive 1" /></label><button className="button" disabled={mutation === "create-board"}>+ Ny skive</button></form>}
        <div className="equipment-list">{boards.length === 0 && !errors.boards && <div className="empty">Ingen skiver.</div>}{boards.map((board) => <article className="board-row" key={board.id}><div className="board-number">{board.board_number}</div><div className="row-main"><strong>{board.name || `Skive ${board.board_number}`}</strong><div className="row-meta"><span>{board.code}</span><span>{board.is_paired ? `Paret: ${board.paired_device_name || "nettbrett"}` : "Ikke paret"}</span><span>Sist sett: {formatDate(board.last_seen_at)}</span></div></div><div className="row-actions"><span className={`pill ${board.scoring_mode === "scolia" ? "good" : ""}`}>{board.scoring_mode === "scolia" ? "Scolia" : "Manuell"}</span><span className={`pill ${board.is_paired ? "good" : ""}`}>{board.is_paired ? "Paret" : "Ledig"}</span>{board.is_paired ? <button className="button secondary small" disabled={Boolean(mutation)} onClick={() => void mutate(`reset-${board.id}`, () => api(`/clubs/${clubId}/kiosks/${board.id}/reset-pairing`, { method: "POST", token }), `Pairing for skive ${board.board_number} er nullstilt.`)}>Nullstill pairing</button> : null}</div></article>)}</div>
      </section>

      <ScoliaPanel clubId={clubId} token={token} environment={health?.environment} boards={boards} onEquipmentRefresh={() => loadEquipment(clubId, token)} />

      <section className="panel"><div className="panel-head"><div><h2>Nettbrett som venter</h2><p>Pairing er runtime-data og lastes uavhengig.</p></div><span className={`pill ${errors.pairing ? "bad" : pairing.length ? "warn" : "good"}`}>{errors.pairing ? "Utilgjengelig" : `${pairing.length} venter`}</span></div>{errors.pairing && <div className="notice bad">{errors.pairing}</div>}<div className="equipment-list">{!errors.pairing && pairing.length === 0 && <div className="empty">Ingen nettbrett venter på pairing.</div>}{pairing.map((request) => <PairingRow key={request.request_code} request={request} boards={boards} busy={Boolean(mutation)} onApprove={(boardId) => mutate(`pair-${request.request_code}`, () => api(`/clubs/${clubId}/kiosk-pairing-requests/${encodeURIComponent(request.request_code)}/approve`, { method: "POST", token, body: { kiosk_id: boardId } }), `Nettbrettet er koblet til skive ${boards.find((board) => board.id === boardId)?.board_number || ""}.`)} />)}</div></section>

      <section className="panel"><div className="panel-head"><div><h2>Venue-skjermer</h2><p>Egen livssyklus, uavhengig av skivene.</p></div><span className={`pill ${errors.screens ? "bad" : "good"}`}>{errors.screens ? "Feil" : `${screens.length} stk`}</span></div>{errors.screens && <div className="notice bad">{errors.screens}</div>}<form onSubmit={createScreen} className="inline-create"><label className="field grow"><span>Ny venue-skjerm</span><input name="label" placeholder="Bar-TV" required /></label><button className="button" disabled={mutation === "create-screen"}>Lag skjermkode</button></form><div className="equipment-list">{screens.map((screen) => <article className="screen-row" key={screen.id}><div className="board-number">TV</div><div className="row-main"><strong>{screen.label}</strong><div className="row-meta"><span>Kode: {screen.access_code}</span><span>Sist tilkoblet: {formatDate(screen.last_connected_at)}</span></div></div><span className={`pill ${Number(screen.is_active ?? 1) === 1 ? "good" : "bad"}`}>{Number(screen.is_active ?? 1) === 1 ? "Aktiv" : "Inaktiv"}</span></article>)}</div></section>
    </main>
  </div>;
}

function PairingRow({ request, boards, busy, onApprove }: { request: PairingRequest; boards: Board[]; busy: boolean; onApprove: (boardId: number) => Promise<unknown> }) {
  const [boardId, setBoardId] = useState(Number(boards[0]?.id || 0));
  useEffect(() => { if (!boards.some((board) => board.id === boardId)) setBoardId(Number(boards[0]?.id || 0)); }, [boards, boardId]);
  return <article className="pair-row"><div className="board-number">↔</div><div className="row-main"><strong>{request.device_name || "Nettbrett"}</strong><div className="row-meta"><span>Kode: {request.request_code}</span><span>Utløper: {formatDate(request.expires_at)}</span></div></div><div className="row-actions"><select value={boardId} onChange={(event) => setBoardId(Number(event.target.value))}>{boards.map((board) => <option key={board.id} value={board.id}>Skive {board.board_number} · {board.name}</option>)}</select><button className="button small" disabled={busy || !boardId} onClick={() => void onApprove(boardId)}>Koble</button></div></article>;
}
