import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../shared/api";
import { read } from "../shared/storage";
import type { KioskSnapshot, Visit } from "../shared/types";

type EditableVisit = Visit & {
  id?: number;
  player_id?: number;
  darts_used?: number;
};

function possibleVisitScores(): Set<number> {
  const singles = new Set<number>([0, 25, 50]);
  for (let i = 1; i <= 20; i += 1) {
    singles.add(i);
    singles.add(i * 2);
    singles.add(i * 3);
  }
  const values = [...singles];
  const totals = new Set<number>();
  for (const a of values) for (const b of values) for (const c of values) totals.add(a + b + c);
  return totals;
}

const POSSIBLE_VISIT_SCORES = possibleVisitScores();

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Kunne ikke oppdatere kastet.";
}

export function RecentVisitEditor() {
  const [snapshot, setSnapshot] = useState<KioskSnapshot | null>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [selectedVisitId, setSelectedVisitId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const code = read("kioskCode");
    const token = read("kioskToken");
    if (!code || !token) {
      setSnapshot(null);
      return;
    }
    try {
      const data = await api<KioskSnapshot>(`/kiosks/${encodeURIComponent(code)}/state`, { kioskToken: token });
      setSnapshot(data);
      setTarget((current) => current?.isConnected ? current : document.querySelector<HTMLElement>(".visits"));
    } catch {
      // KioskWorkspace owns connection/error UX. This companion only owns visit correction.
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!busy && selectedIndex === null) void load();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [busy, load, selectedIndex]);

  const visits = ((snapshot?.match?.recent_visits || []) as EditableVisit[]).slice(0, 4);
  const automaticScolia = String(snapshot?.kiosk?.scoring_mode || "manual") === "scolia";

  function openEditor(index: number) {
    if (busy || automaticScolia) return;
    const visit = visits[index];
    if (!visit?.id) return;
    setSelectedIndex(index);
    setSelectedVisitId(Number(visit.id));
    setEditValue(String(Number(visit.score || 0)));
    setError("");
  }

  function editKey(key: string) {
    if (busy) return;
    setError("");
    if (key === "del") {
      setEditValue((current) => current.slice(0, -1));
      return;
    }
    setEditValue((current) => current.length >= 3 ? current : (current === "0" ? key : `${current}${key}`));
  }

  function closeEditor() {
    if (busy) return;
    setSelectedIndex(null);
    setSelectedVisitId(null);
    setEditValue("");
    setError("");
  }

  async function save() {
    if (busy || selectedIndex === null || selectedVisitId === null) return;
    const score = Number(editValue || 0);
    if (!POSSIBLE_VISIT_SCORES.has(score)) {
      setError("Denne summen kan ikke oppnås med tre piler.");
      return;
    }

    const code = read("kioskCode");
    const token = read("kioskToken");
    if (!code || !token) {
      setError("Terminalen er ikke koblet til en skive.");
      return;
    }

    setBusy(true);
    setError("Oppdaterer kast …");
    try {
      const fresh = await api<KioskSnapshot>(`/kiosks/${encodeURIComponent(code)}/state`, { kioskToken: token });
      const freshVisits = ((fresh.match?.recent_visits || []) as EditableVisit[]).slice(0, 4);
      const selected = freshVisits[selectedIndex];
      if (!selected || Number(selected.id || 0) !== selectedVisitId) {
        setError("Kampen har endret seg. Lukk og åpne kastet på nytt.");
        return;
      }

      const affected = freshVisits.slice(0, selectedIndex + 1);
      const newerChronological = affected.slice(0, selectedIndex).reverse();
      let next = fresh;

      for (let index = 0; index <= selectedIndex; index += 1) {
        next = await api<KioskSnapshot>(`/kiosks/${encodeURIComponent(code)}/undo`, {
          method: "POST",
          kioskToken: token,
        });
      }

      next = await api<KioskSnapshot>(`/kiosks/${encodeURIComponent(code)}/visit`, {
        method: "POST",
        kioskToken: token,
        body: { input_mode: "sum", score, darts_used: Number(selected.darts_used || 3) },
      });

      for (const visit of newerChronological) {
        next = await api<KioskSnapshot>(`/kiosks/${encodeURIComponent(code)}/visit`, {
          method: "POST",
          kioskToken: token,
          body: {
            input_mode: "sum",
            score: Number(visit.score || 0),
            darts_used: Number(visit.darts_used || 3),
          },
        });
      }

      setSnapshot(next);
      setSelectedIndex(null);
      setSelectedVisitId(null);
      setEditValue("");
      setError("");
      window.dispatchEvent(new CustomEvent("bd:kiosk-visit-corrected"));
    } catch (cause) {
      setError(errorText(cause));
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!target || !snapshot?.match) return null;

  const list = <div className="editable-visits-v2" aria-label="Siste fire kast">
    {visits.length ? visits.map((visit, index) => {
      const bust = Number(visit.is_bust) === 1;
      const editable = !automaticScolia && Boolean(visit.id);
      return <button
        type="button"
        className="visit visit-editable-v2"
        key={`${visit.id || visit.visit_number || index}-${index}`}
        disabled={!editable || busy}
        onClick={() => openEditor(index)}
        aria-label={editable ? `Rediger kast ${Number(visit.score || 0)} av ${visit.player_name || "spiller"}` : undefined}
      >
        <span><strong>{visit.player_name || "Spiller"}</strong><small>#{Number(visit.visit_number || 0)}</small></span>
        <span><strong>{Number(visit.score || 0)}</strong><small>{bust ? "Bust" : `→ ${Number(visit.remaining_after ?? 0)}`}</small></span>
        {editable && <span className="visit-edit-icon-v2" aria-hidden="true">✎</span>}
      </button>;
    }) : <div className="empty">Ingen kast registrert ennå.</div>}
  </div>;

  const selected = selectedIndex === null ? null : visits[selectedIndex];
  const dialog = selectedIndex !== null && selected ? <div className="visit-edit-overlay-v2" role="presentation">
    <section className="visit-edit-dialog-v2" role="dialog" aria-modal="true" aria-label="Rediger kast">
      <div className="visit-edit-head-v2">
        <div><span>Rediger kast</span><h2>{selected.player_name || "Spiller"}</h2></div>
        <button type="button" className="kiosk-settings-button" disabled={busy} onClick={closeEditor}>×</button>
      </div>
      <p>Kast #{Number(selected.visit_number || 0)} · {Number(selected.score || 0)} poeng · gjenstod {Number(selected.remaining_after ?? 0)}</p>
      <div className="visit-edit-display-v2">{editValue || "0"}</div>
      <div className="visit-edit-keypad-v2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "del", "0", "save"].map((key) => <button
          type="button"
          key={key}
          className={key === "save" ? "primary" : ""}
          disabled={busy}
          onClick={() => key === "save" ? void save() : editKey(key)}
        >{key === "del" ? "⌫" : key === "save" ? "✓" : key}</button>)}
      </div>
      <p className={error && error !== "Oppdaterer kast …" ? "visit-edit-error-v2" : "visit-edit-note-v2"}>{error || "Kastene etter dette regnes om automatisk."}</p>
    </section>
  </div> : null;

  return <>{createPortal(list, target)}{dialog && createPortal(dialog, document.body)}</>;
}
