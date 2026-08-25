const API_ROOT = "../api/v1";

const host = document.getElementById("tournaments");
if (host) {
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "./tournament-playoff-admin.css";
  document.head.appendChild(css);

  const shell = document.createElement("div");
  shell.className = "tournament-control playoff-control";
  shell.innerHTML = `
    <div class="subsection-head tournament-control-head">
      <div>
        <h3>Sluttspill</h3>
        <p class="muted">Kvalifiser spillere fra ferdige gruppetabeller og opprett et seedet single-elimination-sluttspill.</p>
      </div>
      <button id="poRefresh" type="button" class="button secondary">Oppdater</button>
    </div>
    <div id="poMessage" class="message hidden"></div>
    <div class="tournament-control-grid">
      <div class="create-card stack">
        <label><span>Turnering</span><select id="poTournament"></select></label>
        <div class="tc-two">
          <label><span>Videre per gruppe</span><input id="poQualifiers" type="number" min="1" max="16" value="2"></label>
          <label><span>Best of legs</span><input id="poBestOf" type="number" min="1" max="21" step="2" value="3"></label>
        </div>
        <button id="poGenerate" type="button" class="button">Opprett sluttspill</button>
        <p class="muted">Alle gruppekamper må være ferdige. Ved f.eks. 6 kvalifiserte opprettes en 8-slot bracket med byes.</p>
      </div>
      <div class="create-card stack">
        <h3>Status</h3>
        <div id="poStatus" class="playoff-status"></div>
        <button id="poReconcile" type="button" class="button secondary">Reparer / oppdater bracket</button>
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
    "poRefresh", "poMessage", "poTournament", "poQualifiers", "poBestOf", "poGenerate",
    "poReconcile", "poStatus", "poMeta", "poEntries", "poBracket",
  ].map((id) => [id, document.getElementById(id)]));
  const state = { tournaments: [], bracket: null };

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
      render();
      return;
    }
    const data = await api(`/tournaments/${tournamentId}/playoffs`);
    state.bracket = data.bracket || null;
    render();
  }

  function matchStatus(node) {
    const status = String(node.status || "");
    return {
      waiting: "Venter på vinnere",
      ready: "Klar",
      pending: "I kø",
      assigned: node.board_number ? `Board ${Number(node.board_number)}` : "Kalt opp",
      in_progress: node.board_number ? `LIVE · Board ${Number(node.board_number)}` : "LIVE",
      completed: "Ferdig",
      bye: "Bye",
    }[status] || status;
  }

  function render() {
    const data = state.bracket;
    if (!data?.playoff) {
      el.poStatus.innerHTML = `<p class="muted">Sluttspillet er ikke opprettet ennå.</p>`;
      el.poMeta.textContent = "Ikke opprettet";
      el.poEntries.innerHTML = "";
      el.poBracket.innerHTML = `<div class="empty">Når gruppespillet er ferdig, oppretter du sluttspillet her.</div>`;
      el.poGenerate.disabled = false;
      el.poReconcile.disabled = true;
      return;
    }

    const playoff = data.playoff;
    el.poQualifiers.value = String(playoff.qualifiers_per_group || 2);
    el.poBestOf.value = String(playoff.best_of_legs || 3);
    el.poGenerate.disabled = true;
    el.poReconcile.disabled = false;
    el.poMeta.textContent = `${Number(playoff.bracket_size)}-slot · ${esc(playoff.status)}`;
    el.poStatus.innerHTML = playoff.champion_name
      ? `<strong>🏆 ${esc(playoff.champion_name)}</strong><p class="muted">Turneringsvinner</p>`
      : `<strong>${esc(playoff.status === "completed" ? "Ferdig" : "Sluttspillet pågår")}</strong><p class="muted">${Number(data.entries?.length || 0)} kvalifiserte · Best of ${Number(playoff.best_of_legs)}</p>`;

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
  el.poGenerate.addEventListener("click", async () => {
    const tournamentId = Number(el.poTournament.value || 0);
    if (!tournamentId) return;
    el.poGenerate.disabled = true;
    try {
      const result = await api(`/tournaments/${tournamentId}/playoffs/generate`, {
        method: "POST", auth: true,
        body: {
          qualifiers_per_group: Number(el.poQualifiers.value || 0),
          best_of_legs: Number(el.poBestOf.value || 0),
        },
      });
      state.bracket = result.bracket || null;
      show("Sluttspillet er opprettet og første kamp(er) ligger i den vanlige kampkøen.", "success");
      render();
    } catch (error) {
      show(error.message, "error");
      el.poGenerate.disabled = false;
    }
  });
  el.poReconcile.addEventListener("click", async () => {
    const tournamentId = Number(el.poTournament.value || 0);
    if (!tournamentId) return;
    el.poReconcile.disabled = true;
    try {
      const result = await api(`/tournaments/${tournamentId}/playoffs/reconcile`, { method: "POST", auth: true });
      state.bracket = result.bracket || null;
      show("Bracketen er oppdatert fra canonical kampresultater.", "success");
      render();
    } catch (error) {
      show(error.message, "error");
    } finally {
      el.poReconcile.disabled = false;
    }
  });
  document.getElementById("clubSelect")?.addEventListener("change", () => {
    setTimeout(() => loadBase().catch((error) => show(error.message, "error")), 0);
  });

  hideMessage();
  loadBase().catch((error) => show(error.message, "error"));
}
