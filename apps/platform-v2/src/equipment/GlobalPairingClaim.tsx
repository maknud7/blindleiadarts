import { useEffect, useMemo, useState } from "react";
import { legacyApi } from "../shared/api";
import type { Board, Club } from "../shared/types";

type PairingInfoResponse = {
  request: {
    request_code: string;
    device_name?: string | null;
    status: string;
    claimable?: boolean;
    expires_at?: string | null;
  };
};

type Props = {
  code: string;
  token: string;
  clubs: Club[];
  currentClubId: number;
  boards: Board[];
  onClubChange: (clubId: number) => Promise<void>;
  onClaimed: (board: Board) => Promise<void>;
  onCancel: () => void;
};

function text(error: unknown): string {
  return error instanceof Error ? error.message : "Ukjent feil";
}

function normalize(value: string): string {
  return value.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

export function GlobalPairingClaim({ code, token, clubs, currentClubId, boards, onClubChange, onClaimed, onCancel }: Props) {
  const multiClub = clubs.length > 1;
  const [clubId, setClubId] = useState(multiClub ? 0 : Number(clubs[0]?.id || currentClubId || 0));
  const [boardId, setBoardId] = useState(0);
  const [info, setInfo] = useState<PairingInfoResponse["request"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const normalizedCode = useMemo(() => normalize(code), [code]);
  const activeBoards = useMemo(() => boards.filter((board) => Number(board.is_active ?? 1) === 1 && !board.is_paired), [boards]);

  useEffect(() => {
    if (!multiClub && clubs[0] && Number(clubs[0].id) !== currentClubId) void onClubChange(Number(clubs[0].id));
  }, [multiClub, clubs, currentClubId, onClubChange]);

  useEffect(() => {
    if (!clubId || !normalizedCode) {
      setInfo(null);
      setBoardId(0);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setError("");
    void legacyApi<PairingInfoResponse>(`kiosk-pairing.php?action=admin-info&club_id=${encodeURIComponent(clubId)}&code=${encodeURIComponent(normalizedCode)}`, { token })
      .then((data) => {
        if (cancelled) return;
        setInfo(data.request);
        setBoardId(0);
      })
      .catch((cause) => {
        if (!cancelled) {
          setInfo(null);
          setError(text(cause));
        }
      })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [clubId, normalizedCode, token]);

  async function chooseClub(value: number) {
    setClubId(value);
    setInfo(null);
    setBoardId(0);
    setError("");
    if (value) await onClubChange(value);
  }

  async function claim() {
    if (!clubId || !boardId || !normalizedCode || busy) return;
    const board = activeBoards.find((item) => Number(item.id) === boardId);
    if (!board) return;
    setBusy(true);
    setError("");
    try {
      await legacyApi(`kiosk-pairing.php?action=claim&club_id=${encodeURIComponent(clubId)}`, {
        method: "POST",
        token,
        body: { code: normalizedCode, kiosk_id: boardId },
      });
      await onClaimed(board);
    } catch (cause) {
      setError(text(cause));
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel pairing-claim-card">
    <div className="panel-head">
      <div><span className="section-label">Koble nettbrett</span><h2>Terminal {normalizedCode}</h2><p>QR-koden tilhører ikke en klubb. Velg først klubben, deretter skiva nettbrettet står ved.</p></div>
      <button className="button secondary small" disabled={busy} onClick={onCancel}>Avbryt</button>
    </div>
    <div className="pairing-claim-steps">
      <label className="field"><span>1. Klubb</span><select value={clubId} disabled={busy || !multiClub} onChange={(event) => void chooseClub(Number(event.target.value))}>{multiClub && <option value="0">Velg klubb …</option>}{clubs.map((club) => <option key={club.id} value={club.id}>{club.name}</option>)}</select></label>
      <label className="field"><span>2. Skive</span><select value={boardId} disabled={busy || !clubId || !info?.claimable} onChange={(event) => setBoardId(Number(event.target.value))}><option value="0">Velg skive …</option>{activeBoards.map((board) => <option key={board.id} value={board.id}>Skive {board.board_number} · {board.name}</option>)}</select></label>
      <button className="button" disabled={busy || !boardId || !info?.claimable} onClick={() => void claim()}>{busy ? "Kontrollerer …" : "Koble nettbrett"}</button>
    </div>
    {clubId && !busy && info?.claimable && <div className="notice good"><strong>{info.device_name || "Nettbrett"} er klart.</strong> Velg riktig fysisk skive.</div>}
    {clubId && !busy && info && !info.claimable && <div className="notice warn">Denne koden kan ikke lenger brukes. Lag en ny kode på nettbrettet.</div>}
    {clubId && !busy && activeBoards.length === 0 && !error && <div className="notice warn">Klubben har ingen ledige aktive skiver. Koble fra eksisterende nettbrett på skiva først hvis det skal erstattes.</div>}
    {error && <div className="notice bad">{error}</div>}
  </section>;
}
