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

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
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

    const formatNav = host.querySelector('[data-tc-view="format"] b');
    setText(formatNav, "Format og start");

    const checkinHeading = document.querySelector("#tcStageCheckin .tc-stage-head h3");
    setText(checkinHeading, "Hvem er her?");

    const formatIntro = document.querySelector("#tcStageFormat .tc-stage-head .muted");
    formatIntro?.remove();
    const liveIntro = document.querySelector("#tcStageLive .tc-stage-head .muted");
    liveIntro?.remove();
    const afterIntro = document.querySelector("#tcStageAfter .tc-stage-head .muted");
    afterIntro?.remove();

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
    button.disabled = true;
    try {
      const data = await api(`/tournaments/${id}/registrations/guest`, {
        method: "POST",
        body: { first_name: first, last_name: last },
      });
      const name = data.registration?.display_name || `${first} ${last}`;
      document.getElementById("tcGuestFirstName").value = "";
      document.getElementById("tcGuestLastName").value = "";
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

    const summaryText = settings.querySelector("summary > span");
    setText(summaryText, "Innsjekk");

    settings.querySelector(".tc-disclosure-body > p.muted")?.remove();
    document.getElementById("tcCheckinEffective")?.classList.add("hidden");

    const closes = document.getElementById("tcCheckinCloses");
    closes?.closest("label")?.classList.add("hidden");

    const opens = document.getElementById("tcCheckinOpens");
    setText(opens?.closest("label")?.querySelector("span"), "Innsjekk åpner");

    const codeLabel = document.querySelector("#tcCheckinCodeBox small");
    setText(codeLabel, "Innsjekk-kode");

    const rotate = document.getElementById("tcRotateCode");
    if (rotate && rotate.dataset.canonicalBound !== "1") {
      const clone = rotate.cloneNode(true);
      clone.dataset.canonicalBound = "1";
      rotate.replaceWith(clone);
      clone.addEventListener("click", async () => {
        const id = currentTournamentId();
        if (!id || attendanceClosed()) return;
        clone.disabled = true;
        try {
          await api(`/tournaments/${id}/checkin-code/rotate`, { method: "POST" });
          show("Ny innsjekk-kode er klar.", "success");
          document.getElementById("tcRefresh")?.click();
        } catch (error) {
          show(error.message, "error");
        } finally {
          clone.disabled = false;
        }
      });
    }
  }

  function rewriteRecommendation() {
    const root = document.getElementById("tcRecommendation");
    if (!root) return;
    const checked = checkedRegistrations().length;
    if (checked < MIN_PLAYERS) {
      root.innerHTML = `<div class="tc-recommendation-icon">${checked}</div><div><strong>Minst ${MIN_PLAYERS} spillere</strong></div>`;
      return;
    }
    root.querySelector("p.muted")?.remove();
    const eyebrow = root.querySelector("p.eyebrow");
    setText(eyebrow, "Forslag");
  }

  function rewriteStartArea() {
    const checked = checkedRegistrations().length;
    const warning = document.getElementById("tcStartWarning");
    if (warning) {
      if (isStarted()) {
        warning.innerHTML = `<strong>Turneringen er i gang</strong>`;
      } else if (tournamentStatus() === "ready") {
        warning.innerHTML = `<strong>${checked} spillere er klare</strong>`;
      } else {
        warning.innerHTML = `<strong>Avslutt innsjekken først</strong>`;
      }
    }
  }

  function enforceAttendanceState() {
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
    if (formatNav) formatNav.disabled = draft;

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
      note.innerHTML = `<strong>Innsjekken er avsluttet</strong><span>${checked} spillere er med.</span>`;
    } else {
      note?.remove();
    }

    // Ready means attendance is frozen and the operator should continue at format,
    // including after a page refresh.
    if (ready && String(context?.view || "checkin") === "checkin") {
      window.setTimeout(() => host.querySelector('[data-tc-view="format"]')?.click(), 0);
    }
  }

  async function finishCheckin(event) {
    if (event?.bdCanonicalPass === true) return;
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
    button.disabled = true;
    setText(button, "Avslutter innsjekk …");
    try {
      const data = await api(`/tournaments/${id}/finish-checkin`, { method: "POST" });
      const noShows = Number(data.attendance?.no_show_count || 0);
      show(noShows ? `${checked} spillere er med. ${noShows} er markert som ikke møtt.` : `${checked} spillere er med.`, "success");
      context = { ...(context || {}), id, status: "ready", view: "format" };
      await sync(context);
      host.querySelector('[data-tc-view="format"]')?.click();
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
        window.confirm = () => true;
        window.setTimeout(() => {
          if (window.confirm !== original) window.confirm = original;
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
