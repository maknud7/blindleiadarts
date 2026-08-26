const host = document.getElementById("tournaments");

if (host) {
  let context = window.__bdTournamentContext || { id: 0, status: "", view: "checkin" };
  let liveTool = "operations";

  function syncSelect(id) {
    const select = document.getElementById(id);
    const tournamentId = Number(context.id || 0);
    if (!select || !tournamentId || select.value === String(tournamentId)) return;
    const hasOption = [...select.options].some((option) => Number(option.value) === tournamentId);
    if (!hasOption) return;
    select.value = String(tournamentId);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function hideOwnTournamentPicker() {
    const opsSelect = document.getElementById("opsTournament");
    opsSelect?.closest("label")?.classList.add("tc-context-selector-hidden");
    const playoffSelect = document.getElementById("poTournament");
    playoffSelect?.closest("label")?.classList.add("tc-context-selector-hidden");
    const summarySelect = document.getElementById("tsaTournament");
    summarySelect?.closest("label")?.classList.add("tc-context-selector-hidden");
  }

  function ensureLiveTools() {
    const stage = document.getElementById("tcStageLive");
    if (!stage) return;

    const title = stage.querySelector(".tc-stage-head h3");
    const copy = stage.querySelector(".tc-stage-head .muted");
    if (title) title.textContent = "Kampdrift";
    if (copy) copy.textContent = "Boards, kampkø og sluttspill.";

    if (!document.getElementById("tcLiveTools")) {
      const toolbar = document.createElement("div");
      toolbar.id = "tcLiveTools";
      toolbar.className = "tc-live-tools";
      toolbar.setAttribute("role", "tablist");
      toolbar.setAttribute("aria-label", "Driftsvisning");
      toolbar.innerHTML = `
        <button type="button" data-live-tool="operations" class="active" role="tab">Kampdrift</button>
        <button type="button" data-live-tool="playoff" role="tab">Sluttspill</button>`;
      const groups = document.getElementById("tcGroups");
      groups?.before(toolbar);
      toolbar.querySelectorAll("[data-live-tool]").forEach((button) => button.addEventListener("click", () => {
        liveTool = button.dataset.liveTool || "operations";
        apply();
      }));
    }

    const groups = document.getElementById("tcGroups");
    if (groups && !document.getElementById("tcLiveGroupsDisclosure")) {
      const details = document.createElement("details");
      details.id = "tcLiveGroupsDisclosure";
      details.className = "tc-disclosure tc-live-groups";
      details.innerHTML = `<summary>Grupper og seeding</summary><div class="tc-disclosure-body"></div>`;
      groups.before(details);
      details.querySelector(".tc-disclosure-body")?.appendChild(groups);
    }
  }

  function organizeOperationsPanel() {
    const panel = host.querySelector(".ops-admin-panel");
    if (!panel || panel.dataset.tcUxOrganized === "1") return;

    const nativeHead = panel.querySelector(":scope > .subsection-head");
    nativeHead?.classList.add("tc-ops-native-head");

    const progress = document.getElementById("opsProgress");
    const toolbar = panel.querySelector(".ops-toolbar");
    const reconcile = document.getElementById("opsReconcile");
    const liveLink = document.getElementById("opsLiveLink");

    const primary = document.createElement("div");
    primary.className = "tc-ops-primary";
    if (reconcile) primary.appendChild(reconcile);
    if (liveLink) primary.appendChild(liveLink);
    if (progress) progress.before(primary);
    else panel.prepend(primary);

    if (toolbar) {
      const details = document.createElement("details");
      details.className = "tc-disclosure tc-ops-settings";
      details.innerHTML = `<summary>Driftsinnstillinger</summary><div class="tc-disclosure-body"></div>`;
      details.querySelector(".tc-disclosure-body")?.appendChild(toolbar);
      primary.after(details);
    }

    panel.dataset.tcUxOrganized = "1";
  }

  function apply() {
    host.dataset.tcView = context.view || "checkin";
    host.dataset.tcLiveTool = liveTool;
    ensureLiveTools();
    hideOwnTournamentPicker();
    organizeOperationsPanel();
    ["opsTournament", "poTournament", "tsaTournament"].forEach(syncSelect);

    document.querySelectorAll("[data-live-tool]").forEach((button) => {
      const active = button.dataset.liveTool === liveTool;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });

    const operations = host.querySelector(".ops-admin-panel");
    const playoff = host.querySelector(".playoff-control");
    const summary = host.querySelector(".tc-summary-admin");
    operations?.classList.toggle("tc-external-hidden", context.view !== "live" || liveTool !== "operations");
    playoff?.classList.toggle("tc-external-hidden", context.view !== "live" || liveTool !== "playoff");
    summary?.classList.toggle("tc-external-hidden", context.view !== "after");
  }

  window.addEventListener("bd:tournament-context", (event) => {
    context = event.detail || context;
    if (context.view !== "live") liveTool = "operations";
    apply();
  });

  const observer = new MutationObserver(() => apply());
  observer.observe(host, { childList: true, subtree: true });
  apply();
}
