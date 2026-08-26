const API_ROOT = "../api/v1";
const host = document.getElementById("tournaments");

if (host) {
  const style = document.createElement("style");
  style.id = "tournamentEmptyStateStyles";
  style.textContent = `
    #tournaments.tc-empty-mode > .tc-workspace,
    #tournaments.tc-empty-mode > .subsection-head,
    #tournaments.tc-empty-mode > #tournamentList,
    #tournaments.tc-empty-mode > .ops-admin-panel,
    #tournaments.tc-empty-mode > .playoff-control,
    #tournaments.tc-empty-mode > .tc-summary-admin{display:none!important}
    #tournaments.tc-empty-mode > .panel-head #twOpen{display:none!important}
    #tcTournamentEmptyState{margin:22px 0 4px}
    #tournaments:not(.tc-empty-mode) > #tcTournamentEmptyState{display:none!important}
    .tc-empty-card{max-width:620px;margin:28px auto;padding:34px 26px;border:1px solid var(--line);border-radius:18px;background:#f8fbfd;text-align:center;box-shadow:0 10px 28px rgba(11,49,69,.045)}
    .tc-empty-mark{width:46px;height:46px;margin:0 auto 14px;display:grid;place-items:center;border-radius:14px;background:var(--accent-soft,#e9f2fb);color:var(--accent,#185da4);font-size:22px;font-weight:900}
    .tc-empty-card h3{margin:0 0 7px;font-size:21px;color:var(--text,#152536)}
    .tc-empty-card p{margin:0 auto 18px;max-width:420px;color:var(--muted,#66788a);font-size:13px;line-height:1.45}
    .tc-empty-card .button{min-height:42px;padding-inline:18px}
    @media(max-width:640px){.tc-empty-card{margin:18px 0;padding:28px 18px}}
  `;
  document.head.appendChild(style);

  const emptyState = document.createElement("section");
  emptyState.id = "tcTournamentEmptyState";
  emptyState.setAttribute("aria-live", "polite");
  emptyState.innerHTML = `
    <div class="tc-empty-card">
      <div class="tc-empty-mark" aria-hidden="true">+</div>
      <h3>Ingen turneringer ennå</h3>
      <p>Opprett en turnering for å komme i gang.</p>
      <button id="tcEmptyCreate" type="button" class="button">+ Ny turnering</button>
    </div>`;
  host.querySelector(":scope > .panel-head")?.insertAdjacentElement("afterend", emptyState);

  function clubId() {
    return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0);
  }

  function setIntro(empty) {
    const intro = host.querySelector(":scope > .panel-head .muted");
    if (!intro) return;
    intro.textContent = empty
      ? "Opprett den første turneringen når du er klar."
      : "Opprett og gjennomfør turneringen fra innsjekk til resultat.";
  }

  async function refresh() {
    const id = clubId();
    if (!id) return;
    try {
      const response = await fetch(`${API_ROOT}/clubs/${id}/registration-tournaments`, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) return;
      const empty = !(payload.data?.items || []).length;
      host.classList.toggle("tc-empty-mode", empty);
      setIntro(empty);
    } catch {
      // Keep the normal tournament room visible if the empty-state check fails.
      host.classList.remove("tc-empty-mode");
      setIntro(false);
    }
  }

  document.getElementById("tcEmptyCreate")?.addEventListener("click", () => {
    const open = document.getElementById("twOpen");
    if (open) open.click();
  });

  host.addEventListener("click", (event) => {
    if (event.target?.id === "tcRefresh") window.setTimeout(refresh, 250);
  });
  document.getElementById("refreshAllButton")?.addEventListener("click", () => window.setTimeout(refresh, 300));
  document.getElementById("clubSelect")?.addEventListener("change", () => window.setTimeout(refresh, 100));
  window.addEventListener("bd:portal-view", (event) => {
    if (event.detail?.target === "tournaments") refresh();
  });

  refresh();
}
