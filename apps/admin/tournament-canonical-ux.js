const API_ROOT = "../api/v1";
const host = document.getElementById("tournaments");

if (host) {
  let context = window.__bdTournamentContext || null;
  let detail = null;
  let detailRequest = 0;

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

    const workspaces = [...host.querySelectorAll(":scope > .tc-workspace")];
    if (workspaces.length > 1) {
      const keep = workspaces.find((workspace) => workspace.querySelector("#tcDesktopRail")) || workspaces[0];
      workspaces.forEach((workspace) => {
        if (workspace !== keep) workspace.remove();
      });
    }

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

  function isStarted() {
    return ["in_progress", "completed", "archived"].includes(String(detail?.status || context?.status || ""));
  }

  function currentTournamentId() {
    return Number(context?.id || detail?.id || document.getElementById("tcTournament")?.value || 0);
  }

  function enforceStartedState() {
    const stage = document.getElementById("tcStageCheckin");
    const list = document.getElementById("tcRegistrations");
    if (!stage || !list) return;

    let note = document.getElementById("tcStartedCheckinNote");
    if (!isStarted()) {
      note?.remove();
      return;
    }

    host.querySelectorAll(".tc-checkin").forEach((button) => button.remove());
    document.getElementById("tcToFormat")?.setAttribute("disabled", "disabled");

    if (!note) {
      note = document.createElement("div");
      note.id = "tcStartedCheckinNote";
      note.className = "tc-attendance-note";
      list.before(note);
    }

    const pending = pendingRegistrations().length;
    note.innerHTML = pending > 0
      ? `<strong>Innsjekk er stengt</strong><span>Turneringen er startet. ${pending} tidligere påmeldte står fortsatt som ikke møtt i eldre testdata og kan ikke sjekkes inn nå.</span>`
      : `<strong>Innsjekk er stengt</strong><span>Turneringen er startet. Oppmøtet er låst for resten av turneringen.</span>`;
  }

  async function sync(nextContext = context) {
    context = nextContext || context;
    cleanupLegacyUi();
    const id = currentTournamentId();
    if (!id) return;

    const request = ++detailRequest;
    const nextDetail = await tournamentDetail(id).catch(() => null);
    if (request !== detailRequest) return;
    detail = nextDetail;
    window.requestAnimationFrame(enforceStartedState);
  }

  const style = document.createElement("style");
  style.id = "tournamentCanonicalUxStyles";
  style.textContent = `
    .tc-attendance-note{display:grid;gap:3px;margin:0 0 10px;padding:11px 13px;border:1px solid #c8ddeb;border-radius:12px;background:#f2f8fc;color:var(--text)}
    .tc-attendance-note strong{font-size:13px}.tc-attendance-note span{font-size:12px;line-height:1.4;color:var(--muted)}
  `;
  document.head.appendChild(style);

  const registrationsRoot = document.getElementById("tcRegistrations");
  if (registrationsRoot) {
    new MutationObserver(() => enforceStartedState())
      .observe(registrationsRoot, { childList: true });
  }

  window.addEventListener("bd:tournament-context", (event) => sync(event.detail));
  window.addEventListener("bd:tournament-tools-ready", () => {
    cleanupLegacyUi();
    enforceStartedState();
  });
  window.addEventListener("bd:portal-view", (event) => {
    if (event.detail?.target === "tournaments") {
      cleanupLegacyUi();
      sync().catch(() => undefined);
    }
  });

  [0, 120, 450, 1100].forEach((delay) => window.setTimeout(() => {
    cleanupLegacyUi();
    enforceStartedState();
  }, delay));
  sync().catch(() => undefined);
}
