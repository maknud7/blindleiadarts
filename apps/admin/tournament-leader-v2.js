const API_ROOT = "../api/v1";
const host = document.getElementById("tournaments");
const MIN_PLAYERS = 4;
const LEADER_VERSION = "20260827-2100";

if (host) {
  host.classList.add("tc-leader-v2-active");

  const css = document.createElement("link");
  css.rel = "stylesheet";
  const cssUrl = new URL("./tournament-leader-v2.css", import.meta.url);
  cssUrl.searchParams.set("v", LEADER_VERSION);
  css.href = cssUrl.href;
  document.head.appendChild(css);

  let context = window.__bdTournamentContext || null;
  let snapshot = emptySnapshot();
  let requestId = 0;
  let refreshTimer = null;
  let pollTimer = null;
  let actionBusy = false;

  function emptySnapshot() {
    return { detail: null, plan: null, groups: [], boards: null, operations: null, playoff: null };
  }

  function token() {
    return localStorage.getItem("bd:token") || "";
  }

  function currentTournamentId() {
    return Number(context?.id || document.getElementById("tcTournament")?.value || 0);
  }

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function statusLabel(value) {
    return ({
      draft: "Innsjekk",
      ready: "Klar til start",
      in_progress: "Pågår",
      completed: "Ferdig",
      archived: "Arkivert",
    })[String(value || "")] || String(value || "—");
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(String(value).replace(" ", "T"));
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("nb-NO", {
      weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    }).format(date);
  }

  async function api(path, { method = "GET", body } = {}) {
    const headers = token() ? { Authorization: `Bearer ${token()}` } : {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${API_ROOT}${path}`, {
      method,
      headers,
      cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      const error = new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
      error.code = payload?.error?.code || "request_failed";
      throw error;
    }
    return payload.data;
  }

  async function optional(path) {
    try { return await api(path); } catch { return null; }
  }

  function ensureMount() {
    const workspace = host.querySelector(".tc-workspace");
    const main = host.querySelector(".tc-workflow-main") || workspace;
    if (!main) return null;

    let root = document.getElementById("tcLeaderV2");
    if (!root) {
      root = document.createElement("section");
      root.id = "tcLeaderV2";
      root.className = "tc-leader-v2";
      root.innerHTML = `
        <div class="tc-leader-status">
          <div class="tc-leader-context">
            <div class="tc-leader-picker-slot"></div>
            <div class="tc-leader-current">
              <span id="tcLeaderStatus" class="tc-leader-status-pill">—</span>
              <strong id="tcLeaderName">Velg turnering</strong>
              <small id="tcLeaderMeta"></small>
            </div>
            <button id="tcLeaderRefresh" type="button" class="button quiet">Oppdater</button>
          </div>
          <nav id="tcLeaderSteps" class="tc-leader-steps" aria-label="Turneringsflyt"></nav>
        </div>
        <div id="tcLeaderNext" class="tc-leader-next"></div>`;

      const contextCard = main.querySelector(".tc-context-card");
      if (contextCard) contextCard.before(root);
      else main.prepend(root);

      root.querySelector("#tcLeaderRefresh")?.addEventListener("click", () => refresh({ announce: true }));
      root.querySelector("#tcLeaderSteps")?.addEventListener("click", (event) => {
        const button = event.target.closest("[data-leader-step]");
        if (!button || button.disabled) return;
        navigate(button.dataset.leaderStep || "checkin");
      });
      root.querySelector("#tcLeaderNext")?.addEventListener("click", (event) => {
        const button = event.target.closest("[data-leader-action]");
        if (!button || button.disabled) return;
        runAction(button.dataset.leaderAction || "");
      });
    }

    const picker = document.querySelector(".tc-context-card .tc-tournament-picker");
    const slot = root.querySelector(".tc-leader-picker-slot");
    if (picker && slot && picker.parentElement !== slot) slot.appendChild(picker);
    return root;
  }

  function registrations() {
    return Array.isArray(snapshot.detail?.registrations) ? snapshot.detail.registrations : [];
  }

  function checkedCount() {
    return registrations().filter((item) => String(item.status) === "checked_in").length;
  }

  function pendingCount() {
    return registrations().filter((item) => ["registered", "paused"].includes(String(item.status))).length;
  }

  function selectedBoards() {
    return (snapshot.boards?.boards || []).filter((board) => Boolean(board.selected));
  }

  function status() {
    return String(snapshot.detail?.status || context?.status || "");
  }

  function isAttendanceDone() {
    return ["ready", "in_progress", "completed", "archived"].includes(status());
  }

  function isStarted() {
    return ["in_progress", "completed", "archived"].includes(status());
  }

  function isFinished() {
    return ["completed", "archived"].includes(status());
  }

  function groupStageDone() {
    if (snapshot.playoff?.playoff) return true;
    const progress = snapshot.operations?.progress;
    const total = Number(progress?.total || 0);
    return isStarted() && total > 0 && Number(progress?.completed || 0) === total;
  }

  function playoffDone() {
    return isFinished() || String(snapshot.playoff?.playoff?.status || "") === "completed";
  }

  function planReady() {
    const plan = snapshot.plan || {};
    const groupCount = Number(plan.group_count || 0);
    const groupBestOf = Number(plan.group_best_of_legs || 0);
    const playoffBestOf = Number(plan.playoff_best_of_legs || 0);
    return isAttendanceDone()
      && groupCount > 0
      && groupBestOf > 0 && groupBestOf % 2 === 1
      && playoffBestOf > 0 && playoffBestOf % 2 === 1;
  }

  function stepModel() {
    const exists = Boolean(snapshot.detail?.id);
    const attendanceDone = isAttendanceDone();
    const started = isStarted();
    const finished = isFinished();
    const boardsDone = selectedBoards().length > 0;
    const groupDone = groupStageDone();
    const poDone = playoffDone();

    const steps = [
      { id: "create", label: "Opprett", done: exists, current: !exists, available: true },
      { id: "checkin", label: "Påmelding / innsjekk", done: attendanceDone, current: exists && !attendanceDone, available: exists },
      { id: "draw", label: "Trekning / puljer", done: planReady(), current: attendanceDone && !started && !planReady(), available: attendanceDone },
      { id: "boards", label: "Skiver", done: boardsDone, current: attendanceDone && !started && planReady() && !boardsDone, available: attendanceDone },
      { id: "start", label: "Start", done: started, current: attendanceDone && !started && boardsDone, available: attendanceDone },
      { id: "groups", label: "Gruppespill", done: groupDone, current: started && !groupDone, available: started },
      { id: "playoff", label: "Sluttspill", done: poDone, current: groupDone && !poDone, available: groupDone },
      { id: "finish", label: "Ferdigstill", done: finished, current: poDone && !finished, available: poDone || finished },
    ];

    let currentIndex = steps.findIndex((step) => step.current);
    if (currentIndex < 0) currentIndex = steps.findIndex((step) => !step.done && step.available);
    if (currentIndex < 0) currentIndex = Math.max(0, steps.length - 1);
    return steps.map((step, index) => ({ ...step, index, current: index === currentIndex && !step.done }));
  }

  function planSummary() {
    const plan = snapshot.plan || {};
    const groups = Number(plan.group_count || snapshot.groups.length || 0);
    if (!groups) return "Oppsett ikke klart";
    const mode = ({ elo_snake: "ELO-seedet", elo_pots: "ELO-potter", random: "Tilfeldig" })[String(plan.group_draw_mode || "")] || "Trekning";
    return `${groups} ${groups === 1 ? "gruppe" : "grupper"} · ${mode} · Bo${Number(plan.group_best_of_legs || 3)}`;
  }

  function nextModel() {
    const id = currentTournamentId();
    const checked = checkedCount();
    const pending = pendingCount();
    const boards = selectedBoards();
    const progress = snapshot.operations?.progress || {};
    const playoff = snapshot.playoff?.playoff || null;

    if (!id || !snapshot.detail) {
      return {
        eyebrow: "Neste handling",
        title: "Opprett neste turnering",
        text: "Sett navn og starttid. Påmelding og innsjekk kobles på automatisk.",
        action: "create",
        label: "+ Ny turnering",
        tone: "primary",
      };
    }

    if (status() === "draft") {
      if (checked < MIN_PLAYERS) {
        return {
          eyebrow: "Innsjekk",
          title: `${checked} av minst ${MIN_PLAYERS} spillere klare`,
          text: pending ? `${pending} påmeldte mangler innsjekk.` : "Flere spillere må sjekkes inn før oppmøtet kan låses.",
          action: "checkin",
          label: "Sjekk inn spillere",
          tone: "primary",
        };
      }
      return {
        eyebrow: "Oppmøtet ser klart ut",
        title: `${checked} spillere blir med`,
        text: pending ? `${pending} påmeldte er ikke sjekket inn og blir markert som ikke møtt.` : "Alle med bekreftet plass er sjekket inn.",
        action: "finish-checkin",
        label: "Avslutt innsjekk",
        tone: "primary",
      };
    }

    if (status() === "ready") {
      if (!planReady()) {
        return {
          eyebrow: "Trekning og puljer",
          title: "Bekreft turneringsoppsettet",
          text: planSummary(),
          action: "format",
          label: "Åpne oppsett",
          tone: "primary",
        };
      }
      if (!boards.length) {
        return {
          eyebrow: "Skiver",
          title: "Velg skivene turneringen skal bruke",
          text: `${planSummary()}. Minst én aktiv skive må velges før start.`,
          action: "boards",
          label: "Velg skiver",
          tone: "primary",
        };
      }
      return {
        eyebrow: "Klar til start",
        title: `${checked} spillere · ${boards.length} ${boards.length === 1 ? "skive" : "skiver"}`,
        text: `${planSummary()}. Trekning og gruppekamper opprettes når du starter.`,
        action: "start",
        label: "Start turnering",
        tone: "primary",
      };
    }

    if (status() === "in_progress") {
      if (!snapshot.groups.length) {
        return {
          eyebrow: "Oppstart",
          title: "Gruppene mangler etter start",
          text: "Fullfør trekningen og opprett gruppekamper fra det lagrede oppsettet.",
          action: "repair-start",
          label: "Fullfør trekning",
          tone: "warning",
        };
      }
      if (!groupStageDone()) {
        const completed = Number(progress.completed || 0);
        const total = Number(progress.total || 0);
        const active = Number(progress.in_progress || 0) + Number(progress.assigned || 0);
        return {
          eyebrow: "Gruppespill",
          title: total ? `${completed} av ${total} kamper ferdige` : "Gruppespillet pågår",
          text: active ? `${active} kamp${active === 1 ? "" : "er"} er ute på skive eller kalt opp.` : "Fordel neste tilgjengelige kamper til ledige skiver.",
          action: "reconcile",
          label: "Fordel ledige skiver",
          tone: "primary",
        };
      }
      if (!playoff) {
        return {
          eyebrow: "Gruppespill ferdig",
          title: "Sluttspillet er klart til å opprettes",
          text: `${Number(snapshot.plan?.qualifiers_per_group || 2)} går videre per gruppe · Bo${Number(snapshot.plan?.playoff_best_of_legs || 3)}.`,
          action: "generate-playoff",
          label: "Opprett sluttspill",
          tone: "primary",
        };
      }
      return {
        eyebrow: "Sluttspill",
        title: playoff.champion_name ? `Vinner: ${playoff.champion_name}` : "Sluttspillet pågår",
        text: playoff.champion_name ? "Turneringen ferdigstilles automatisk når finaleresultatet er canonical." : "Følg bracketen og neste kamper i sluttspillvisningen.",
        action: "playoff",
        label: "Åpne sluttspill",
        tone: "primary",
      };
    }

    if (isFinished()) {
      const champion = snapshot.playoff?.playoff?.champion_name || "";
      return {
        eyebrow: "Turneringen er ferdig",
        title: champion ? `🏆 ${champion}` : "Resultatene er klare",
        text: "Neste naturlige steg er å skrive eller publisere turneringsoppsummeringen.",
        action: "summary",
        label: "Skriv oppsummering",
        tone: "primary",
      };
    }

    return {
      eyebrow: "Turneringsleder",
      title: "Oppdater turneringsstatus",
      text: "Statusen kunne ikke plasseres entydig i arbeidsflyten.",
      action: "refresh",
      label: "Oppdater",
      tone: "secondary",
    };
  }

  function render() {
    const root = ensureMount();
    if (!root) return;
    const detail = snapshot.detail;
    const checked = checkedCount();
    const active = registrations().filter((item) => ["registered", "checked_in", "waitlisted", "paused"].includes(String(item.status))).length;
    const start = detail?.start_at ? formatDate(detail.start_at) : "";

    root.querySelector("#tcLeaderStatus").textContent = statusLabel(status());
    root.querySelector("#tcLeaderStatus").dataset.status = status() || "none";
    root.querySelector("#tcLeaderName").textContent = detail?.name || "Velg turnering";
    root.querySelector("#tcLeaderMeta").textContent = detail
      ? [start, `${checked}/${active || checked} klare`].filter(Boolean).join(" · ")
      : "Opprett eller velg en turnering";

    const steps = stepModel();
    root.querySelector("#tcLeaderSteps").innerHTML = steps.map((step) => {
      const state = step.done ? "done" : step.current ? "current" : step.available ? "available" : "locked";
      return `<button type="button" data-leader-step="${esc(step.id)}" data-state="${state}" ${step.available ? "" : "disabled"} ${step.current ? 'aria-current="step"' : ""}>
        <span class="tc-leader-step-number">${step.done ? "✓" : step.index + 1}</span>
        <span class="tc-leader-step-label">${esc(step.label)}</span>
      </button>`;
    }).join("");

    const next = nextModel();
    root.querySelector("#tcLeaderNext").innerHTML = `
      <div class="tc-leader-next-copy">
        <span>${esc(next.eyebrow)}</span>
        <strong>${esc(next.title)}</strong>
        <p>${esc(next.text)}</p>
      </div>
      <button type="button" class="button ${next.tone === "warning" ? "secondary" : ""}" data-leader-action="${esc(next.action)}">${esc(next.label)}</button>`;

    window.__bdTournamentLeaderState = {
      tournamentId: currentTournamentId(),
      status: status(),
      steps,
      next,
      checked,
      active,
      selectedBoardCount: selectedBoards().length,
      groupCount: snapshot.groups.length,
      progress: snapshot.operations?.progress || null,
      playoff: snapshot.playoff?.playoff || null,
    };
    configurePolling();
  }

  function setView(view) {
    const button = host.querySelector(`[data-tc-view="${view}"]`);
    if (button && !button.disabled) button.click();
  }

  function scrollTo(selector) {
    window.requestAnimationFrame(() => {
      const node = host.querySelector(selector) || document.querySelector(selector);
      node?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  function openLiveTool(tool) {
    setView("live");
    window.setTimeout(() => {
      const button = host.querySelector(`[data-live-tool="${tool}"]`);
      button?.click();
      scrollTo(tool === "playoff" ? ".playoff-control" : ".ops-admin-panel");
    }, 80);
  }

  function navigate(step) {
    if (step === "create") {
      if (!snapshot.detail?.id) document.getElementById("twOpen")?.click();
      return;
    }
    if (step === "checkin") {
      setView("checkin");
      scrollTo("#tcStageCheckin");
      return;
    }
    if (["draw", "boards", "start"].includes(step)) {
      setView("format");
      const selector = step === "draw" ? "#tcRecommendation" : step === "boards" ? "#tcBoardSelection" : "#tcStart";
      scrollTo(selector);
      return;
    }
    if (step === "groups") {
      openLiveTool("operations");
      return;
    }
    if (step === "playoff") {
      openLiveTool("playoff");
      return;
    }
    if (step === "finish") {
      if (isFinished()) {
        setView("after");
        scrollTo("#tcStageAfter");
      } else {
        openLiveTool("playoff");
      }
    }
  }

  function showMessage(message, tone = "success") {
    const node = document.getElementById("tcMessage");
    if (!node) return;
    node.textContent = message;
    node.className = `message ${tone}`;
  }

  async function withBusy(buttonAction) {
    if (actionBusy) return;
    actionBusy = true;
    const button = document.querySelector(`[data-leader-action="${buttonAction}"]`);
    const oldText = button?.textContent || "";
    if (button) {
      button.disabled = true;
      button.textContent = "Jobber …";
    }
    try {
      await performAction(buttonAction);
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      actionBusy = false;
      if (button?.isConnected) {
        button.disabled = false;
        button.textContent = oldText;
      }
    }
  }

  function runAction(action) {
    if (["repair-start", "reconcile", "generate-playoff"].includes(action)) {
      withBusy(action);
      return;
    }
    if (action === "create") {
      document.getElementById("twOpen")?.click();
      return;
    }
    if (action === "checkin") {
      navigate("checkin");
      return;
    }
    if (action === "finish-checkin") {
      document.getElementById("tcToFormat")?.click();
      return;
    }
    if (action === "format") {
      navigate("draw");
      return;
    }
    if (action === "boards") {
      navigate("boards");
      return;
    }
    if (action === "start") {
      navigate("start");
      window.setTimeout(() => document.getElementById("tcStart")?.click(), 120);
      return;
    }
    if (action === "playoff") {
      navigate("playoff");
      return;
    }
    if (action === "summary") {
      setView("after");
      window.setTimeout(() => scrollTo(".tc-summary-admin"), 120);
      return;
    }
    if (action === "refresh") refresh({ announce: true });
  }

  async function performAction(action) {
    const id = currentTournamentId();
    if (!id) return;

    if (action === "repair-start") {
      const plan = snapshot.plan || {};
      await api(`/tournaments/${id}/groups/draw`, {
        method: "POST",
        body: {
          group_count: Number(plan.group_count || 1),
          mode: plan.group_draw_mode || "elo_snake",
        },
      });
      const generated = await api(`/tournaments/${id}/groups/round-robin`, {
        method: "POST",
        body: { best_of_legs: Number(plan.group_best_of_legs || 3) },
      });
      await api(`/tournaments/${id}/operations/reconcile`, { method: "POST" }).catch(() => null);
      showMessage(`${Number(generated.created_match_count || 0)} gruppekamper er opprettet.`, "success");
      await refresh();
      openLiveTool("operations");
      return;
    }

    if (action === "reconcile") {
      const result = await api(`/tournaments/${id}/operations/reconcile`, { method: "POST" });
      const count = Number(result.assignment?.assigned_count || 0);
      showMessage(
        count ? `${count} kamp${count === 1 ? "" : "er"} ble sendt til ledige skiver.` : "Ingen nye kamper kunne fordeles akkurat nå.",
        "success"
      );
      await refresh();
      openLiveTool("operations");
      return;
    }

    if (action === "generate-playoff") {
      const plan = snapshot.plan || {};
      const result = await api(`/tournaments/${id}/playoffs/generate`, {
        method: "POST",
        body: {
          qualifiers_per_group: Number(plan.qualifiers_per_group || 2),
          best_of_legs: Number(plan.playoff_best_of_legs || 3),
        },
      });
      snapshot.playoff = result.bracket || null;
      await api(`/tournaments/${id}/operations/reconcile`, { method: "POST" }).catch(() => null);
      showMessage("Sluttspillet er opprettet og første kampene er lagt i kampkøen.", "success");
      await refresh();
      openLiveTool("playoff");
    }
  }

  async function refresh({ announce = false } = {}) {
    const id = currentTournamentId();
    const request = ++requestId;
    ensureMount();
    if (!id || !token()) {
      snapshot = emptySnapshot();
      render();
      return;
    }

    const [detailData, planData, groupData, boardData] = await Promise.all([
      optional(`/tournaments/${id}`),
      optional(`/tournaments/${id}/wizard-plan`),
      optional(`/tournaments/${id}/groups`),
      optional(`/tournaments/${id}/operations/boards`),
    ]);
    if (request !== requestId) return;

    const detail = detailData?.tournament || null;
    const currentStatus = String(detail?.status || context?.status || "");
    const needsLive = ["in_progress", "completed", "archived"].includes(currentStatus);
    const [operations, playoffData] = needsLive
      ? await Promise.all([
          optional(`/tournaments/${id}/operations`),
          optional(`/tournaments/${id}/playoffs`),
        ])
      : [null, null];
    if (request !== requestId) return;

    snapshot = {
      detail,
      plan: planData?.plan || null,
      groups: groupData?.groups || [],
      boards: boardData,
      operations,
      playoff: playoffData?.bracket || null,
    };
    context = { ...(context || {}), id, status: detail?.status || context?.status || "" };
    render();
    if (announce) showMessage("Turneringsstatusen er oppdatert.", "success");
  }

  function scheduleRefresh(delay = 100) {
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => refresh().catch(() => undefined), delay);
  }

  function configurePolling() {
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    if (status() === "in_progress" && !document.hidden) {
      pollTimer = window.setInterval(() => refresh().catch(() => undefined), 15000);
    }
  }

  window.addEventListener("bd:tournament-context", (event) => {
    const previousId = currentTournamentId();
    context = event.detail || context;
    const changed = Number(context?.id || 0) !== previousId;
    scheduleRefresh(changed ? 0 : 120);
  });
  window.addEventListener("bd:tournament-tools-ready", () => {
    ensureMount();
    scheduleRefresh(120);
  });
  window.addEventListener("bd:portal-view", (event) => {
    if (event.detail?.target === "tournaments") scheduleRefresh(0);
  });
  document.addEventListener("visibilitychange", () => {
    configurePolling();
    if (!document.hidden && status() === "in_progress") scheduleRefresh(0);
  });
  host.addEventListener("click", (event) => {
    if (event.target.closest("#tcRefresh,#tcStart,#tcToFormat,#opsReconcile,#poGenerate,#poReconcile,.tc-checkin,.tc-remove")) {
      scheduleRefresh(500);
    }
  });

  ensureMount();
  refresh().catch(() => render());
}
