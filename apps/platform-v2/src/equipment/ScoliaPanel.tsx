import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, legacyApi } from "../shared/api";
import type {
  Board,
  EnvironmentName,
  ScoliaBoard,
  ScoliaBridgeState,
  ScoliaDashboard,
  ScoliaFailedEvent,
  ScoliaIncident,
} from "../shared/types";

type Props = {
  clubId: number;
  token: string;
  environment?: EnvironmentName;
  boards: Board[];
  onEquipmentRefresh: () => Promise<unknown>;
};

type BridgeResponse = { board: ScoliaBridgeState; changed?: boolean; message?: string };

type OwnershipMap = Record<number, ScoliaBridgeState | undefined>;

const SERIAL_PATTERN = /^[A-Za-z0-9._:-]{3,120}$/;
const QUEUE_KEYS = ["queued", "processing", "failed", "dead_letter", "processed", "ignored"] as const;

function text(error: unknown): string {
  return error instanceof Error ? error.message : "Ukjent feil";
}

function yes(value: unknown): boolean {
  return value === true || Number(value || 0) === 1;
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("nb-NO", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function bridgeUrl(clubId: number, kioskId: number): string {
  return `scolia-bridge-control.php?club_id=${encodeURIComponent(clubId)}&kiosk_id=${encodeURIComponent(kioskId)}`;
}

export function ScoliaPanel({ clubId, token, environment, boards, onEquipmentRefresh }: Props) {
  const [dashboard, setDashboard] = useState<ScoliaDashboard | null>(null);
  const [ownership, setOwnership] = useState<OwnershipMap>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const readOnly = environment === "test" && dashboard?.configuration_scope === "production_hardware";
  const scoliaBoards = useMemo(() => {
    const byId = new Map<number, ScoliaBoard>();
    for (const item of dashboard?.boards || []) byId.set(Number(item.id), item);
    return boards.map((board) => ({ board, scolia: byId.get(Number(board.id)) }));
  }, [boards, dashboard]);

  const load = useCallback(async () => {
    if (!clubId || !token) return;
    setLoading(true);
    setError("");
    try {
      const data = await api<ScoliaDashboard>(`/clubs/${clubId}/scolia`, { token });
      setDashboard(data);
      const states = await Promise.allSettled(
        (data.boards || []).map(async (board) => {
          const state = await legacyApi<BridgeResponse>(bridgeUrl(clubId, Number(board.id)), { token });
          return [Number(board.id), state.board] as const;
        }),
      );
      const next: OwnershipMap = {};
      for (const result of states) {
        if (result.status === "fulfilled") next[result.value[0]] = result.value[1];
      }
      setOwnership(next);
    } catch (cause) {
      setError(text(cause));
    } finally {
      setLoading(false);
    }
  }, [clubId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(label: string, action: () => Promise<unknown>, success: string, refreshEquipment = false) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(success);
      await load();
      if (refreshEquipment) await onEquipmentRefresh();
    } catch (cause) {
      setError(text(cause));
    } finally {
      setBusy("");
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (readOnly || !dashboard) return;
    const form = new FormData(event.currentTarget);
    const tokenValue = String(form.get("access_token") || "").trim();
    const body: Record<string, unknown> = {
      enabled: form.get("enabled") === "on",
      force_connect: form.get("force_connect") === "on",
      forward_messages_to_scolia: form.get("forward_messages_to_scolia") === "on",
      disconnect_fallback_enabled: form.get("disconnect_fallback_enabled") === "on",
      queue_max_attempts: Number(form.get("queue_max_attempts") || 8),
      queue_retry_base_seconds: Number(form.get("queue_retry_base_seconds") || 2),
      event_retention_days: Number(form.get("event_retention_days") || 30),
    };
    if (tokenValue) body.access_token = tokenValue;
    await run(
      "settings",
      () => api(`/clubs/${clubId}/scolia/settings`, { method: "PATCH", token, body }),
      "Scolia-innstillingene er lagret i canonical PROD-utstyr.",
    );
  }

  async function saveBoard(board: Board, serial: string, enabled: boolean) {
    if (readOnly) return;
    const normalized = serial.trim().toUpperCase();
    if (enabled && !SERIAL_PATTERN.test(normalized)) {
      setError("Scolia-ID må være 3–120 tegn og kan inneholde bokstaver, tall, punktum, bindestrek, understrek og kolon.");
      return;
    }
    await run(
      `board-${board.id}`,
      () => api(`/clubs/${clubId}/kiosks/${board.id}/scolia`, {
        method: "PATCH",
        token,
        body: { serial_number: normalized, mode: enabled ? "live" : "off", auto_fallback_to_manual: true },
      }),
      `Scolia-oppsettet for skive ${board.board_number} er lagret.`,
      true,
    );
  }

  async function changeBridge(board: Board, state: ScoliaBridgeState) {
    if (!state.can_change_bridge) return;
    const attach = state.bridge_released;
    const confirmed = window.confirm(attach
      ? `Koble Scolia på skive ${board.board_number} tilbake til Blindleia?`
      : `Frikoble Scolia på skive ${board.board_number} fra Blindleia slik at den kan brukes direkte i Scolia?`);
    if (!confirmed) return;
    await run(
      `bridge-${board.id}`,
      () => legacyApi<BridgeResponse>(bridgeUrl(clubId, board.id), { method: "POST", token, body: { attached: attach } }),
      attach
        ? `Skive ${board.board_number}: Blindleia kan bruke Scolia igjen.`
        : `Skive ${board.board_number}: Scolia er frikoblet. Vent noen sekunder før skiva åpnes direkte i Scolia.`,
    );
  }

  async function runtimeAction(board: Board, action: "fallback" | "reset-phase" | "resume") {
    const body = action === "resume" ? { reconciled: true } : undefined;
    const copy = action === "fallback"
      ? "Manuell fallback er aktivert."
      : action === "resume"
        ? "Score er markert avstemt og Scolia gjenopptas."
        : "Scolia-fasen er nullstilt.";
    await run(
      `runtime-${board.id}-${action}`,
      () => api(`/clubs/${clubId}/kiosks/${board.id}/scolia/${action}`, { method: "POST", token, body }),
      `Skive ${board.board_number}: ${copy}`,
    );
  }

  const settings = dashboard?.settings;
  const settingsKey = settings
    ? [yes(settings.enabled), yes(settings.force_connect), yes(settings.forward_messages_to_scolia), yes(settings.disconnect_fallback_enabled), settings.queue_max_attempts, settings.queue_retry_base_seconds, settings.event_retention_days, settings.access_token_masked].join("|")
    : "loading";

  return <section className="panel scolia-workspace">
    <div className="panel-head">
      <div>
        <h2>Scolia</h2>
        <p>Canonical skiveoppsett og aktiv runtime i én typed flate. Ingen DOM-observere eller skjult kobling til den vanlige skivelisten.</p>
      </div>
      <div className="row-actions">
        <span className={`pill ${error ? "bad" : loading ? "warn" : "good"}`}><span className="dot" />{error ? "Feil" : loading ? "Oppdaterer" : "Klar"}</span>
        <button className="button secondary small" disabled={loading || Boolean(busy)} onClick={() => void load()}>Oppdater Scolia</button>
      </div>
    </div>

    {readOnly && <div className="notice warn"><strong>Canonical PROD-innstilling.</strong> TEST kan lese serienummer, tokenstatus og fysisk Scolia-eierskap, men kan ikke endre dem. Runtime-handlinger gjelder fortsatt TEST-runtime.</div>}
    {error && <div className="notice bad">{error}</div>}
    {notice && <div className="notice good">{notice}</div>}

    {settings && <form className="scolia-settings-card" key={settingsKey} onSubmit={saveSettings}>
      <div className="panel-head compact"><div><h3>Klubbtilkobling</h3><p>Service Account-token deles av klubbens Scolia-skiver og returneres aldri i klartekst.</p></div><span className={`pill ${yes(settings.enabled) ? "good" : ""}`}>{yes(settings.enabled) ? "Aktivert" : "Av"}</span></div>
      <div className="form-grid">
        <label className="field wide check-field"><input name="enabled" type="checkbox" defaultChecked={yes(settings.enabled)} disabled={readOnly} /><span>Aktiver Scolia for klubben</span></label>
        <label className="field wide"><span>Service Account access token</span><input name="access_token" type="password" autoComplete="new-password" disabled={readOnly} placeholder={settings.access_token_configured ? `Lagret ${settings.access_token_masked || "token"} – skriv bare for å bytte` : "Lim inn access token"} /></label>
        <label className="field check-field"><input name="force_connect" type="checkbox" defaultChecked={yes(settings.force_connect)} disabled={readOnly} /><span>forceConnect</span></label>
        <label className="field check-field"><input name="forward_messages_to_scolia" type="checkbox" defaultChecked={yes(settings.forward_messages_to_scolia)} disabled={readOnly} /><span>Forward eventer til Scolia</span></label>
        <label className="field check-field wide"><input name="disconnect_fallback_enabled" type="checkbox" defaultChecked={yes(settings.disconnect_fallback_enabled)} disabled={readOnly} /><span>Automatisk manuell fallback ved disconnect</span></label>
        <label className="field"><span>Maks retry</span><input name="queue_max_attempts" type="number" min="1" max="20" defaultValue={settings.queue_max_attempts || 8} disabled={readOnly} /></label>
        <label className="field"><span>Retry base (sek)</span><input name="queue_retry_base_seconds" type="number" min="1" max="300" defaultValue={settings.queue_retry_base_seconds || 2} disabled={readOnly} /></label>
        <label className="field"><span>Behold råeventer (dager)</span><input name="event_retention_days" type="number" min="1" max="365" defaultValue={settings.event_retention_days || 30} disabled={readOnly} /></label>
      </div>
      {!readOnly && <div className="form-actions"><button className="button" disabled={Boolean(busy)}>{busy === "settings" ? "Lagrer …" : "Lagre Scolia-innstillinger"}</button></div>}
    </form>}

    <div className="scolia-board-list">
      <div className="panel-head compact"><div><h3>Fysiske Scolia-skiver</h3><p>Serienummer og bridge-eierskap tilhører den fysiske skiva. TEST-runtime er separat.</p></div></div>
      {scoliaBoards.map(({ board, scolia }) => <ScoliaBoardRow
        key={board.id}
        board={board}
        scolia={scolia}
        ownership={ownership[board.id]}
        readOnly={readOnly}
        busy={busy}
        onSave={saveBoard}
        onBridge={changeBridge}
        onRuntime={runtimeAction}
      />)}
    </div>

    {dashboard && <details className="scolia-advanced">
      <summary>Drift, kø og avvik</summary>
      <div className="queue-grid-v2">
        {QUEUE_KEYS.map((key) => <div className="queue-chip-v2" key={key}><strong>{Number(dashboard.queue?.[key] || 0)}</strong><span>{key}</span></div>)}
      </div>
      <div className="form-actions left"><button className="button secondary small" disabled={Boolean(busy)} onClick={() => void run("drain", () => api(`/clubs/${clubId}/scolia/queue/drain`, { method: "POST", token }), "Scolia-køen er kjørt.")}>{busy === "drain" ? "Kjører …" : "Kjør kø nå"}</button></div>
      <div className="grid two scolia-ops-grid">
        <IncidentList items={dashboard.incidents || []} busy={busy} onResolve={(item) => run(`incident-${item.id}`, () => api(`/clubs/${clubId}/scolia/incidents/${item.id}/resolve`, { method: "POST", token }), "Avviket er markert løst.")} />
        <FailedEventList items={dashboard.failed_events || []} busy={busy} onRetry={(item) => run(`event-${item.id}`, () => api(`/clubs/${clubId}/scolia/events/${item.id}/retry`, { method: "POST", token }), "Eventet er lagt tilbake for behandling.")} />
      </div>
    </details>}
  </section>;
}

function ScoliaBoardRow({ board, scolia, ownership, readOnly, busy, onSave, onBridge, onRuntime }: {
  board: Board;
  scolia?: ScoliaBoard;
  ownership?: ScoliaBridgeState;
  readOnly: boolean;
  busy: string;
  onSave: (board: Board, serial: string, enabled: boolean) => Promise<void>;
  onBridge: (board: Board, state: ScoliaBridgeState) => Promise<void>;
  onRuntime: (board: Board, action: "fallback" | "reset-phase" | "resume") => Promise<void>;
}) {
  const [serial, setSerial] = useState(scolia?.serial_number || "");
  const [enabled, setEnabled] = useState((scolia?.mode || (board.scoring_mode === "scolia" ? "live" : "off")) === "live");

  useEffect(() => {
    setSerial(scolia?.serial_number || "");
    setEnabled((scolia?.mode || (board.scoring_mode === "scolia" ? "live" : "off")) === "live");
  }, [scolia?.serial_number, scolia?.mode, board.scoring_mode]);

  const fallback = yes(scolia?.fallback_active);
  const reconcile = yes(scolia?.needs_reconciliation);
  const hasRuntime = Number(scolia?.runtime_kiosk_id || 0) > 0;
  const bridgeReleased = Boolean(ownership?.bridge_released);
  const isConfigured = enabled || Boolean(serial) || board.scoring_mode === "scolia";
  const statusTone = reconcile || fallback ? "warn" : scolia?.connection_state === "connected" ? "good" : "";

  return <article className={`scolia-board-card ${isConfigured ? "configured" : ""}`}>
    <div className="scolia-board-head">
      <div className="board-number">{board.board_number}</div>
      <div className="row-main"><strong>{board.name || `Skive ${board.board_number}`}</strong><div className="row-meta"><span>{serial || "Ingen Scolia-ID"}</span><span>Runtime: {scolia?.connection_state || "ikke aktiv"}</span>{scolia?.board_phase && <span>Fase: {scolia.board_phase}</span>}</div></div>
      <span className={`pill ${bridgeReleased ? "warn" : statusTone}`}>{bridgeReleased ? "Frikoblet" : enabled ? (scolia?.connection_state || "Scolia") : "Manuell"}</span>
    </div>

    <div className="scolia-board-controls">
      <label className="field"><span>Scolia-ID / serienummer</span><input value={serial} onChange={(event) => setSerial(event.target.value.toUpperCase())} disabled={readOnly || Boolean(busy)} placeholder="ID fra Scolia" maxLength={120} /></label>
      <label className="field check-field"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={readOnly || Boolean(busy)} /><span>Bruk Scolia live</span></label>
      {!readOnly && <button className="button secondary small" disabled={Boolean(busy)} onClick={() => void onSave(board, serial, enabled)}>{busy === `board-${board.id}` ? "Lagrer …" : "Lagre skive"}</button>}
    </div>

    {ownership?.is_scolia && <div className={`bridge-state ${bridgeReleased ? "released" : ""}`}>
      <div><strong>{bridgeReleased ? "Frikoblet fra Blindleia" : "Blindleia kan bruke Scolia"}</strong><p>{bridgeReleased ? "Skiva kan brukes direkte i Scolia. Serienummer og skiveoppsett er beholdt." : "Frikoble før medlemmer skal bruke skiva direkte i Scolia-appen."}</p></div>
      {ownership.can_change_bridge
        ? <button className="button secondary small" disabled={Boolean(busy)} onClick={() => void onBridge(board, ownership)}>{bridgeReleased ? "Koble til Blindleia" : "Frikoble Scolia"}</button>
        : <span className="pill">Endres i PROD</span>}
    </div>}

    {isConfigured && <div className="runtime-strip">
      <div><span>Tilkobling</span><strong>{scolia?.connection_state || "—"}</strong></div>
      <div><span>Scolia-status</span><strong>{scolia?.board_status || "—"}</strong></div>
      <div><span>Siste event</span><strong>{formatDate(scolia?.last_event_at)}</strong></div>
      <div><span>Avstemming</span><strong>{reconcile ? "Påkrevd" : "OK"}</strong></div>
    </div>}

    {hasRuntime && enabled && !bridgeReleased && <div className="row-actions runtime-actions-v2">
      <button className="button secondary small" disabled={Boolean(busy)} onClick={() => void onRuntime(board, "fallback")}>Manuell fallback</button>
      <button className="button secondary small" disabled={Boolean(busy)} onClick={() => void onRuntime(board, "reset-phase")}>Reset fase</button>
      {(fallback || reconcile) && <button className="button small" disabled={Boolean(busy)} onClick={() => void onRuntime(board, "resume")}>Avstemt – gjenoppta</button>}
    </div>}
    {scolia?.last_disconnect_reason && <p className="scolia-footnote">Siste frakobling: {scolia.last_disconnect_reason}</p>}
  </article>;
}

function IncidentList({ items, busy, onResolve }: { items: ScoliaIncident[]; busy: string; onResolve: (item: ScoliaIncident) => Promise<unknown> }) {
  return <div className="scolia-op-card"><h3>Åpne avvik</h3>{items.length === 0 ? <p className="muted-copy">Ingen åpne Scolia-avvik.</p> : <div className="equipment-list">{items.map((item) => <article className="incident-v2" key={item.id}><div><strong>{item.summary || item.category || `Avvik #${item.id}`}</strong><div className="row-meta"><span>{item.board_number ? `Skive ${item.board_number}` : "Klubb"}</span><span>{item.severity || "info"}</span><span>{formatDate(item.last_seen_at)}</span><span>{Number(item.occurrence_count || 1)}x</span></div>{item.details && <p>{item.details}</p>}</div><button className="button secondary small" disabled={Boolean(busy)} onClick={() => void onResolve(item)}>Løst</button></article>)}</div>}</div>;
}

function FailedEventList({ items, busy, onRetry }: { items: ScoliaFailedEvent[]; busy: string; onRetry: (item: ScoliaFailedEvent) => Promise<unknown> }) {
  return <div className="scolia-op-card"><h3>Eventer som trenger hjelp</h3>{items.length === 0 ? <p className="muted-copy">Ingen failed/dead-letter-eventer.</p> : <div className="equipment-list">{items.map((item) => <article className="incident-v2" key={item.id}><div><strong>#{item.id} · {item.event_type || "event"}</strong><div className="row-meta"><span>Skive {item.board_number || "—"}</span><span>{item.processing_status || "failed"}</span><span>Forsøk {Number(item.attempt_count || 0)}</span></div>{item.last_error && <p>{item.last_error}</p>}</div>{item.processing_status === "dead_letter" && <button className="button small" disabled={Boolean(busy)} onClick={() => void onRetry(item)}>Prøv igjen</button>}</article>)}</div>}</div>;
}
