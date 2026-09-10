import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../shared/api";
import { read, write } from "../shared/storage";
import type { Board, Club, EquipmentScope, Health, PairingRequest, ScreenDevice, User } from "../shared/types";

type LoadErrors = {
  boards?: string;
  pairing?: string;
  screens?: string;
};

type BoardResponse = EquipmentScope & { club_id: number; items: Board[] };

type AuthResponse = { access_token: string; user: User };

function formatDate(value?: string | null): string {
  if (!value) return "Aldri";
  const date = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Ukjent feil";
}

function Login({ onLogin }: { onLogin: (email: string, password: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await onLogin(String(form.get("email") || "").trim(), String(form.get("password") || ""));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return <div className="login-shell">
    <form className="login-card" onSubmit={submit}>
      <span className="pill">BD · Plattform v2</span>
      <h1>Utstyr</h1>
      <p>Ny typed adminflate. Samme brukerkonto og samme canonical PROD-utstyr som før.</p>
      {error && <div className="notice bad">{error}</div>}
      <label className="field"><span>E-postadresse</span><input type="email" name="email" autoComplete="email" required /></label>
      <label className="field"><span>Passord</span><input type="password" name="password" autoComplete="current-password" required /></label>
      <button className="button" disabled={busy}>{busy ? "Logger inn …" : "Logg inn"}</button>
    </form>
  </div>;
}

export function EquipmentApp() {
  const [token, setToken] = useState(() => read("adminToken"));
  const [me, setMe] = useState<User | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [clubId, setClubId] = useState(() => Number(read("selectedClub") || 0));
  const [boards, setBoards] = useState<Board[]>([]);
  const [pairing, setPairing] = useState<PairingRequest[]>([]);
  const [screens, setScreens] = useState<ScreenDevice[]>([]);
  const [scope, setScope] = useState<EquipmentScope>({});
  const [loading, setLoading] = useState(false);
  const [booting, setBooting] = useState(Boolean(token));
  const [errors, setErrors] = useState<LoadErrors>({});
  const [notice, setNotice] = useState("");
  const [mutation, setMutation] = useState("");

  const selectedClub = useMemo(() => clubs.find((club) => Number(club.id) === Number(clubId)) || null, [clubs, clubId]);
  const masterReadOnly = health?.environment === "test" && scope.configuration_scope === "production_hardware";

  const loadEquipment = useCallback(async (activeClubId: number, activeToken: string) => {
    if (!activeClubId) return;
    setLoading(true);
    setErrors({});

    const results = await Promise.allSettled([
      api<BoardResponse>(`/clubs/${activeClubId}/kiosks`),
      api<{ items: PairingRequest[] }>(`/clubs/${activeClubId}/kiosk-pairing-requests`, { token: activeToken }),
      api<{ items: ScreenDevice[] }>(`/clubs/${activeClubId}/screen-devices`, { token: activeToken }),
    ]);

    const nextErrors: LoadErrors = {};
    const boardResult = results[0];
    if (boardResult.status === "fulfilled") {
      setBoards(boardResult.value.items || []);
      setScope({
        configuration_scope: boardResult.value.configuration_scope,
        shared_across_environments: boardResult.value.shared_across_environments,
      });
    } else {
      setBoards([]);
      nextErrors.boards = message(boardResult.reason);
    }

    const pairingResult = results[1];
    if (pairingResult.status === "fulfilled") setPairing(pairingResult.value.items || []);
    else {
      setPairing([]);
      nextErrors.pairing = message(pairingResult.reason);
    }

    const screenResult = results[2];
    if (screenResult.status === "fulfilled") setScreens(screenResult.value.items || []);
    else {
      setScreens([]);
      nextErrors.screens = message(screenResult.reason);
    }

    setErrors(nextErrors);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!token) {
      setBooting(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [meData, healthData, clubData] = await Promise.all([
          api<{ user: User }>("/auth/me", { token }),
          api<Health>("/health"),
          api<{ items: Club[] }>("/clubs"),
        ]);
        if (cancelled) return;
        if (!["club_admin", "super_admin"].includes(meData.user.role)) throw new Error("Denne kontoen har ikke administratortilgang.");
        setMe(meData.user);
        setHealth(healthData);
        const available = meData.user.role === "club_admin" && meData.user.player?.club_id
          ? clubData.items.filter((club) => Number(club.id) === Number(meData.user.player?.club_id))
          : clubData.items;
        setClubs(available);
        const resolved = available.some((club) => Number(club.id) === Number(clubId)) ? clubId : Number(available[0]?.id || 0);
        setClubId(resolved);
        write("selectedClub", resolved || null);
        await loadEquipment(resolved, token);
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 401) {
          write("adminToken", null);
          setToken("");
        } else {
          setNotice(message(cause));
        }
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, loadEquipment]);

  async function login(email: string, password: string) {
    const data = await api<AuthResponse>("/auth/login", { method: "POST", body: { email, password } });
    if (!["club_admin", "super_admin"].includes(data.user.role)) throw new Error("Denne kontoen har ikke administratortilgang.");
    write("adminToken", data.access_token);
    setToken(data.access_token);
    setMe(data.user);
  }

  function logout() {
    write("adminToken", null);
    setToken("");
    setMe(null);
    setBoards([]);
    setPairing([]);
    setScreens([]);
  }

  async function mutate(label: string, action: () => Promise<unknown>, success: string) {
    setMutation(label);
    setNotice("");
    try {
      await action();
      setNotice(success);
      await loadEquipment(clubId, token);
    } catch (cause) {
      setNotice(message(cause));
    } finally {
      setMutation("");
    }
  }

  async function createBoard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (masterReadOnly) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const boardNumber = Number(form.get("board_number") || 0);
    await mutate("create-board", () => api(`/clubs/${clubId}/kiosks`, {
      method: "POST",
      token,
      body: {
        board_number: boardNumber,
        name: String(form.get("name") || "").trim() || `Skive ${boardNumber}`,
        scoring_mode: String(form.get("scoring_mode") || "manual"),
      },
    }), `Skive ${boardNumber} er opprettet.`);
    formElement.reset();
  }

  async function createScreen(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const label = String(form.get("label") || "").trim();
    if (!label) return;
    await mutate("create-screen", () => api(`/clubs/${clubId}/screen-devices`, { method: "POST", token, body: { label } }), `Venue-skjermen «${label}» er opprettet.`);
    formElement.reset();
  }

  if (!token) return <Login onLogin={login} />;
  if (booting) return <div className="login-shell"><div className="login-card"><h1>Utstyr v2</h1><p>Laster canonical utstyr …</p></div></div>;

  return <div className="v2-shell">
    <header className="v2-topbar">
      <div className="v2-brand">
        <img className="v2-logo" src="/static/club-logos/blindleia-dartklubb-logo.png" alt="" />
        <div><strong>Blindleia Darts</strong><span>Plattform v2 · Utstyr</span></div>
      </div>
      <div className="v2-top-actions">
        <span className={`pill dark`}>{health?.environment?.toUpperCase() || "—"}</span>
        <a className="button secondary small" href="/v2/kiosk/">Kiosk v2</a>
        <a className="button secondary small" href="/admin/#kiosks">Gammel admin</a>
        <button className="button small" onClick={logout}>Logg ut</button>
      </div>
    </header>

    <main className="v2-main">
      <div className="v2-heading">
        <div><h1>Utstyr</h1><p>Én komponent eier skiver, pairing og venue-skjermer. Delområdene lastes uavhengig slik at én feil ikke kan skjule de andre.</p></div>
        <div className="v2-top-actions">
          {clubs.length > 1 && <select value={clubId} onChange={(event) => {
            const id = Number(event.target.value);
            setClubId(id);
            write("selectedClub", id);
            void loadEquipment(id, token);
          }}>{clubs.map((club) => <option key={club.id} value={club.id}>{club.name}</option>)}</select>}
          <button className="button secondary" disabled={loading} onClick={() => void loadEquipment(clubId, token)}>{loading ? "Oppdaterer …" : "Oppdater"}</button>
        </div>
      </div>

      {masterReadOnly && <div className="notice warn"><strong>TEST bruker PROD sitt fysiske skiveregister.</strong> Masterdata er skrivebeskyttet her. Pairing/runtime kan fortsatt testes uten å endre den fysiske skiva.</div>}
      {notice && <div className="notice">{notice}</div>}

      <section className="panel">
        <div className="panel-head"><div><h2>Skiver</h2><p>{selectedClub?.name || "Klubb"} · {boards.length} aktive skiver</p></div><span className={`pill ${errors.boards ? "bad" : "good"}`}><span className="dot" />{errors.boards ? "Feil" : "Canonical"}</span></div>
        {errors.boards && <div className="notice bad">Kunne ikke laste skiver: {errors.boards}</div>}
        {!masterReadOnly && <form className="panel" onSubmit={createBoard} style={{ boxShadow: "none", marginBottom: 14 }}>
          <div className="form-grid">
            <label className="field"><span>Skivenummer</span><input name="board_number" type="number" min="1" required /></label>
            <label className="field"><span>Scoring</span><select name="scoring_mode"><option value="manual">Manuell</option><option value="scolia">Scolia</option></select></label>
            <label className="field wide"><span>Navn (valgfritt)</span><input name="name" placeholder="Skive 1" /></label>
          </div>
          <div className="form-actions"><button className="button" disabled={mutation === "create-board"}>{mutation === "create-board" ? "Oppretter …" : "+ Ny skive"}</button></div>
        </form>}
        <div className="equipment-list">
          {boards.length === 0 && !errors.boards && <div className="empty">Ingen skiver.</div>}
          {boards.map((board) => <article className="board-row" key={board.id}>
            <div className="board-number">{board.board_number}</div>
            <div className="row-main"><strong>{board.name || `Skive ${board.board_number}`}</strong><div className="row-meta"><span>{board.code}</span><span>{board.is_paired ? `Paret: ${board.paired_device_name || "nettbrett"}` : "Ikke paret"}</span><span>Sist sett: {formatDate(board.last_seen_at)}</span></div></div>
            <div className="row-actions">
              <select aria-label={`Scoring for skive ${board.board_number}`} disabled={masterReadOnly || Boolean(mutation)} value={board.scoring_mode || "manual"} onChange={(event) => void mutate(`mode-${board.id}`, () => api(`/clubs/${clubId}/kiosks/${board.id}`, { method: "PATCH", token, body: { scoring_mode: event.target.value } }), `Skive ${board.board_number} er oppdatert.`)}><option value="manual">Manuell</option><option value="scolia">Scolia</option></select>
              <span className={`pill ${board.is_paired ? "good" : ""}`}>{board.is_paired ? "Paret" : "Ledig"}</span>
              {board.is_paired ? <button className="button secondary small" disabled={Boolean(mutation)} onClick={() => void mutate(`reset-${board.id}`, () => api(`/clubs/${clubId}/kiosks/${board.id}/reset-pairing`, { method: "POST", token }), `Pairing for skive ${board.board_number} er nullstilt.`)}>Nullstill pairing</button> : null}
            </div>
          </article>)}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><div><h2>Nettbrett som venter</h2><p>Pairing er runtime-data og kan feile uten å påvirke skivelisten.</p></div><span className={`pill ${errors.pairing ? "bad" : pairing.length ? "warn" : "good"}`}>{errors.pairing ? "Utilgjengelig" : `${pairing.length} venter`}</span></div>
        {errors.pairing && <div className="notice bad">Pairing kunne ikke lastes: {errors.pairing}</div>}
        {!errors.pairing && pairing.length === 0 && <div className="empty">Ingen nettbrett venter på pairing.</div>}
        <div className="equipment-list">{pairing.map((request) => <PairingRow key={request.request_code} request={request} boards={boards} busy={Boolean(mutation)} onApprove={(boardId) => mutate(`pair-${request.request_code}`, () => api(`/clubs/${clubId}/kiosk-pairing-requests/${encodeURIComponent(request.request_code)}/approve`, { method: "POST", token, body: { kiosk_id: boardId } }), `Nettbrettet er koblet til skive ${boards.find((board) => board.id === boardId)?.board_number || ""}.`)} />)}</div>
      </section>

      <section className="panel">
        <div className="panel-head"><div><h2>Venue-skjermer</h2><p>Skjermene har egen livssyklus og påvirker ikke skiver eller kiosk.</p></div><span className={`pill ${errors.screens ? "bad" : "good"}`}>{errors.screens ? "Feil" : `${screens.length} stk`}</span></div>
        {errors.screens && <div className="notice bad">Venue-skjermer kunne ikke lastes: {errors.screens}</div>}
        <form onSubmit={createScreen} className="form-grid"><label className="field wide"><span>Ny venue-skjerm</span><input name="label" placeholder="Bar-TV" required /></label><div className="form-actions field wide"><button className="button" disabled={mutation === "create-screen"}>Lag skjermkode</button></div></form>
        <div className="equipment-list" style={{ marginTop: 14 }}>{screens.map((screen) => <article className="screen-row" key={screen.id}><div className="board-number">TV</div><div className="row-main"><strong>{screen.label}</strong><div className="row-meta"><span>Kode: {screen.access_code}</span><span>Sist tilkoblet: {formatDate(screen.last_connected_at)}</span></div></div><span className={`pill ${Number(screen.is_active ?? 1) === 1 ? "good" : "bad"}`}>{Number(screen.is_active ?? 1) === 1 ? "Aktiv" : "Inaktiv"}</span></article>)}</div>
      </section>
    </main>
  </div>;
}

function PairingRow({ request, boards, busy, onApprove }: { request: PairingRequest; boards: Board[]; busy: boolean; onApprove: (boardId: number) => Promise<unknown> }) {
  const [boardId, setBoardId] = useState(Number(boards[0]?.id || 0));
  useEffect(() => {
    if (!boards.some((board) => board.id === boardId)) setBoardId(Number(boards[0]?.id || 0));
  }, [boards, boardId]);

  return <article className="pair-row">
    <div className="board-number">↔</div>
    <div className="row-main"><strong>{request.device_name || "Nettbrett"}</strong><div className="row-meta"><span>Kode: {request.request_code}</span><span>Utløper: {formatDate(request.expires_at)}</span></div></div>
    <div className="row-actions"><select value={boardId} onChange={(event) => setBoardId(Number(event.target.value))}>{boards.map((board) => <option key={board.id} value={board.id}>Skive {board.board_number} · {board.name}</option>)}</select><button className="button small" disabled={busy || !boardId} onClick={() => void onApprove(boardId)}>Koble</button></div>
  </article>;
}
