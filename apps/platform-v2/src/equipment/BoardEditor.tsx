import { FormEvent, useEffect, useMemo, useState } from "react";
import { api, legacyApi } from "../shared/api";
import type { Board, EquipmentScope, ScoliaBoard, ScoliaBridgeState } from "../shared/types";

type Props = {
  board: Board;
  clubId: number;
  token: string;
  readOnly: boolean;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
};

type UpdateResponse = EquipmentScope & { kiosk: Board };
type ScoliaResponse = EquipmentScope & { board?: ScoliaBoard | null };
type BridgeResponse = { board: ScoliaBridgeState; changed?: boolean; message?: string };

const SERIAL_PATTERN = /^[A-Za-z0-9._:-]{3,120}$/;

function text(error: unknown): string {
  return error instanceof Error ? error.message : "Ukjent feil";
}

function yes(value: unknown): boolean {
  return value === true || Number(value || 0) === 1;
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("nb-NO", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function bridgeUrl(clubId: number, boardId: number): string {
  return `scolia-bridge-control.php?club_id=${encodeURIComponent(clubId)}&kiosk_id=${encodeURIComponent(boardId)}`;
}

export function BoardEditor({ board, clubId, token, readOnly, onClose, onSaved }: Props) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [scolia, setScolia] = useState<ScoliaBoard | null>(null);
  const [bridge, setBridge] = useState<ScoliaBridgeState | null>(null);
  const [scoring, setScoring] = useState<"manual" | "scolia">(board.scoring_mode === "scolia" ? "scolia" : "manual");
  const [loadingScolia, setLoadingScolia] = useState(true);

  const pairedName = String(board.paired_device_name || "");
  const testTerminal = Boolean(board.is_paired) && pairedName.startsWith("Testmodus ·");
  const runtimeNeedsAttention = yes(scolia?.fallback_active) || yes(scolia?.needs_reconciliation);
  const runtimeLabel = useMemo(() => {
    if (!scolia) return "Ingen status ennå";
    const parts = [
      scolia.connection_state ? `Tilkobling: ${scolia.connection_state}` : null,
      scolia.board_status ? `Scolia: ${scolia.board_status}` : null,
      scolia.board_phase ? `fase: ${scolia.board_phase}` : null,
      yes(scolia.needs_reconciliation) ? "må avstemmes" : null,
    ].filter(Boolean);
    return parts.join(" · ") || "Ingen status ennå";
  }, [scolia]);

  async function loadScolia() {
    setLoadingScolia(true);
    try {
      const [scoliaResult, bridgeResult] = await Promise.allSettled([
        api<ScoliaResponse>(`/clubs/${clubId}/kiosks/${board.id}/scolia`, { token }),
        legacyApi<BridgeResponse>(bridgeUrl(clubId, board.id), { token }),
      ]);
      if (scoliaResult.status === "fulfilled") {
        const next = scoliaResult.value.board || null;
        setScolia(next);
        setScoring((next?.mode === "live" || board.scoring_mode === "scolia") ? "scolia" : "manual");
      }
      if (bridgeResult.status === "fulfilled") setBridge(bridgeResult.value.board);
    } finally {
      setLoadingScolia(false);
    }
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    void loadScolia();
    return () => window.removeEventListener("keydown", onKey);
  }, [board.id, clubId, token]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (readOnly || busy) return;
    const form = new FormData(event.currentTarget);
    const boardNumber = Number(form.get("board_number") || 0);
    const name = String(form.get("name") || "").trim();
    const active = form.get("is_active") === "on";
    const serial = String(form.get("scolia_serial_number") || "").trim().toUpperCase();
    if (!Number.isInteger(boardNumber) || boardNumber < 1) {
      setError("Skivenummer må være et heltall større enn 0.");
      return;
    }
    if (!name) {
      setError("Skiva må ha et visningsnavn.");
      return;
    }
    if (scoring === "scolia" && !SERIAL_PATTERN.test(serial)) {
      setError("Scolia-skiva må ha en gyldig Scolia-ID / serienummer.");
      return;
    }
    if (!active && Number(board.is_active ?? 1) === 1) {
      const confirmed = window.confirm(`Deaktivere skive ${board.board_number}? Den forsvinner fra kiosk, pairingvalg og nye kamper, men beholdes i Utstyr slik at den kan aktiveres igjen.`);
      if (!confirmed) return;
    }

    setBusy("save");
    setError("");
    setNotice("");
    try {
      await api(`/clubs/${clubId}/kiosks/${board.id}/scolia`, {
        method: "PATCH",
        token,
        body: scoring === "scolia"
          ? { serial_number: serial, mode: "live", auto_fallback_to_manual: true }
          : { mode: "off" },
      });
      await api<UpdateResponse>(`/clubs/${clubId}/kiosks/${board.id}`, {
        method: "PATCH",
        token,
        body: {
          board_number: boardNumber,
          name,
          sponsor_label: String(form.get("sponsor_label") || "").trim() || null,
          sponsor_logo_url: String(form.get("sponsor_logo_url") || "").trim() || null,
          scoring_mode: scoring,
          is_active: active ? 1 : 0,
        },
      });
      await onSaved();
      onClose();
    } catch (cause) {
      setError(text(cause));
    } finally {
      setBusy("");
    }
  }

  async function runtimeAction(action: "fallback" | "reset-phase" | "resume") {
    if (busy) return;
    if (action === "fallback" && !window.confirm("Aktivere manuell fallback for denne skiva?")) return;
    if (action === "resume" && !window.confirm("Bekrefter du at scoren er kontrollert og riktig?")) return;
    if (action === "reset-phase" && !window.confirm("Reset Scolia-fasen? Canonical score endres ikke.")) return;
    setBusy(action); setError(""); setNotice("");
    try {
      await api(`/clubs/${clubId}/kiosks/${board.id}/scolia/${action}`, {
        method: "POST",
        token,
        body: action === "resume" ? { reconciled: true } : undefined,
      });
      setNotice(action === "fallback" ? "Manuell fallback er aktivert." : action === "resume" ? "Scolia er gjenopptatt etter avstemming." : "Scolia-fasen er nullstilt.");
      await loadScolia();
    } catch (cause) {
      setError(text(cause));
    } finally {
      setBusy("");
    }
  }

  async function toggleBridge() {
    if (!bridge?.can_change_bridge || busy) return;
    const attach = bridge.bridge_released;
    const confirmed = window.confirm(attach
      ? `Koble Scolia på skive ${board.board_number} tilbake til Blindleia?`
      : `Frikoble Scolia på skive ${board.board_number} fra Blindleia slik at den kan brukes direkte i Scolia?`);
    if (!confirmed) return;
    setBusy("bridge"); setError(""); setNotice("");
    try {
      await legacyApi<BridgeResponse>(bridgeUrl(clubId, board.id), { method: "POST", token, body: { attached: attach } });
      setNotice(attach ? "Scolia er koblet tilbake til Blindleia." : "Scolia er frikoblet fra Blindleia.");
      await loadScolia();
    } catch (cause) {
      setError(text(cause));
    } finally {
      setBusy("");
    }
  }

  return <div className="board-editor-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) onClose();
  }}>
    <section className="board-editor-card" role="dialog" aria-modal="true" aria-labelledby="board-editor-title">
      <div className="panel-head board-editor-head">
        <div>
          <span className={`pill ${Number(board.is_active ?? 1) === 1 ? "good" : "warn"}`}>Skive {board.board_number} · {Number(board.is_active ?? 1) === 1 ? "Aktiv" : "Deaktivert"}</span>
          <h2 id="board-editor-title">{readOnly ? "Skivedetaljer" : "Rediger skive"}</h2>
          <p>Alt som gjelder denne skiva ligger her: scoring, Scolia, nettbrett og fysisk masterdata.</p>
        </div>
        <button type="button" className="button secondary small" disabled={Boolean(busy)} onClick={onClose}>Lukk</button>
      </div>

      {readOnly && <div className="notice warn"><strong>TEST er skrivebeskyttet for fysisk oppsett.</strong> Du ser canonical PROD-verdier her. TEST-runtime kan fortsatt styres separat.</div>}
      {error && <div className="notice bad">{error}</div>}
      {notice && <div className="notice good">{notice}</div>}

      <form onSubmit={submit}>
        <div className="form-grid">
          <label className="field"><span>Skivenummer</span><input name="board_number" type="number" min="1" defaultValue={board.board_number} disabled={readOnly || Boolean(busy)} required /></label>
          <label className="field"><span>Scoring</span><select name="scoring_mode" value={scoring} onChange={(event) => setScoring(event.target.value === "scolia" ? "scolia" : "manual")} disabled={readOnly || Boolean(busy)}><option value="manual">Manuell</option><option value="scolia">Scolia</option></select></label>
          {scoring === "scolia" && <label className="field wide"><span>Scolia-ID / serienummer</span><input name="scolia_serial_number" maxLength={120} defaultValue={scolia?.serial_number || ""} disabled={readOnly || Boolean(busy) || loadingScolia} placeholder={loadingScolia ? "Laster …" : "ID fra Scolia"} required /><small>Fysisk Scolia-ID følger denne skiva og er canonical PROD-innstilling.</small></label>}
          <label className="field wide"><span>Visningsnavn</span><input name="name" maxLength={120} defaultValue={board.name || `Skive ${board.board_number}`} disabled={readOnly || Boolean(busy)} required /></label>
          <label className="field wide"><span>Sponsor / presentert av</span><input name="sponsor_label" maxLength={150} defaultValue={board.sponsor_label || ""} disabled={readOnly || Boolean(busy)} /></label>
          <label className="field wide"><span>Sponsorlogo (URL)</span><input name="sponsor_logo_url" type="url" maxLength={255} defaultValue={board.sponsor_logo_url || ""} disabled={readOnly || Boolean(busy)} placeholder="https://…" /></label>
          <label className="field wide check-field"><input name="is_active" type="checkbox" defaultChecked={Number(board.is_active ?? 1) === 1} disabled={readOnly || Boolean(busy)} /><span>Skiva er aktiv og kan brukes til nye kamper</span></label>
        </div>

        <section className={`board-connection-card ${testTerminal ? "test-terminal" : ""}`}>
          <div><span className="section-label">Nettbrett</span><strong>{board.is_paired ? (testTerminal ? "TEST-terminal" : pairedName || "Paret nettbrett") : "Ikke paret"}</strong></div>
          <small>{board.is_paired ? `Paret ${formatDate(board.paired_at)} · sist sett ${formatDate(board.last_seen_at)}` : "Et nytt nettbrett kan kobles til denne skiva via QR/pairing fra Kiosk."}</small>
        </section>

        {scoring === "scolia" && <section className={`board-connection-card ${runtimeNeedsAttention ? "needs-attention" : ""}`}>
          <div className="board-connection-head"><div><span className="section-label">Scolia</span><strong>{scolia?.serial_number || (loadingScolia ? "Laster …" : "Ingen ID")}</strong></div><span className={`pill ${runtimeNeedsAttention ? "warn" : scolia?.connection_state === "connected" ? "good" : ""}`}>{runtimeNeedsAttention ? "Krever handling" : scolia?.connection_state || "Ukjent"}</span></div>
          <small>{runtimeLabel}</small>
          <div className="board-runtime-actions">
            <button type="button" className="button secondary small" disabled={Boolean(busy) || loadingScolia} onClick={() => void runtimeAction("fallback")}>Manuell fallback</button>
            <button type="button" className="button secondary small" disabled={Boolean(busy) || loadingScolia} onClick={() => void runtimeAction("reset-phase")}>Reset fase</button>
            {runtimeNeedsAttention && <button type="button" className="button small" disabled={Boolean(busy)} onClick={() => void runtimeAction("resume")}>Avstemt · gjenoppta</button>}
            {bridge?.can_change_bridge && <button type="button" className="button secondary small" disabled={Boolean(busy)} onClick={() => void toggleBridge()}>{bridge.bridge_released ? "Koble til Blindleia" : "Frikoble Scolia"}</button>}
          </div>
        </section>}

        {!readOnly && <div className="form-actions"><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={onClose}>Avbryt</button><button className="button" disabled={Boolean(busy)}>{busy === "save" ? "Lagrer …" : "Lagre skive"}</button></div>}
      </form>
    </section>
  </div>;
}
