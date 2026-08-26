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
    if (!stage || document.getElementById("tcLiveTools")) return;
    const toolbar = document.createElement("div");
    toolbar.id = "tcLiveTools";
    toolbar.className = "tc-live-tools";
    toolbar.innerHTML = `
      <button type="button" data-live-tool="operations" class="active">Kampdrift</button>
      <button type="button" data-live-tool="playoff">Sluttspill</button>`;
    const groups = document.getElementById("tcGroups");
    groups?.before(toolbar);
    toolbar.querySelectorAll("[data-live-tool]").forEach((button) => button.addEventListener("click", () => {
      liveTool = button.dataset.liveTool || "operations";
      apply();
    }));
  }

  function apply() {
    host.dataset.tcView = context.view || "checkin";
    host.dataset.tcLiveTool = liveTool;
    ensureLiveTools();
    hideOwnTournamentPicker();
    ["opsTournament", "poTournament", "tsaTournament"].forEach(syncSelect);

    document.querySelectorAll("[data-live-tool]").forEach((button) => button.classList.toggle("active", button.dataset.liveTool === liveTool));

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