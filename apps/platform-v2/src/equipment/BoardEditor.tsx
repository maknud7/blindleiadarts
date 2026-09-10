import { FormEvent, useEffect, useState } from "react";
import { api } from "../shared/api";
import type { Board, EquipmentScope } from "../shared/types";

type Props = {
  board: Board;
  clubId: number;
  token: string;
  readOnly: boolean;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
};

type UpdateResponse = EquipmentScope & { kiosk: Board };

function text(error: unknown): string {
  return error instanceof Error ? error.message : "Ukjent feil";
}

export function BoardEditor({ board, clubId, token, readOnly, onClose, onSaved }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (readOnly || busy) return;
    const form = new FormData(event.currentTarget);
    const boardNumber = Number(form.get("board_number") || 0);
    const name = String(form.get("name") || "").trim();
    if (!Number.isInteger(boardNumber) || boardNumber < 1) {
      setError("Skivenummer må være et heltall større enn 0.");
      return;
    }
    if (!name) {
      setError("Skiva må ha et visningsnavn.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      await api<UpdateResponse>(`/clubs/${clubId}/kiosks/${board.id}`, {
        method: "PATCH",
        token,
        body: {
          board_number: boardNumber,
          name,
          sponsor_label: String(form.get("sponsor_label") || "").trim() || null,
          sponsor_logo_url: String(form.get("sponsor_logo_url") || "").trim() || null,
        },
      });
      await onSaved();
      onClose();
    } catch (cause) {
      setError(text(cause));
    } finally {
      setBusy(false);
    }
  }

  return <div className="board-editor-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) onClose();
  }}>
    <section className="board-editor-card" role="dialog" aria-modal="true" aria-labelledby="board-editor-title">
      <div className="panel-head board-editor-head">
        <div>
          <span className="pill">Skive {board.board_number}</span>
          <h2 id="board-editor-title">{readOnly ? "Skivedetaljer" : "Rediger skive"}</h2>
          <p>Fysisk masterdata. Scolia-serienummer, scoring og bridge-eierskap styres i Scolia-panelet.</p>
        </div>
        <button type="button" className="button secondary small" disabled={busy} onClick={onClose}>Lukk</button>
      </div>

      {readOnly && <div className="notice warn"><strong>TEST er skrivebeskyttet.</strong> Verdiene under kommer fra canonical PROD-utstyr.</div>}
      {error && <div className="notice bad">{error}</div>}

      <form onSubmit={submit}>
        <div className="form-grid">
          <label className="field"><span>Skivenummer</span><input name="board_number" type="number" min="1" defaultValue={board.board_number} disabled={readOnly || busy} required /></label>
          <label className="field"><span>Skivekode</span><input value={board.code || ""} readOnly disabled /></label>
          <label className="field wide"><span>Visningsnavn</span><input name="name" maxLength={120} defaultValue={board.name || `Skive ${board.board_number}`} disabled={readOnly || busy} required /></label>
          <label className="field wide"><span>Sponsor / presentert av</span><input name="sponsor_label" maxLength={150} defaultValue={board.sponsor_label || ""} disabled={readOnly || busy} /></label>
          <label className="field wide"><span>Sponsorlogo (URL)</span><input name="sponsor_logo_url" type="url" maxLength={255} defaultValue={board.sponsor_logo_url || ""} disabled={readOnly || busy} placeholder="https://…" /></label>
        </div>

        <div className="board-editor-summary">
          <div><span>Scoring</span><strong>{board.scoring_mode === "scolia" ? "Scolia" : "Manuell"}</strong></div>
          <div><span>Terminal</span><strong>{board.is_paired ? board.paired_device_name || "Paret" : "Ikke paret"}</strong></div>
          <div><span>Register</span><strong>Canonical PROD</strong></div>
        </div>

        {!readOnly && <div className="form-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Avbryt</button><button className="button" disabled={busy}>{busy ? "Lagrer …" : "Lagre skive"}</button></div>}
      </form>
    </section>
  </div>;
}
