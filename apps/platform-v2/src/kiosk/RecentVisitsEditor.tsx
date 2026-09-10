import { useMemo, useState } from "react";
import { api } from "../shared/api";
import type { KioskMatch, KioskSnapshot, Visit } from "../shared/types";

type Selection = { index: number; visitId: number };

type Props = {
  match: KioskMatch;
  kioskCode: string;
  kioskToken: string;
  editable: boolean;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onCorrected: (snapshot: KioskSnapshot) => void;
  onReload: () => Promise<void>;
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

function visitKey(visit: Visit, index: number): string {
  return `${visit.id || 0}-${visit.visit_number || index}-${index}`;
}

export function RecentVisitsEditor({ match, kioskCode, kioskToken, editable, disabled, onBusyChange, onCorrected, onReload }: Props) {
  const visits = useMemo(() => (match.recent_visits || []).slice(0, 4), [match.recent_visits]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const selectedVisit = selection ? visits[selection.index] || null : null;

  function open(index: number): void {
    if (!editable || disabled || saving) return;
    const visit = visits[index];
    if (!visit) return;
    setSelection({ index, visitId: Number(visit.id || 0) });
    setValue(String(Number(visit.score || 0)));
    setError("");
  }

  function close(): void {
    if (saving) return;
    setSelection(null);
    setError("");
  }

  function key(valueKey: string): void {
    if (saving) return;
    setError("");
    if (valueKey === "del") {
      setValue((current) => current.slice(0, -1));
      return;
    }
    setValue((current) => {
      if (current.length >= 3) return current;
      return current === "0" ? valueKey : `${current}${valueKey}`;
    });
  }

  async function save(): Promise<void> {
    if (saving || !selection) return;
    const score = Number(value || 0);
    if (!POSSIBLE_VISIT_SCORES.has(score)) {
      setError("Denne summen kan ikke oppnås med tre piler.");
      return;
    }

    const currentVisits = (match.recent_visits || []).slice(0, 4);
    const target = currentVisits[selection.index];
    if (!target || Number(target.id || 0) !== selection.visitId) {
      setError("Kampen har endret seg. Lukk og åpne kastet på nytt.");
      return;
    }

    const newerChronological = currentVisits.slice(0, selection.index).reverse();
    setSaving(true);
    onBusyChange(true);
    setError("Oppdaterer kast …");

    try {
      let snapshot: KioskSnapshot | null = null;
      for (let index = 0; index <= selection.index; index += 1) {
        snapshot = await api<KioskSnapshot>(`/kiosks/${encodeURIComponent(kioskCode)}/undo`, {
          method: "POST",
          kioskToken,
        });
      }

      snapshot = await api<KioskSnapshot>(`/kiosks/${encodeURIComponent(kioskCode)}/visit`, {
        method: "POST",
        kioskToken,
        body: { input_mode: "sum", score, darts_used: Number(target.darts_used || 3) },
      });

      for (const visit of newerChronological) {
        snapshot = await api<KioskSnapshot>(`/kiosks/${encodeURIComponent(kioskCode)}/visit`, {
          method: "POST",
          kioskToken,
          body: {
            input_mode: "sum",
            score: Number(visit.score || 0),
            darts_used: Number(visit.darts_used || 3),
          },
        });
      }

      if (snapshot) onCorrected(snapshot);
      setSelection(null);
      setError("");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Kunne ikke oppdatere kastet.";
      setError(`${message} Kontroller siste kast før dere fortsetter.`);
      await onReload().catch(() => undefined);
    } finally {
      setSaving(false);
      onBusyChange(false);
    }
  }

  return <>
    <div className="visits recent-visits-v1-parity" aria-label="Siste kast">
      {visits.map((visit, index) => editable ? (
        <button
          type="button"
          className="visit visit-editable"
          key={visitKey(visit, index)}
          disabled={disabled || saving}
          onClick={() => open(index)}
          aria-label={`Rediger kast ${Number(visit.score || 0)} av ${visit.player_name || "spiller"}`}
        >
          <span>{visit.player_name || "Spiller"} · #{Number(visit.visit_number || 0)}</span>
          <strong>{Number(visit.score || 0)} {Number(visit.is_bust) === 1 ? "· Bust" : `→ ${Number(visit.remaining_after ?? 0)}`}</strong>
          <span className="visit-edit-icon" aria-hidden="true">✎</span>
        </button>
      ) : (
        <div className="visit" key={visitKey(visit, index)}>
          <span>{visit.player_name || "Spiller"} · #{Number(visit.visit_number || 0)}</span>
          <strong>{Number(visit.score || 0)} {Number(visit.is_bust) === 1 ? "· Bust" : `→ ${Number(visit.remaining_after ?? 0)}`}</strong>
        </div>
      ))}
      {!visits.length && <div className="empty recent-visits-empty">Ingen kast registrert ennå.</div>}
    </div>

    {selection && selectedVisit && <div className="visit-edit-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className={`visit-edit-dialog ${saving ? "is-busy" : ""}`} role="dialog" aria-modal="true" aria-label="Rediger kast">
        <div className="visit-edit-head">
          <div><span>Rediger kast</span><h2>{selectedVisit.player_name || "Spiller"}</h2></div>
          <button type="button" className="kiosk-settings-button" disabled={saving} aria-label="Lukk" onClick={close}>×</button>
        </div>
        <p className="visit-edit-meta">Kast #{Number(selectedVisit.visit_number || 0)} · {Number(selectedVisit.score || 0)} poeng · gjenstod {Number(selectedVisit.remaining_after ?? 0)}</p>
        <div className="visit-edit-display">{value || "0"}</div>
        <div className="visit-edit-keypad">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => <button type="button" key={digit} disabled={saving} onClick={() => key(digit)}>{digit}</button>)}
          <button type="button" className="secondary" disabled={saving} onClick={() => key("del")}>⌫</button>
          <button type="button" disabled={saving} onClick={() => key("0")}>0</button>
          <button type="button" className="confirm" disabled={saving} onClick={() => void save()}>✓</button>
        </div>
        <p className={`visit-edit-error ${error ? "visible" : ""}`} aria-live="polite">{error}</p>
        <p className="visit-edit-note">Kastene etter dette regnes om automatisk.</p>
      </section>
    </div>}
  </>;
}
