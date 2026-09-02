const tournamentSelect = document.getElementById("tableTournamentSelect");
const tournamentPanel = document.querySelector('[data-statistics-panel="tournament"]');
let tournamentEloRequest = 0;

function escElo(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function deltaTone(value) {
  const delta = Number(value || 0);
  return delta > .05 ? "positive" : delta < -.05 ? "negative" : "neutral";
}

function deltaLabel(value) {
  const delta = Number(value || 0);
  return `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`;
}

function resultLabel(value) {
  return value === "win" ? "Seier" : value === "loss" ? "Tap" : "Uavgjort";
}

function movementHtml(match) {
  const before = Number(match.rating_before);
  const after = Number(match.rating_after);
  const delta = Number(match.delta || 0);
  return `<span class="elo-movement ${deltaTone(delta)} compact"><span class="elo-before">${before.toFixed(1)}</span><span class="elo-arrow">→</span><strong class="elo-after">${after.toFixed(1)}</strong><b class="elo-delta">${deltaLabel(delta)}</b></span>`;
}

function playerHtml(player) {
  const before = Number(player.rating_before || 1000);
  const current = Number(player.current_rating || before);
  const delta = Number(player.delta || 0);
  const matches = Array.isArray(player.matches) ? player.matches : [];
  return `<details class="tournament-elo-player">
    <summary>
      <span class="tournament-elo-player-name"><strong>${escElo(player.display_name || "Spiller")}</strong><small>${matches.length} ELO-kamper</small></span>
      <span class="elo-tournament-result"><span class="before">${before.toFixed(1)}</span><span class="elo-arrow">→</span><strong class="after">${current.toFixed(1)}</strong><b class="delta ${deltaTone(delta)}">${deltaLabel(delta)}</b></span>
    </summary>
    <div class="elo-tournament-matches">${matches.length ? matches.map((match) => `<div class="elo-tournament-match"><div><strong>${escElo(resultLabel(match.result))} mot ${escElo(match.opponent_name || "motstander")}</strong><small>${escElo(match.round_label || match.bracket_label || "Kamp")}</small></div>${movementHtml(match)}</div>`).join("") : `<div class="elo-tournament-empty">Ingen kampvise ELO-endringer.</div>`}</div>
  </details>`;
}

function ensureHost() {
  if (!tournamentPanel) return null;
  let host = tournamentPanel.querySelector("#tournamentEloSummary");
  if (host) return host;
  host = document.createElement("section");
  host.id = "tournamentEloSummary";
  host.className = "tournament-elo-summary hidden";
  const tabs = tournamentPanel.querySelector(".statistics-tournament-tabs");
  if (tabs) tabs.before(host);
  else tournamentPanel.prepend(host);
  return host;
}

async function refreshTournamentElo() {
  const host = ensureHost();
  const tournamentId = Number(tournamentSelect?.value || 0);
  if (!host || !tournamentId) {
    host?.classList.add("hidden");
    return;
  }
  const request = ++tournamentEloRequest;
  try {
    const response = await fetch(`../api/tournament-elo.php?tournament_id=${encodeURIComponent(tournamentId)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (request !== tournamentEloRequest) return;
    if (!response.ok || !payload?.ok) throw new Error("elo_failed");
    const data = payload.data || {};
    const players = Array.isArray(data.players) ? data.players : [];
    if (!players.length) {
      host.classList.add("hidden");
      host.innerHTML = "";
      return;
    }
    const completed = data.tournament?.status === "completed";
    host.innerHTML = `<div class="tournament-elo-summary-head"><div><h4>ELO i turneringen</h4><p>Trykk på en spiller for å se hvor ELO-poengene kom og gikk.</p></div><span>${completed ? "Start → slutt" : "Start → nå"}</span></div><div class="tournament-elo-players">${players.map(playerHtml).join("")}</div>`;
    host.classList.remove("hidden");
  } catch {
    if (request !== tournamentEloRequest) return;
    host.classList.add("hidden");
  }
}

function initializeTournamentElo() {
  if (!tournamentSelect || !tournamentPanel) return;
  tournamentSelect.addEventListener("change", () => refreshTournamentElo());
  const observer = new MutationObserver(() => refreshTournamentElo());
  observer.observe(tournamentSelect, { childList: true });
  window.addEventListener("bd:portal-view", (event) => {
    if (event.detail?.target === "statistics") refreshTournamentElo();
  });
  window.setTimeout(refreshTournamentElo, 350);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initializeTournamentElo, { once: true });
else initializeTournamentElo();