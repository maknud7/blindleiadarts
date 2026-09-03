const API_ROOT = "../api/v1";

const host = document.getElementById("tournaments");
if (host) {
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "./tournament-playoff-admin.css?v=20260903-auto-playoff-01";
  document.head.appendChild(css);

  const shell = document.createElement("div");
  shell.className = "tournament-control playoff-control";
  shell.innerHTML = `
    <div class="subsection-head tournament-control-head">
      <div>
        <h3>Sluttspill</h3>
        <p class="muted">Sluttspillet opprettes automatisk fra turneringsoppsettet når siste gruppekamp er ferdig.</p>
      </div>
      <button id="poRefresh" type="button" class="button secondary">Oppdater</button>
    </div>
    <div id="poMessage" class="message hidden"></div>
    <div class="tournament-control-grid">
      <div class="create-card stack">
        <label><span>Turnering</span><select id="poTournament"></select></label>
        <div id="poAutoStatus" class="mini-card"></div>
      </div>
      <div class="create-card stack">
        <h3>Status</h3>
        <div id="poStatus" class="playoff-status"></div>
      </div>
    </div>
    <div class="tc-panel">
      <div class="subsection-head"><h3>Bracket</h3><span id="poMeta" class="pill">Ikke opprettet</span></div>
      <div id="poEntries" class="playoff-entries"></div>
      <div id="poBracket" class="playoff-bracket"></div>
    </div>
  `;
  host.appendChild(shell);

  const el = Object.fromEntries([
    "poRefresh", "poMessage", "poTournament", "poAutoStatus", "poStatus", "poMeta", "poEntries", "poBracket",
  ].map((id) => [id, document.getElementById(id)]));
  const state = { tournaments: [], bracket: null, plan: null };

  function token() { return localStorage.getItem("bd:token") || ""; }
  function clubId() { return Number(localStorage.getItem("bd:selectedClubId") || 0); }
  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }
  function show(message, tone = "info") {
    el.poMessage.textContent = message;
    el.poMessage.className = `message ${tone}`;
  }
  function hideMessage() {
    el.poMessage.textContent = "";
    el.poMessage.className = "message hidden";
  }
  async function api(path, { method = "GET", body, auth = false } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth && token()) headers.Authorization = `Bearer ${token()}`;
    const response = await fetch(`${API_ROOT}${path}`, {
      method, headers, cache: "no-store",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  }

  async function loadBase() {
    const id = clubId();
    if (!id) return;
    const selected = Number(el.poTournament.value || 0);
    const data = await api(`/clubs/${id}/registration-tournaments`);
    state.tournaments = data.items || [];
    el.poTournament.innerHTML = state.tournaments
      .map((t) => `<option value="${Number(t.id)}">${esc(t.name)} · ${esc(t.status)}</option>`).join("");
    if (state.tournaments.some((t) => Number(t.id) === selected)) el.poTournament.value = String(selected);
    await loadBracket();
  }

  async function loadBracket() {
    const tournamentId = Number(el.poTournament.value || 0);
    if (!tournamentId) {
      state.bracket = null;
      state.plan = null;
      render();
      return;
    }
    const [playoffData, planData] = await Promise.all([
      api(`/tournaments/${tournamentId}/playoffs`),
      api(`/tournaments/${tournamentId}/wizard-plan`).catch(() => ({ plan: null })),
    ]);
    state.bracket = playoffData.bracket || null;
    state.plan = planData.plan || null;
    render();
  }

  function matchStatus(node) {
    const status = String(node.status || "");
    return {
      waiting: "Venter på vinnere",
      ready: "Klar",
      pending: "I kø",
      assigned: node.board_number ? `Skive ${Number(node.board_number)}` : "Kalt opp",
      in_progress: node.board_number ? `LIVE · Skive ${Number(node.board_number)}` : "LIVE",
      completed: "Ferdig",
      bye: "Bye",
    }[status] || status;
  }

  function render() {
    const data = state.bracket;
    const plan = state.plan;
    const auto = plan?.tournament_format === "groups_playoff" && plan?.auto_create_playoff === true;
    el.poAutoStatus.innerHTML = auto
      ? `<strong>Automatisk sluttspill er på</strong><p class="muted">${Number(plan.qualifiers_per_group)} videre per gruppe · Best av ${Number(plan.playoff_best_of_legs)}. Opprettes når gruppespillet er ferdig.</p>`
      : `<strong>Automatisk sluttspill er av</strong><p class="muted">Dette styres i turneringsoppsettet.</p>`;

    if (!data?.playoff) {
      el.poStatus.innerHTML = auto
        ? `<strong>Venter på ferdig gruppespill</strong><p class="muted">Ingen handling er nødvendig.</p>`
        : `<p class="muted">Sluttspill er ikke aktivert for denne turneringen.</p>`;
      el.poMeta.textContent = "Venter";
      el.poEntries.innerHTML = "";
      el.poBracket.innerHTML = `<div class="empty">Bracketen vises automatisk når kvalifiseringen er avgjort.</div>`;
      return;
    }

    const playoff = data.playoff;
    el.poMeta.textContent = `${Number(playoff.bracket_size)}-slot · ${esc(playoff.status)}`;
    el.poStatus.innerHTML = playoff.champion_name
      ? `<strong>🏆 ${esc(playoff.champion_name)}</strong><p class="muted">Turneringsvinner</p>`
      : `<strong>${esc(playoff.status === "completed" ? "Ferdig" : "Sluttspillet pågår")}</strong><p class="muted">${Number(data.entries?.length || 0)} kvalifiserte · Best av ${Number(playoff.best_of_legs)}</p>`;

    el.poEntries.innerHTML = (data.entries || []).map((entry) => `
      <span class="playoff-entry"><b>#${Number(entry.seed_number)}</b> ${esc(entry.display_name)} <small>${esc(entry.source_group_name)} #${Number(entry.source_group_position)}</small></span>`
    ).join("");

    el.poBracket.innerHTML = (data.rounds || []).map((round) => `
      <section class="playoff-round">
        <h4>${esc(round.label)}</h4>
        <div class="playoff-round-matches">${(round.nodes || []).map((node) => `
          <article class="playoff-match ${node.winner_player_id ? "decided" : ""}">
            <div class="playoff-player ${Number(node.winner_player_id) === Number(node.player_a_id) ? "winner" : ""}">${node.player_a_name ? esc(node.player_a_name) : "Venter …"}</div>
            <div class="playoff-player ${Number(node.winner_player_id) === Number(node.player_b_id) ? "winner" : ""}">${node.player_b_name ? esc(node.player_b_name) : "Venter …"}</div>
            <small>${esc(matchStatus(node))}</small>
          </article>`).join("")}</div>
      </section>`).join("");
  }

  el.poRefresh.addEventListener("click", () => loadBase().catch((error) => show(error.message, "error")));
  el.poTournament.addEventListener("change", () => loadBracket().catch((error) => show(error.message, "error")));
  document.getElementById("clubSelect")?.addEventListener("change", () => {
    setTimeout(() => loadBase().catch((error) => show(error.message, "error")), 0);
  });

  hideMessage();
  loadBase().catch((error) => show(error.message, "error"));
}
