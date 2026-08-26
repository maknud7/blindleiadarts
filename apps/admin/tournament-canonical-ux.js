const API_ROOT = "../api/v1";
const host = document.getElementById("tournaments");
const MIN_PLAYERS = 4;

if (host) {
  let context = window.__bdTournamentContext || null;
  let detail = null;
  let detailRequest = 0;
  let applyQueued = false;

  function token() {
    return localStorage.getItem("bd:token") || "";
  }

  function currentTournamentId() {
    return Number(context?.id || detail?.id || document.getElementById("tcTournament")?.value || 0);
  }

  function registrations() {
    return Array.isArray(detail?.registrations) ? detail.registrations : [];
  }

  function pendingRegistrations() {
    return registrations().filter((registration) => String(registration.status) === "registered");
  }

  function checkedRegistrations() {
    return registrations().filter((registration) => String(registration.status) === "checked_in");
  }

  function tournamentStatus() {
    return String(detail?.status || context?.status || "");
  }

  function attendanceClosed() {
    return ["ready", "in_progress", "completed", "archived"].includes(tournamentStatus());
  }

  function isStarted() {
    return ["in_progress", "completed", "archived"].includes(tournamentStatus());
  }

  async function api(path, { method = "GET", body } = {}) {
    const headers = token() ? { Authorization: `Bearer ${token()}` } : {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${API_ROOT}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      const error = new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
      error.code = payload?.error?.code || "request_failed";
      throw error;
    }
    return payload.data;
  }

  function show(message, tone = "success") {
    const root = document.getElementById("tcMessage");
    if (!root) return;
    root.textContent = message;
    root.className = `message ${tone}`;
  }

  function setText(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
  }

  function setHtml(node, value) {
    if (node && node.innerHTML !== value) node.innerHTML = value;
  }

  function cleanupLegacyUi() {
    document.getElementById("tournamentRoom")?.remove();
    document.getElementById("tournamentRoomEmpty")?.remove();
    document.getElementById("adminOverviewNext")?.remove();
    host.classList.remove("tournament-room-ready");
    host.querySelectorAll(".tournament-room-view-hidden").forEach((node) => node.classList.remove("tournament-room-view-hidden"));

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
    const response = await fetch(`${API_ROOT}/tournaments/${id}`, {
      headers: token() ? { Authorization: `Bearer ${token()}` } : {},
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) return null;
    return payload.data?.tournament || null;
  }

  function simplifyStaticCopy() {
    const panelIntro = host.querySelector(":scope > .panel-head .muted");
    setText(panelIntro, "Opprett og gjennomfør turneringen fra innsjekk til resultat.");

    setText(host.querySelector('[data-tc-view="format"] b'), "Format og start");
    setText(document.querySelector("#tcStageCheckin .tc-stage-head h3"), "Hvem er her?");

    document.querySelector("#tcStageFormat .tc-stage-head .muted")?.remove();
    document.querySelector("#tcStageLive .tc-stage-head .muted")?.remove();
    document.querySelector("#tcStageAfter .tc-stage-head .muted")?.remove();

    const drawMeta = document.getElementById("tcDrawMeta");
    if (drawMeta && drawMeta.textContent.includes("seed")) setText(drawMeta, "Grupper trukket");

    const flowCopy = document.querySelector("#tcFlowStatus > p.muted");
    if (flowCopy) {
      const text = flowCopy.textContent || "";
      if (text.includes("Påmelding åpen")) setText(flowCopy, "Påmelding åpen");
      if (text.includes("Påmelding stengt")) setText(flowCopy, "Påmelding stengt");
    }
  }

  function installGuestForm() {
    const oldButton = document.getElementById("tcAddPlayer");
    const disclosure = oldButton?.closest("details.tc-disclosure") || document.getElementById("tcGuestDisclosure");
    if (!disclosure || disclosure.dataset.guestFlow === "1") return;

    disclosure.id = "tcGuestDisclosure";
    disclosure.dataset.guestFlow = "1";
    disclosure.innerHTML = `
      <summary>Legg til gjest</summary>
      <div class="tc-disclosure-body">
        <div class="tc-guest-form">
          <label><span>Fornavn</span><input id="tcGuestFirstName" autocomplete="given-name" maxlength="120"></label>
          <label><span>Etternavn</span><input id="tcGuestLastName" autocomplete="family-name" maxlength="120"></label>
          <button id="tcGuestAdd" type="button" class="button secondary">Legg til og sjekk inn</button>
        </div>
      </div>`;

    document.getElementById("tcGuestAdd")?.addEventListener("click", addGuest);
  }

  async function addGuest() {
    const id = currentTournamentId();
    if (!id || attendanceClosed()) return;
    const first = String(document.getElementById("tcGuestFirstName")?.value || "").trim();
    const last = String(document.getElementById("tcGuestLastName")?.value || "").trim();
    if (!first || !last) {
      show("Fyll inn både fornavn og etternavn.", "warning");
      return;
    }

    const button = document.getElementById("tcGuestAdd");
    if (!button) return;
    button.disabled = true;
    try {
      const data = await api(`/tournaments/${id}/registrations/guest`, {
        method: "POST",
        body: { first_name: first, last_name: last },
      });
      const name = data.registration?.display_name || `${first} ${last}`;
      const firstInput = document.getElementById("tcGuestFirstName");
      const lastInput = document.getElementById("tcGuestLastName");
      if (firstInput) firstInput.value = "";
      if (lastInput) lastInput.value = "";
      document.getElementById("tcGuestDisclosure")?.removeAttribute("open");
      show(`${name} er lagt til og sjekket inn.`, "success");
      document.getElementById("tcRefresh")?.click();
      window.setTimeout(() => sync().catch(() => undefined), 180);
    } catch (error) {
      show(error.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  function simplifyCheckinSettings() {
    const settings = document.getElementById("tcCheckinSettings");
    if (!settings) return;

    setText(settings.querySelector("summary > span"), "Innsjekk");
    settings.querySelector(".tc-disclosure-body > p.muted")?.remove();
    document.getElementById("tcCheckinEffective")?.classList.add("hidden");
    document.getElementById("tcCheckinCloses")?.closest("label")?.classList.add("hidden");
    setText(document.getElementById("tcCheckinOpens")?.closest("label")?.querySelector("span"), "Innsjekk åpner");
    setText(document.querySelector("#tcCheckinCodeBox small"), "Innsjekk-kode");
  }

  function rewriteRecommendation() {
    const root = document.getElementById("tcRecommendation");
    if (!root) return;
    const checked = checkedRegistrations().length;
    if (checked < MIN_PLAYERS) {
      setHtml(root, `<div class="tc-recommendation-icon">${checked}</div><div><strong>Minst ${MIN_PLAYERS} spillere</strong></div>`);
      return;
    }
    root.querySelector("p.muted")?.remove();
    setText(root.querySelector("p.eyebrow"), "Forslag");
  }

  function rewriteStartArea() {
    const checked = checkedRegistrations().length;
    const warning = document.getElementById("tcStartWarning");
    if (!warning) return;

    if (isStarted()) {
      setHtml(warning, `<strong>Turneringen er i gang</strong>`);
    } else if (tournamentStatus() === "ready") {
      setHtml(warning, `<strong>${checked} spillere er klare</strong>`);
    } else {
      setHtml(warning, `<strong>Avslutt innsjekken først</strong>`);
    }
  }

  function enforceAttendanceState() {
    const workspace = host.querySelector(".tc-workspace");
    workspace?.classList.toggle("tc-no-selection", !detail?.id);

    installGuestForm();
    simplifyStaticCopy();
    simplifyCheckinSettings();
    rewriteRecommendation();
    rewriteStartArea();

    const checked = checkedRegistrations().length;
    const pending = pendingRegistrations().length;
    const status = tournamentStatus();
    const draft = status === "draft";
    const ready = status === "ready";

    const toFormat = document.getElementById("tcToFormat");
    if (toFormat) {
      toFormat.disabled = !draft || checked < MIN_PLAYERS;
      if (draft && checked >= MIN_PLAYERS) {
        setText(toFormat, pending > 0 ? `Gå videre med ${checked} spillere` : "Gå videre til format");
      } else if (draft) {
        setText(toFormat, `Minst ${MIN_PLAYERS} spillere`);
      } else {
        setText(toFormat, "Innsjekk avsluttet");
      }
    }

    setText(
      document.getElementById("tcNextTitle"),
      draft ? (checked >= MIN_PLAYERS ? `${checked} spillere er klare` : "Sjekk inn spillerne") : "Innsjekken er avsluttet"
    );
    setText(
      document.getElementById("tcNextText"),
      draft
        ? (checked >= MIN_PLAYERS ? "Du kan gå videre når oppmøtet er klart." : `Du trenger minst ${MIN_PLAYERS} spillere.`)
        : `${checked} spillere er med i turneringen.`
    );

    const start = document.getElementById("tcStart");
    if (start && !isStarted()) {
      start.disabled = !ready || checked < MIN_PLAYERS;
      setText(start, ready ? `Start turnering med ${checked} spillere` : "Start turnering");
    }

    const formatNav = host.querySelector('[data-tc-view="format"]');
    if (formatNav) formatNav.disabled = !detail?.id || draft;

    if (attendanceClosed()) {
      host.querySelectorAll(".tc-checkin,.tc-remove").forEach((button) => button.remove());
      document.getElementById("tcGuestDisclosure")?.classList.add("hidden");
      document.getElementById("tcCheckinSettings")?.classList.add("hidden");
    } else {
      document.getElementById("tcGuestDisclosure")?.classList.remove("hidden");
      document.getElementById("tcCheckinSettings")?.classList.remove("hidden");
    }

    let note = document.getElementById("tcStartedCheckinNote");
    const list = document.getElementById("tcRegistrations");
    if (attendanceClosed() && list) {
      if (!note) {
        note = document.createElement("div");
        note.id = "tcStartedCheckinNote";
        note.className = "tc-attendance-note";
        list.before(note);
      }
      setHtml(note, `<strong>Innsjekken er avsluttet</strong><span>${checked} spillere er med.</span>`);
    } else {
      note?.remove();
    }

    if (ready && String(context?.view || "checkin") === "checkin") {
      window.setTimeout(() => {
        const formatButton = host.querySelector('[data-tc-view="format"]');
        if (!formatButton) return;
        formatButton.disabled = false;
        formatButton.click();
      }, 0);
    }
  }

  async function finishCheckin(event) {
    const id = currentTournamentId();
    if (!id || tournamentStatus() !== "draft") return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const checked = checkedRegistrations().length;
    if (checked < MIN_PLAYERS) {
      show(`Minst ${MIN_PLAYERS} spillere må være sjekket inn.`, "warning");
      return;
    }

    const button = document.getElementById("tcToFormat");
    if (!button) return;
    button.disabled = true;
    setText(button, "Avslutter innsjekk …");
    try {
      const data = await api(`/tournaments/${id}/finish-checkin`, { method: "POST" });
      const noShows = Number(data.attendance?.no_show_count || 0);
      show(noShows ? `${checked} spillere er med. ${noShows} er markert som ikke møtt.` : `${checked} spillere er med.`, "success");
      context = { ...(context || {}), id, status: "ready", view: "checkin" };
      await sync(context);
      window.requestAnimationFrame(() => {
        const formatButton = host.querySelector('[data-tc-view="format"]');
        if (!formatButton) return;
        formatButton.disabled = false;
        formatButton.click();
      });
    } catch (error) {
      show(error.message, "error");
      button.disabled = false;
      enforceAttendanceState();
    }
  }

  function bindFlowActions() {
    const toFormat = document.getElementById("tcToFormat");
    if (toFormat && toFormat.dataset.canonicalBound !== "1") {
      toFormat.dataset.canonicalBound = "1";
      toFormat.addEventListener("click", finishCheckin, true);
    }

    const start = document.getElementById("tcStart");
    if (start && start.dataset.noPopupBound !== "1") {
      start.dataset.noPopupBound = "1";
      start.addEventListener("click", () => {
        if (tournamentStatus() !== "ready" || checkedRegistrations().length < MIN_PLAYERS) return;
        const original = window.confirm;
        const accept = () => true;
        window.confirm = accept;
        window.setTimeout(() => {
          if (window.confirm === accept) window.confirm = original;
        }, 0);
      }, true);
    }
  }

  function queueApply() {
    if (applyQueued) return;
    applyQueued = true;
    window.requestAnimationFrame(() => {
      applyQueued = false;
      cleanupLegacyUi();
      bindFlowActions();
      enforceAttendanceState();
    });
  }

  async function sync(nextContext = context) {
    context = nextContext || context;
    cleanupLegacyUi();
    const id = currentTournamentId();
    if (!id) {
      detail = null;
      queueApply();
      return;
    }

    const request = ++detailRequest;
    const nextDetail = await tournamentDetail(id).catch(() => null);
    if (request !== detailRequest) return;
    detail = nextDetail;
    context = { ...(context || {}), status: detail?.status || context?.status || "" };
    queueApply();
  }

  const style = document.createElement("style");
  style.id = "tournamentCanonicalUxStyles";
  style.textContent = `
    .tc-room-head{display:none!important}
    .tc-no-selection .tc-phase-nav,.tc-no-selection .tc-stage,.tc-no-selection .tc-desktop-rail{display:none!important}
    .tc-no-selection .tc-desktop-grid{grid-template-columns:minmax(0,1fr)!important}
    .tc-attendance-note{display:grid;gap:3px;margin:0 0 10px;padding:11px 13px;border:1px solid #c8ddeb;border-radius:12px;background:#f2f8fc;color:var(--text)}
    .tc-attendance-note strong{font-size:13px}.tc-attendance-note span{font-size:12px;line-height:1.4;color:var(--muted)}
    .tc-guest-form{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:10px;align-items:end}
    .tc-guest-form label{display:grid;gap:5px}.tc-guest-form .button{min-height:42px;white-space:nowrap}
    @media(max-width:760px){.tc-guest-form{grid-template-columns:1fr}.tc-guest-form .button{width:100%}}
  `;
  document.head.appendChild(style);

  const observer = new MutationObserver(queueApply);
  observer.observe(host, { childList: true, subtree: true });

  window.addEventListener("bd:tournament-context", (event) => sync(event.detail));
  window.addEventListener("bd:tournament-tools-ready", () => {
    cleanupLegacyUi();
    queueApply();
  });
  window.addEventListener("bd:portal-view", (event) => {
    if (event.detail?.target === "tournaments") sync().catch(() => undefined);
  });

  [0, 120, 450, 1100].forEach((delay) => window.setTimeout(queueApply, delay));
  sync().catch(() => undefined);
}
