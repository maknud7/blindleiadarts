const API_ROOT = "../api/v1";
const host = document.getElementById("tournaments");

if (host) {
  let context = window.__bdTournamentContext || null;
  let detail = null;
  let detailRequest = 0;
  const autoOpenedCheckin = new Set();

  function token() {
    return localStorage.getItem("bd:token") || "";
  }

  function cleanupLegacyUi() {
    document.getElementById("tournamentRoom")?.remove();
    document.getElementById("tournamentRoomEmpty")?.remove();
    document.getElementById("adminOverviewNext")?.remove();
    host.classList.remove("tournament-room-ready");
    host.querySelectorAll(".tournament-room-view-hidden").forEach((node) => {
      node.classList.remove("tournament-room-view-hidden");
    });

    // Older cached module paths could mount the create button twice. There must
    // only be one entry point for creating a tournament.
    const createButtons = [...host.querySelectorAll('[id="twOpen"]')];
    createButtons.slice(1).forEach((button) => button.remove());
  }

  async function tournamentDetail(id) {
    const headers = token() ? { Authorization: `Bearer ${token()}` } : {};
    const response = await fetch(`${API_ROOT}/tournaments/${id}`, { headers, cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) return null;
    return payload.data?.tournament || null;
  }

  function registrations() {
    return Array.isArray(detail?.registrations) ? detail.registrations : [];
  }

  function pendingRegistrations() {
    return registrations().filter((registration) => String(registration.status) === "registered");
  }

  function isFinished() {
    return ["completed", "archived"].includes(String(detail?.status || context?.status || ""));
  }

  function isStarted() {
    return String(detail?.status || context?.status || "") === "in_progress";
  }

  function ensureCheckinNote() {
    const stage = document.getElementById("tcStageCheckin");
    const list = document.getElementById("tcRegistrations");
    if (!stage || !list) return;

    let note = document.getElementById("tcLateCheckinNote");
    if (!isStarted() || isFinished()) {
      note?.remove();
      return;
    }

    if (!note) {
      note = document.createElement("div");
      note.id = "tcLateCheckinNote";
      note.className = "tc-attendance-note";
      list.before(note);
    }
    note.innerHTML = `<strong>Oppmøte kan fortsatt korrigeres</strong><span>Turneringen er i gang. Du kan sjekke inn spillere som allerede er påmeldt, mens deltakerfelt og format fortsatt er låst.</span>`;
  }

  function decorateRegistrationRows() {
    cleanupLegacyUi();
    ensureCheckinNote();
    if (isFinished()) return;

    const pendingById = new Set(pendingRegistrations().map((registration) => Number(registration.player_id)));
    host.querySelectorAll('.tc-registration[data-status="registered"]').forEach((row) => {
      const playerId = Number(row.dataset.playerId || 0);
      if (!playerId || (pendingById.size && !pendingById.has(playerId))) return;
      if (row.querySelector(".tc-checkin")) return;

      const actions = document.createElement("div");
      actions.className = "tc-row-actions tc-late-checkin-actions";
      actions.innerHTML = `<button type="button" class="button tc-checkin" data-player-id="${playerId}">Sjekk inn</button>`;
      row.appendChild(actions);
    });
  }

  function maybeOpenCheckin() {
    const id = Number(context?.id || detail?.id || 0);
    if (!id || !isStarted() || !pendingRegistrations().length) return;
    if (autoOpenedCheckin.has(id)) return;
    autoOpenedCheckin.add(id);

    if (String(context?.view || "") !== "checkin") {
      document.querySelector('[data-tc-view="checkin"]')?.click();
    }
  }

  async function sync(nextContext = context) {
    context = nextContext || context;
    cleanupLegacyUi();
    const id = Number(context?.id || document.getElementById("tcTournament")?.value || 0);
    if (!id) return;

    const request = ++detailRequest;
    const nextDetail = await tournamentDetail(id).catch(() => null);
    if (request !== detailRequest) return;
    detail = nextDetail;

    maybeOpenCheckin();
    window.requestAnimationFrame(decorateRegistrationRows);
  }

  const style = document.createElement("style");
  style.id = "tournamentCanonicalUxStyles";
  style.textContent = `
    .tc-attendance-note{display:grid;gap:3px;margin:0 0 10px;padding:11px 13px;border:1px solid #c8ddeb;border-radius:12px;background:#f2f8fc;color:var(--text)}
    .tc-attendance-note strong{font-size:13px}.tc-attendance-note span{font-size:12px;line-height:1.4;color:var(--muted)}
    .tc-late-checkin-actions{margin-left:auto}
  `;
  document.head.appendChild(style);

  const registrationsRoot = document.getElementById("tcRegistrations");
  if (registrationsRoot) {
    new MutationObserver(() => decorateRegistrationRows())
      .observe(registrationsRoot, { childList: true });
  }

  window.addEventListener("bd:tournament-context", (event) => sync(event.detail));
  window.addEventListener("bd:tournament-tools-ready", cleanupLegacyUi);
  window.addEventListener("bd:portal-view", (event) => {
    if (event.detail?.target === "tournaments") {
      cleanupLegacyUi();
      sync().catch(() => undefined);
    }
  });

  [0, 120, 450, 1100].forEach((delay) => window.setTimeout(cleanupLegacyUi, delay));
  sync().catch(() => undefined);
}
