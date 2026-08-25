const API_ROOT = "../api/v1";
const select = document.getElementById("tableTournamentSelect");
const host = document.getElementById("portalPlayoff");

if (select && host) {
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "./portal-playoffs.css";
  document.head.appendChild(css);

  let activeTournamentId = 0;
  let loading = false;

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }
  async function api(path) {
    const response = await fetch(`${API_ROOT}${path}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  }
  function statusText(node) {
    const status = String(node.status || "");
    return {
      waiting: "Venter",
      ready: "Klar",
      pending: "I kø",
      assigned: node.board_number ? `Board ${Number(node.board_number)}` : "Kalt opp",
      in_progress: node.board_number ? `LIVE · Board ${Number(node.board_number)}` : "LIVE",
      completed: "Ferdig",
      bye: "Bye",
    }[status] || status;
  }
  function render(data) {
    const bracket = data?.bracket;
    if (!bracket?.playoff) {
      host.innerHTML = `<div class="mini-card"><p class="muted">Sluttspillet er ikke opprettet for denne turneringen ennå.</p></div>`;
      return;
    }
    const champion = bracket.playoff.champion_name
      ? `<div class="portal-champion">🏆 <strong>${esc(bracket.playoff.champion_name)}</strong></div>`
      : `<p class="muted">${Number(bracket.entries?.length || 0)} kvalifiserte · Best of ${Number(bracket.playoff.best_of_legs)}</p>`;
    host.innerHTML = `${champion}<div class="portal-bracket">${(bracket.rounds || []).map((round) => `
      <section class="portal-bracket-round">
        <h3>${esc(round.label)}</h3>
        <div class="portal-bracket-matches">${(round.nodes || []).map((node) => `
          <article class="portal-bracket-match">
            <div class="portal-bracket-player ${Number(node.winner_player_id) === Number(node.player_a_id) ? "winner" : ""}">${node.player_a_name ? esc(node.player_a_name) : "Venter …"}</div>
            <div class="portal-bracket-player ${Number(node.winner_player_id) === Number(node.player_b_id) ? "winner" : ""}">${node.player_b_name ? esc(node.player_b_name) : "Venter …"}</div>
            <small>${esc(statusText(node))}</small>
          </article>`).join("")}</div>
      </section>`).join("")}</div>`;
  }
  async function load(force = false) {
    const tournamentId = Number(select.value || 0);
    if (!tournamentId) {
      activeTournamentId = 0;
      render(null);
      return;
    }
    if (loading || (!force && tournamentId === activeTournamentId)) return;
    loading = true;
    activeTournamentId = tournamentId;
    try {
      render(await api(`/tournaments/${tournamentId}/playoffs`));
    } catch (error) {
      host.innerHTML = `<div class="mini-card"><p class="muted">${esc(error.message)}</p></div>`;
    } finally {
      loading = false;
    }
  }

  select.addEventListener("change", () => load(true));
  document.getElementById("refreshButton")?.addEventListener("click", () => setTimeout(() => load(true), 0));
  const observer = new MutationObserver(() => setTimeout(() => load(true), 0));
  observer.observe(select, { childList: true });
  setTimeout(() => load(true), 0);
}
