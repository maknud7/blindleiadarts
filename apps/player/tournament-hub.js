const HUB_API_ROOT = "../api/v1";
const HUB_REFRESH_MS = 20000;

const hubState = {
  tournamentId: 0,
  tournament: null,
  me: null,
  registration: null,
  groups: [],
  tables: [],
  matches: [],
  results: [],
  playoff: null,
  activeView: "mine",
  matchFilter: "all",
  selectedGroupId: 0,
  loading: false,
  lastLoadedAt: 0,
};

const hubCss = document.createElement("link");
hubCss.rel = "stylesheet";
hubCss.href = new URL("./tournament-hub.css?v=20260828-1400", import.meta.url).href;
document.head.appendChild(hubCss);

const signupSection = document.getElementById("signup");
const hubRoot = document.createElement("section");
hubRoot.id = "activeTournamentHub";
hubRoot.className = "card stack tournament-hub hidden";
hubRoot.dataset.portalSection = "tournaments";
hubRoot.setAttribute("aria-live", "polite");
hubRoot.innerHTML = `<div class="tournament-hub-loading"><span></span>Henter pågående turnering …</div>`;
if (signupSection?.parentNode) signupSection.parentNode.insertBefore(hubRoot, signupSection);

function hubToken() {
  return localStorage.getItem("bd:token") || "";
}

function hubClubId() {
  return Number(localStorage.getItem("bd:playerClubId") || document.getElementById("clubSelect")?.value || 0);
}

async function hubApi(path, { auth = false } = {}) {
  const headers = {};
  if (auth && hubToken()) headers.Authorization = `Bearer ${hubToken()}`;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${HUB_API_ROOT}${path}`, { headers, cache: "no-store", signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  } finally {
    window.clearTimeout(timeout);
  }
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatAverage(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed.toFixed(2) : "—";
}

function statusText(status) {
  return {
    ready: "Klar",
    in_progress: "Pågår",
    completed: "Ferdig",
    pending: "Venter",
    assigned: "Kalt opp",
    waiting: "Venter",
    bye: "Bye",
    cancelled: "Avbrutt",
  }[String(status || "")] || String(status || "");
}

function isLiveTournament(tournament) {
  return ["ready", "in_progress"].includes(String(tournament?.status || ""));
}

function isMyMatch(match) {
  const playerId = number(hubState.me?.player?.id);
  return playerId > 0 && [number(match.player_a_id), number(match.player_b_id)].includes(playerId);
}

function mergedMatches(matches, results) {
  const resultMap = new Map((results || []).map((match) => [number(match.id), match]));
  return (matches || []).map((match) => ({ ...match, ...(resultMap.get(number(match.id)) || {}) }));
}

function matchOrder(match) {
  return { in_progress: 0, assigned: 1, pending: 2, completed: 3, cancelled: 4 }[String(match.status || "")] ?? 5;
}

function sortMatches(matches) {
  return [...matches].sort((a, b) => {
    const order = matchOrder(a) - matchOrder(b);
    if (order !== 0) return order;
    if (String(a.status) === "completed") {
      return String(b.finished_at || "").localeCompare(String(a.finished_at || "")) || number(b.id) - number(a.id);
    }
    return number(a.id) - number(b.id);
  });
}

function findPlayerGroup(playerId) {
  return hubState.groups.find((group) => (group.players || []).some((player) => number(player.player_id) === number(playerId))) || null;
}

function tableGroupFor(group) {
  if (!group) return null;
  return hubState.tables.find((entry) => number(entry.id) === number(group.id) || String(entry.name) === String(group.name)) || null;
}

function playerTableRow(playerId) {
  for (const group of hubState.tables) {
    const row = (group.rows || []).find((entry) => number(entry.player_id) === number(playerId));
    if (row) return { group, row };
  }
  return null;
}

function opponentFor(match, playerId) {
  if (!match || !playerId) return null;
  if (number(match.player_a_id) === number(playerId)) return { id: number(match.player_b_id), name: match.player_b_name };
  if (number(match.player_b_id) === number(playerId)) return { id: number(match.player_a_id), name: match.player_a_name };
  return null;
}

function currentOrNextMatch(playerId) {
  const mine = sortMatches(hubState.matches.filter((match) => isMyMatch(match)));
  return mine.find((match) => String(match.status) === "in_progress")
    || mine.find((match) => String(match.status) === "assigned")
    || mine.find((match) => String(match.status) === "pending")
    || null;
}

function tournamentProgress() {
  const total = hubState.matches.filter((match) => String(match.status) !== "cancelled").length;
  const completed = hubState.matches.filter((match) => String(match.status) === "completed").length;
  return { total, completed };
}

function qualificationText(playerId) {
  const bracket = hubState.playoff?.bracket;
  const playoff = bracket?.playoff;
  if (!playoff) return "Sluttspillet er ikke opprettet ennå.";
  const entry = (bracket.entries || []).find((item) => number(item.player_id) === number(playerId));
  if (entry) return `Kvalifisert til sluttspill${entry.seed ? ` · seed ${number(entry.seed)}` : ""}.`;
  const perGroup = number(playoff.qualifiers_per_group);
  if (perGroup > 0) return `Topp ${perGroup} fra hver gruppe går videre.`;
  return "Sluttspillet er opprettet. Følg utviklingen under Sluttspill.";
}

function playerStrip() {
  const playerId = number(hubState.me?.player?.id);
  if (!playerId) {
    return `<div class="hub-personal-strip hub-personal-strip-generic"><strong>Turneringen pågår</strong><span>Logg inn for personlig kampstatus.</span></div>`;
  }
  const group = findPlayerGroup(playerId);
  const table = playerTableRow(playerId);
  const next = currentOrNextMatch(playerId);
  const opponent = opponentFor(next, playerId);
  const board = number(next?.board_number);
  const status = next ? statusText(next.status) : "Ingen ny kamp";
  const place = table?.row?.position ? `#${number(table.row.position)}` : "";
  return `<div class="hub-personal-strip">
    <span><small>Du</small><strong>${esc(group?.name || "Turnering")}${place ? ` · ${esc(place)}` : ""}</strong></span>
    <span><small>${String(next?.status) === "in_progress" ? "Spiller nå" : "Neste"}</small><strong>${opponent ? esc(opponent.name || "Motstander") : "Ingen kamp i kø"}</strong></span>
    <span><small>${board ? "Skive" : "Status"}</small><strong>${board ? number(board) : esc(status)}</strong></span>
  </div>`;
}

function tabButton(view, label) {
  const active = hubState.activeView === view;
  return `<button type="button" class="${active ? "active" : ""}" data-hub-view="${view}" role="tab" aria-selected="${active ? "true" : "false"}">${esc(label)}</button>`;
}

function renderShell() {
  const progress = tournamentProgress();
  const tournament = hubState.tournament || {};
  hubRoot.classList.remove("hidden");
  hubRoot.innerHTML = `
    <div class="hub-heading">
      <div>
        <p class="eyebrow">Pågående turnering</p>
        <h2>${esc(tournament.name || "Turnering")}</h2>
        <p class="muted">${esc(statusText(tournament.status))}${progress.total ? ` · ${progress.completed} av ${progress.total} kamper ferdig` : ""}</p>
      </div>
      <span class="hub-live-pill"><i></i>${String(tournament.status) === "in_progress" ? "LIVE" : "KLAR"}</span>
    </div>
    ${playerStrip()}
    <div class="hub-tabs" role="tablist" aria-label="Turneringsoversikt">
      ${tabButton("mine", "Min turnering")}
      ${tabButton("groups", "Grupper")}
      ${tabButton("matches", "Kamper")}
      ${tabButton("playoffs", "Sluttspill")}
      ${tabButton("players", "Spillere")}
    </div>
    <div id="tournamentHubPanel" class="hub-panel"></div>`;
  hubRoot.querySelectorAll("[data-hub-view]").forEach((button) => button.addEventListener("click", () => {
    hubState.activeView = button.dataset.hubView || "mine";
    renderShell();
    renderActivePanel();
  }));
  renderActivePanel();
}

function ownMatchCard(match) {
  const playerId = number(hubState.me?.player?.id);
  const opponent = opponentFor(match, playerId);
  const board = number(match.board_number);
  const live = String(match.status) === "in_progress";
  const assigned = String(match.status) === "assigned";
  return `<article class="hub-next-match ${live ? "is-live" : assigned ? "is-assigned" : ""}">
    <div class="hub-next-match-top"><span class="pill">${esc(live ? "Spiller nå" : assigned ? "Klar på skive" : "Neste kamp")}</span>${board ? `<strong>🎯 Skive ${board}</strong>` : `<span class="muted">${esc(statusText(match.status))}</span>`}</div>
    <div class="hub-versus"><strong>${esc(hubState.me?.player?.display_name || "Du")}</strong><span>mot</span><button type="button" data-hub-player="${number(opponent?.id)}">${esc(opponent?.name || "Motstander")}</button></div>
    <p class="muted">${esc(match.group_name || match.bracket_label || match.round_label || "Turnering")}${match.round_label && match.round_label !== match.group_name ? ` · ${esc(match.round_label)}` : ""}</p>
  </article>`;
}

function statCard(label, value, note = "") {
  return `<div class="hub-stat"><small>${esc(label)}</small><strong>${esc(value)}</strong>${note ? `<span>${esc(note)}</span>` : ""}</div>`;
}

function renderMiniGroup(group, playerId) {
  const table = tableGroupFor(group);
  const rows = table?.rows || [];
  if (!rows.length) {
    const drawPlayers = group?.players || [];
    return `<div class="hub-group-list">${drawPlayers.map((player) => `<button type="button" class="hub-standing-row ${number(player.player_id) === playerId ? "is-me" : ""}" data-hub-player="${number(player.player_id)}"><span>${number(player.position) || "–"}</span><strong>${esc(player.display_name)}</strong><small>Ikke startet</small></button>`).join("")}</div>`;
  }
  return `<div class="hub-group-list">${rows.map((row) => `<button type="button" class="hub-standing-row ${number(row.player_id) === playerId ? "is-me" : ""}" data-hub-player="${number(row.player_id)}"><span>${number(row.position)}</span><strong>${esc(row.display_name)}</strong><small>${number(row.points)} p · ${number(row.leg_diff) >= 0 ? "+" : ""}${number(row.leg_diff)} legs · 3DA ${formatAverage(row.three_dart_average)}</small></button>`).join("")}</div>`;
}

function renderMine(panel) {
  const playerId = number(hubState.me?.player?.id);
  if (!playerId) {
    panel.innerHTML = `<div class="mini-card"><strong>Logg inn for «Min turnering»</strong><p class="muted">Grupper, kamper og sluttspill er fortsatt tilgjengelig i fanene over.</p></div>`;
    return;
  }
  const group = findPlayerGroup(playerId);
  const table = playerTableRow(playerId);
  const row = table?.row || null;
  const next = currentOrNextMatch(playerId);
  const ownMatches = sortMatches(hubState.matches.filter((match) => isMyMatch(match)));
  const completed = ownMatches.filter((match) => String(match.status) === "completed").slice(0, 4);
  panel.innerHTML = `
    <div class="hub-mine-grid">
      <div class="hub-primary-column">
        ${next ? ownMatchCard(next) : `<div class="mini-card"><strong>Ingen kamp i kø akkurat nå</strong><p class="muted">Når neste kamp er klar, vises motstander og skive her.</p></div>`}
        <div class="hub-section-head"><div><h3>${esc(group?.name || "Din gruppe")}</h3><p class="muted">Din rad er markert. Trykk på en spiller for mer.</p></div>${row?.position ? `<span class="pill">#${number(row.position)}</span>` : ""}</div>
        ${renderMiniGroup(group, playerId)}
      </div>
      <aside class="hub-secondary-column">
        <div class="hub-stats-grid">
          ${statCard("Kamper", row ? number(row.played) : completed.length)}
          ${statCard("Seire", row ? number(row.wins) : "—")}
          ${statCard("Leg +/−", row ? `${number(row.leg_diff) > 0 ? "+" : ""}${number(row.leg_diff)}` : "—")}
          ${statCard("3DA", row ? formatAverage(row.three_dart_average) : "—")}
          ${statCard("Poeng", row ? number(row.points) : "—")}
          ${statCard("Plass", row?.position ? `#${number(row.position)}` : "—")}
        </div>
        <div class="mini-card hub-qualification"><strong>Veien videre</strong><p>${esc(qualificationText(playerId))}</p></div>
      </aside>
    </div>
    <div class="hub-section-head hub-history-head"><div><h3>Dine kamper</h3><p class="muted">Ferdige kamper kan åpnes helt ned på leg- og kastnivå.</p></div><button type="button" class="ghost hub-inline-action" data-hub-show-mine-matches>Se alle</button></div>
    <div class="hub-match-list">${completed.length ? completed.map((match) => renderMatchCard(match)).join("") : `<p class="muted">Ingen ferdige kamper ennå.</p>`}</div>`;
  bindPanelActions(panel);
  panel.querySelector("[data-hub-show-mine-matches]")?.addEventListener("click", () => {
    hubState.activeView = "matches";
    hubState.matchFilter = "mine";
    renderShell();
  });
}

function renderGroups(panel) {
  if (!hubState.groups.length && !hubState.tables.length) {
    panel.innerHTML = `<div class="mini-card"><p class="muted">Gruppene er ikke trukket ennå.</p></div>`;
    return;
  }
  const groups = hubState.groups.length ? hubState.groups : hubState.tables;
  const playerId = number(hubState.me?.player?.id);
  const myGroup = findPlayerGroup(playerId);
  if (!hubState.selectedGroupId) hubState.selectedGroupId = number(myGroup?.id || groups[0]?.id);
  const selected = groups.find((group) => number(group.id) === number(hubState.selectedGroupId)) || groups[0];
  hubState.selectedGroupId = number(selected?.id);
  const selectedTable = tableGroupFor(selected) || hubState.tables.find((group) => String(group.name) === String(selected?.name));
  const selectedRows = selectedTable?.rows || selected?.players || [];
  const groupMatches = sortMatches(hubState.matches.filter((match) => number(match.tournament_group_id) === number(selected?.id) || String(match.group_name || match.bracket_label || "") === String(selected?.name || "")));
  panel.innerHTML = `
    <div class="hub-group-picker">${groups.map((group) => `<button type="button" class="${number(group.id) === number(selected?.id) ? "active" : ""}" data-hub-group="${number(group.id)}">${esc(group.name)}</button>`).join("")}</div>
    <div class="hub-section-head"><div><h3>${esc(selected?.name || "Gruppe")}</h3><p class="muted">Ved likt: leg differanse → 3DA → innbyrdes.</p></div><span class="pill">${selectedRows.length} spillere</span></div>
    ${renderMiniGroup(selected, playerId)}
    <div class="hub-section-head hub-history-head"><div><h3>Kamper i gruppen</h3><p class="muted">Pågående først, deretter kommende og ferdige.</p></div></div>
    <div class="hub-match-list">${groupMatches.length ? groupMatches.map((match) => renderMatchCard(match)).join("") : `<p class="muted">Ingen kamper opprettet i gruppen ennå.</p>`}</div>`;
  panel.querySelectorAll("[data-hub-group]").forEach((button) => button.addEventListener("click", () => {
    hubState.selectedGroupId = number(button.dataset.hubGroup);
    renderGroups(panel);
  }));
  bindPanelActions(panel);
}

function matchFilterLabel(filter) {
  return { all: "Alle", live: "Pågår nå", upcoming: "Kommende", completed: "Ferdige", mine: "Mine" }[filter] || filter;
}

function matchVisible(match, filter) {
  if (filter === "live") return String(match.status) === "in_progress";
  if (filter === "upcoming") return ["assigned", "pending"].includes(String(match.status));
  if (filter === "completed") return String(match.status) === "completed";
  if (filter === "mine") return isMyMatch(match);
  return true;
}

function renderMatchCard(match) {
  const completed = String(match.status) === "completed";
  const live = String(match.status) === "in_progress";
  const board = number(match.board_number);
  const aLegs = match.player_a_legs === null || match.player_a_legs === undefined ? null : number(match.player_a_legs);
  const bLegs = match.player_b_legs === null || match.player_b_legs === undefined ? null : number(match.player_b_legs);
  const score = completed && aLegs !== null && bLegs !== null ? `${aLegs}–${bLegs}` : live ? "LIVE" : "–";
  const context = match.group_name || match.bracket_label || match.round_label || "Turnering";
  return `<button type="button" class="hub-match-card ${live ? "is-live" : ""} ${isMyMatch(match) ? "is-mine" : ""}" ${completed ? `data-hub-match="${number(match.id)}"` : "disabled"}>
    <span class="hub-match-context"><span>${esc(context)}${match.round_label && match.round_label !== context ? ` · ${esc(match.round_label)}` : ""}</span><strong>${board ? `Skive ${board}` : esc(statusText(match.status))}</strong></span>
    <span class="hub-match-main"><strong>${esc(match.player_a_name || "Spiller A")}</strong><b>${esc(score)}</b><strong>${esc(match.player_b_name || "Spiller B")}</strong></span>
    <span class="hub-match-meta">${completed ? `<span>3DA ${formatAverage(match.player_a_average)}</span><span>3DA ${formatAverage(match.player_b_average)}</span>` : `<span>${esc(statusText(match.status))}</span><span>${number(match.best_of_legs) ? `Best of ${number(match.best_of_legs)}` : ""}</span>`}</span>
  </button>`;
}

function renderMatches(panel) {
  const filters = ["all", "live", "upcoming", "completed", "mine"];
  const visible = sortMatches(hubState.matches.filter((match) => matchVisible(match, hubState.matchFilter)));
  panel.innerHTML = `
    <div class="hub-match-filters">${filters.map((filter) => `<button type="button" class="${hubState.matchFilter === filter ? "active" : ""}" data-hub-match-filter="${filter}" ${filter === "mine" && !hubState.me?.player?.id ? "disabled" : ""}>${esc(matchFilterLabel(filter))}</button>`).join("")}</div>
    <div class="hub-match-list">${visible.length ? visible.map((match) => renderMatchCard(match)).join("") : `<div class="mini-card"><p class="muted">Ingen kamper i dette filteret akkurat nå.</p></div>`}</div>`;
  panel.querySelectorAll("[data-hub-match-filter]").forEach((button) => button.addEventListener("click", () => {
    hubState.matchFilter = button.dataset.hubMatchFilter || "all";
    renderMatches(panel);
  }));
  bindPanelActions(panel);
}

function playoffNodeStatus(node) {
  const status = String(node.status || "");
  if (status === "in_progress") return node.board_number ? `LIVE · Skive ${number(node.board_number)}` : "LIVE";
  if (status === "assigned") return node.board_number ? `Skive ${number(node.board_number)}` : "Kalt opp";
  return statusText(status);
}

function renderPlayoffs(panel) {
  const bracket = hubState.playoff?.bracket;
  if (!bracket?.playoff) {
    panel.innerHTML = `<div class="mini-card"><strong>Sluttspillet er ikke opprettet ennå</strong><p class="muted">Når gruppespillet er klart og sluttspillet genereres, vises rundene her automatisk.</p></div>`;
    return;
  }
  panel.innerHTML = `
    ${bracket.playoff.champion_name ? `<div class="hub-champion">🏆 <span><small>Turneringsvinner</small><strong>${esc(bracket.playoff.champion_name)}</strong></span></div>` : `<p class="muted hub-playoff-intro">${number(bracket.entries?.length)} kvalifiserte${number(bracket.playoff.qualifiers_per_group) ? ` · topp ${number(bracket.playoff.qualifiers_per_group)} fra hver gruppe` : ""}</p>`}
    <div class="hub-playoff-rounds">${(bracket.rounds || []).map((round) => `<section class="hub-playoff-round"><h3>${esc(round.label)}</h3>${(round.nodes || []).map((node) => `<article class="hub-playoff-match ${String(node.status) === "in_progress" ? "is-live" : ""}">
      <div class="${number(node.winner_player_id) === number(node.player_a_id) ? "winner" : ""}"><button type="button" data-hub-player="${number(node.player_a_id)}" ${node.player_a_id ? "" : "disabled"}>${esc(node.player_a_name || "Venter …")}</button></div>
      <div class="${number(node.winner_player_id) === number(node.player_b_id) ? "winner" : ""}"><button type="button" data-hub-player="${number(node.player_b_id)}" ${node.player_b_id ? "" : "disabled"}>${esc(node.player_b_name || "Venter …")}</button></div>
      <small>${esc(playoffNodeStatus(node))}</small>
    </article>`).join("")}</section>`).join("")}</div>`;
  bindPanelActions(panel);
}

function playerDirectoryEntries() {
  const map = new Map();
  hubState.groups.forEach((group) => (group.players || []).forEach((player) => map.set(number(player.player_id), {
    id: number(player.player_id),
    name: player.display_name,
    nickname: player.nickname,
    groupName: group.name,
    groupId: number(group.id),
  })));
  (hubState.tournament?.registrations || []).forEach((player) => {
    if (!map.has(number(player.player_id))) map.set(number(player.player_id), {
      id: number(player.player_id), name: player.display_name, nickname: player.nickname, groupName: "", groupId: 0,
    });
  });
  for (const entry of map.values()) {
    const table = playerTableRow(entry.id);
    entry.row = table?.row || null;
    entry.groupName = entry.groupName || table?.group?.name || "";
  }
  return [...map.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), "nb"));
}

function renderPlayers(panel) {
  const entries = playerDirectoryEntries();
  panel.innerHTML = `
    <label class="hub-player-search"><span class="sr-only">Søk spiller</span><input type="search" placeholder="Søk spiller …" autocomplete="off" data-hub-player-search></label>
    <div class="hub-player-grid">${entries.map((player) => `<button type="button" class="hub-player-card" data-hub-player="${player.id}" data-hub-player-name="${esc(String(player.name).toLocaleLowerCase("nb-NO"))}"><strong>${esc(player.name)}</strong>${player.nickname ? `<span>${esc(player.nickname)}</span>` : ""}<small>${esc(player.groupName || "Turnering")}${player.row?.position ? ` · #${number(player.row.position)}` : ""}${player.row ? ` · ${number(player.row.played)} kamper · 3DA ${formatAverage(player.row.three_dart_average)}` : ""}</small></button>`).join("")}</div>`;
  const input = panel.querySelector("[data-hub-player-search]");
  input?.addEventListener("input", () => {
    const query = String(input.value || "").trim().toLocaleLowerCase("nb-NO");
    panel.querySelectorAll("[data-hub-player-name]").forEach((card) => {
      card.hidden = Boolean(query) && !String(card.dataset.hubPlayerName || "").includes(query);
    });
  });
  bindPanelActions(panel);
}

function renderPlayerSheet(playerId) {
  const entry = playerDirectoryEntries().find((player) => number(player.id) === number(playerId));
  if (!entry) return;
  const table = playerTableRow(playerId);
  const row = table?.row || null;
  const matches = sortMatches(hubState.matches.filter((match) => [number(match.player_a_id), number(match.player_b_id)].includes(number(playerId))));
  const sheet = document.createElement("div");
  sheet.className = "hub-player-sheet-backdrop";
  sheet.innerHTML = `<article class="hub-player-sheet" role="dialog" aria-modal="true" aria-label="${esc(entry.name)}">
    <div class="hub-player-sheet-head"><div><p class="eyebrow">I denne turneringen</p><h2>${esc(entry.name)}</h2><p class="muted">${esc(entry.groupName || "Turnering")}${row?.position ? ` · #${number(row.position)}` : ""}</p></div><button type="button" class="ghost" data-hub-close-player>Lukk</button></div>
    <div class="hub-stats-grid hub-player-sheet-stats">
      ${statCard("Kamper", row ? number(row.played) : matches.filter((match) => String(match.status) === "completed").length)}
      ${statCard("Seire", row ? number(row.wins) : "—")}
      ${statCard("Tap", row ? number(row.losses) : "—")}
      ${statCard("Leg +/−", row ? `${number(row.leg_diff) > 0 ? "+" : ""}${number(row.leg_diff)}` : "—")}
      ${statCard("3DA", row ? formatAverage(row.three_dart_average) : "—")}
      ${statCard("Poeng", row ? number(row.points) : "—")}
    </div>
    <div class="hub-section-head"><div><h3>Kamper</h3><p class="muted">Ferdige kamper kan åpnes for detaljer.</p></div></div>
    <div class="hub-match-list">${matches.length ? matches.map((match) => renderMatchCard(match)).join("") : `<p class="muted">Ingen kamper registrert.</p>`}</div>
    <button type="button" class="ghost hub-full-profile" data-hub-full-profile="${number(playerId)}">Se full spillerprofil</button>
  </article>`;
  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  sheet.addEventListener("click", (event) => { if (event.target === sheet) close(); });
  sheet.querySelector("[data-hub-close-player]")?.addEventListener("click", close);
  sheet.querySelectorAll("[data-hub-match]").forEach((button) => button.addEventListener("click", () => openHubMatchDetail(number(button.dataset.hubMatch))));
  sheet.querySelector("[data-hub-full-profile]")?.addEventListener("click", () => {
    close();
    openFullProfile(playerId);
  });
}

function openFullProfile(playerId) {
  window.location.hash = "statistics";
  window.setTimeout(() => {
    document.querySelector('[data-statistics-view="players"]')?.click();
    window.setTimeout(() => document.querySelector(`#playerDirectory [data-player-profile="${number(playerId)}"]`)?.click(), 100);
  }, 100);
}

function bindPanelActions(panel) {
  panel.querySelectorAll("[data-hub-player]").forEach((button) => {
    const playerId = number(button.dataset.hubPlayer);
    if (playerId > 0) button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      renderPlayerSheet(playerId);
    });
  });
  panel.querySelectorAll("[data-hub-match]").forEach((button) => button.addEventListener("click", () => openHubMatchDetail(number(button.dataset.hubMatch))));
}

function renderActivePanel() {
  const panel = hubRoot.querySelector("#tournamentHubPanel");
  if (!panel) return;
  if (hubState.activeView === "groups") return renderGroups(panel);
  if (hubState.activeView === "matches") return renderMatches(panel);
  if (hubState.activeView === "playoffs") return renderPlayoffs(panel);
  if (hubState.activeView === "players") return renderPlayers(panel);
  return renderMine(panel);
}

function matchStatRow(label, a, b, digits = 0, suffix = "") {
  const val = (value) => value === null || value === undefined || value === "" ? "—" : Number(value).toFixed(digits) + suffix;
  return `<div class="match-stat-row"><strong>${esc(val(a))}</strong><span>${esc(label)}</span><strong>${esc(val(b))}</strong></div>`;
}

async function openHubMatchDetail(matchId) {
  const dialog = document.getElementById("matchDetailDialog");
  const content = document.getElementById("matchDetailContent");
  if (!dialog || !content || !matchId) return;
  content.innerHTML = `<p class="muted">Henter kamp …</p>`;
  if (!dialog.open) {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }
  try {
    const data = await hubApi(`/matches/${matchId}/detail`);
    const match = data.match || {};
    const a = data.player_a_stats || {};
    const b = data.player_b_stats || {};
    const visitsByLeg = new Map();
    (data.visits || []).forEach((visit) => {
      const key = number(visit.leg_number);
      if (!visitsByLeg.has(key)) visitsByLeg.set(key, []);
      visitsByLeg.get(key).push(visit);
    });
    content.innerHTML = `
      <div class="match-detail-head"><div><p class="eyebrow">${esc(match.tournament_name || hubState.tournament?.name)}</p><h2>${esc(match.player_a_name)} ${number(a.legs_won)}–${number(b.legs_won)} ${esc(match.player_b_name)}</h2><p class="muted">${esc(match.round_label || match.bracket_label || "Kamp")}${match.board_number ? ` · Skive ${number(match.board_number)}` : ""}</p></div><button type="button" class="ghost match-detail-close">Lukk</button></div>
      <div class="match-stat-board">
        <div class="match-stat-names"><strong>${esc(match.player_a_name)}</strong><span></span><strong>${esc(match.player_b_name)}</strong></div>
        ${matchStatRow("3DA", a.average, b.average, 2)}
        ${matchStatRow("First 9", a.first_nine_average, b.first_nine_average, 2)}
        ${matchStatRow("Checkout", a.checkout_percentage, b.checkout_percentage, 1, "%")}
        ${matchStatRow("Høy checkout", a.highest_checkout, b.highest_checkout)}
        ${matchStatRow("100+", a.score_100_plus, b.score_100_plus)}
        ${matchStatRow("140+", a.score_140_plus, b.score_140_plus)}
        ${matchStatRow("180", a.score_180, b.score_180)}
      </div>
      <div class="match-legs"><h3>Legs</h3>${(data.legs || []).length ? (data.legs || []).map((leg) => {
        const winner = number(leg.winner_player_id) === number(match.player_a_id) ? match.player_a_name : number(leg.winner_player_id) === number(match.player_b_id) ? match.player_b_name : "—";
        const visits = visitsByLeg.get(number(leg.leg_number)) || [];
        return `<article class="leg-card"><button type="button" class="leg-card-toggle" data-hub-leg="${number(leg.leg_number)}"><span><strong>Leg ${number(leg.leg_number)}</strong><small>${esc(winner)} vant</small></span><span>${formatAverage(leg.player_a_average)} · ${formatAverage(leg.player_b_average)}</span></button><div class="leg-visits hidden" data-hub-leg-visits="${number(leg.leg_number)}">${visits.length ? visits.map((visit) => `<div class="visit-row"><span>${number(visit.player_id) === number(match.player_a_id) ? esc(match.player_a_name) : esc(match.player_b_name)}</span><strong>${number(visit.score)}</strong><span>${visit.is_bust ? "Bust" : `${number(visit.remaining_after)} igjen`}</span></div>`).join("") : `<p class="muted">Ingen kastdetaljer lagret for dette leget.</p>`}</div></article>`;
      }).join("") : `<p class="muted">Ingen leg-detaljer lagret for denne kampen.</p>`}</div>`;
    content.querySelector(".match-detail-close")?.addEventListener("click", () => dialog.close?.());
    content.querySelectorAll("[data-hub-leg]").forEach((button) => button.addEventListener("click", () => content.querySelector(`[data-hub-leg-visits="${button.dataset.hubLeg}"]`)?.classList.toggle("hidden")));
  } catch (error) {
    content.innerHTML = `<div class="match-detail-head"><div><h2>Kunne ikke hente kampen</h2><p class="muted">${esc(error?.message || "Ukjent feil")}</p></div><button type="button" class="ghost match-detail-close">Lukk</button></div>`;
    content.querySelector(".match-detail-close")?.addEventListener("click", () => dialog.close?.());
  }
}

function chooseActiveTournament(tournaments, dashboard) {
  const registrations = Array.isArray(dashboard?.registrations) ? dashboard.registrations : [];
  const byId = new Map((tournaments || []).map((tournament) => [number(tournament.id), tournament]));
  const statusWeight = { checked_in: 0, paused: 1, registered: 2, eliminated: 3 };
  const candidates = registrations
    .filter((registration) => Object.hasOwn(statusWeight, String(registration.status || "")))
    .map((registration) => ({ registration, tournament: byId.get(number(registration.tournament_id)) }))
    .filter((entry) => entry.tournament && isLiveTournament(entry.tournament))
    .sort((a, b) => (statusWeight[String(a.registration.status)] ?? 9) - (statusWeight[String(b.registration.status)] ?? 9));
  if (candidates[0]) return candidates[0];
  const publicTournament = (tournaments || []).find((tournament) => String(tournament.status) === "in_progress")
    || (tournaments || []).find((tournament) => String(tournament.status) === "ready")
    || null;
  return publicTournament ? { tournament: publicTournament, registration: null } : null;
}

async function loadTournamentHub({ force = false } = {}) {
  if (hubState.loading) return;
  if (!force && Date.now() - hubState.lastLoadedAt < 3000) return;
  const clubId = hubClubId();
  if (!clubId) {
    hubRoot.classList.add("hidden");
    return;
  }
  hubState.loading = true;
  try {
    const token = hubToken();
    const [tournamentsData, meData, dashboardData] = await Promise.all([
      hubApi(`/clubs/${clubId}/registration-tournaments`),
      token ? hubApi("/auth/me", { auth: true }).catch(() => null) : Promise.resolve(null),
      token ? hubApi("/me/dashboard", { auth: true }).catch(() => null) : Promise.resolve(null),
    ]);
    hubState.me = meData?.user || null;
    const choice = chooseActiveTournament(tournamentsData.items || [], dashboardData?.dashboard || null);
    if (!choice) {
      hubState.tournamentId = 0;
      hubRoot.classList.add("hidden");
      return;
    }
    const tournamentId = number(choice.tournament.id);
    hubState.registration = choice.registration || null;
    const [tournamentData, groupsData, tablesData, matchesData, resultsData, playoffData] = await Promise.all([
      hubApi(`/tournaments/${tournamentId}`),
      hubApi(`/tournaments/${tournamentId}/groups`).catch(() => ({ groups: [] })),
      hubApi(`/tournaments/${tournamentId}/tables`).catch(() => ({ groups: [] })),
      hubApi(`/tournaments/${tournamentId}/matches`).catch(() => ({ items: [] })),
      hubApi(`/tournaments/${tournamentId}/results`).catch(() => ({ items: [] })),
      hubApi(`/tournaments/${tournamentId}/playoffs`).catch(() => ({ bracket: null })),
    ]);
    hubState.tournamentId = tournamentId;
    hubState.tournament = tournamentData.tournament || choice.tournament;
    hubState.groups = groupsData.groups || [];
    hubState.tables = tablesData.groups || [];
    hubState.results = resultsData.items || [];
    hubState.matches = mergedMatches(matchesData.items || hubState.tournament?.matches || [], hubState.results);
    hubState.playoff = playoffData || null;
    const myGroup = findPlayerGroup(number(hubState.me?.player?.id));
    if (!hubState.selectedGroupId || !hubState.groups.some((group) => number(group.id) === number(hubState.selectedGroupId))) hubState.selectedGroupId = number(myGroup?.id || hubState.groups[0]?.id || 0);
    hubState.lastLoadedAt = Date.now();
    renderShell();
  } catch (error) {
    hubRoot.classList.remove("hidden");
    hubRoot.innerHTML = `<div class="mini-card"><strong>Kunne ikke hente turneringen</strong><p class="muted">${esc(error?.message || "Ukjent feil")}</p><button type="button" class="ghost" data-hub-retry>Prøv igjen</button></div>`;
    hubRoot.querySelector("[data-hub-retry]")?.addEventListener("click", () => loadTournamentHub({ force: true }));
  } finally {
    hubState.loading = false;
  }
}

function refreshHubSoon() {
  window.setTimeout(() => loadTournamentHub({ force: true }).catch(() => undefined), 50);
}

document.getElementById("refreshButton")?.addEventListener("click", refreshHubSoon);
document.getElementById("clubSelect")?.addEventListener("change", refreshHubSoon);
window.addEventListener("focus", () => loadTournamentHub().catch(() => undefined));
window.addEventListener("hashchange", () => {
  if (window.location.hash === "#tournaments") loadTournamentHub({ force: true }).catch(() => undefined);
});

window.setInterval(() => {
  if (!document.hidden && hubState.tournamentId) loadTournamentHub({ force: true }).catch(() => undefined);
}, HUB_REFRESH_MS);

loadTournamentHub({ force: true }).catch(() => undefined);
