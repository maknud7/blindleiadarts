const stylesheet = document.createElement("link");
stylesheet.rel = "stylesheet";
stylesheet.href = new URL("./statistics-ux.css?v=20260827-1510", import.meta.url).href;
document.head.appendChild(stylesheet);

const API_ROOT = "../api/v1";
const root = document.getElementById("statistics");
const seasonRoot = document.getElementById("seasonStandings");
const playerRoot = document.getElementById("playerDirectory");
const profileRoot = document.getElementById("playerProfile");
const search = document.getElementById("playerSearch");
let currentView = "season";
let seasons = [];
let selectedSeasonId = 0;
let seasonLoading = false;
let seasonRepairQueued = false;
let enhancing = false;
const profileCache = new Map();

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function norm(value) {
  return String(value || "").trim().toLocaleLowerCase("nb-NO").replace(/\s+/g, " ");
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

async function api(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${API_ROOT}${path}`, { cache: "no-store", signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  } finally {
    clearTimeout(timer);
  }
}

function activate(view) {
  if (!root) return;
  const available = new Set([...root.querySelectorAll("[data-statistics-panel]")].map((node) => node.dataset.statisticsPanel));
  currentView = available.has(view) ? view : "season";
  root.querySelectorAll("[data-statistics-view]").forEach((button) => {
    const active = button.dataset.statisticsView === currentView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
    button.tabIndex = active ? 0 : -1;
  });
  root.querySelectorAll("[data-statistics-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.statisticsPanel !== currentView));
}

function prepareTabs() {
  root?.querySelector('[data-statistics-view="elo"]')?.remove();
  root?.querySelector('[data-statistics-panel="elo"]')?.remove();
  const tabs = root?.querySelector(".statistics-tabs");
  if (tabs) tabs.dataset.tabCount = String(tabs.querySelectorAll("[data-statistics-view]").length);
}

function filterPlayers() {
  if (!playerRoot || !search) return;
  const query = norm(search.value);
  let visible = 0;
  playerRoot.querySelectorAll(".player-card").forEach((card) => {
    const show = !query || norm(card.textContent).includes(query);
    card.hidden = !show;
    if (show) visible += 1;
  });
  let empty = playerRoot.querySelector(".statistics-empty-search");
  if (query && !visible) {
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "statistics-empty-search";
      empty.textContent = "Ingen spillere matcher søket.";
      playerRoot.appendChild(empty);
    }
  } else empty?.remove();
}

function sortValue(cell, type) {
  const raw = cell?.dataset.sortValue ?? cell?.textContent ?? "";
  if (type !== "number") return norm(raw);
  const number = Number(String(raw).replace(/\s/g, "").replace(",", ".").replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(number) ? number : Number.NEGATIVE_INFINITY;
}

function sortTable(table, header) {
  const tbody = table.tBodies?.[0];
  if (!tbody) return;
  const headers = [...header.parentElement.children];
  const column = headers.indexOf(header);
  const type = header.dataset.sortType || "text";
  const current = header.getAttribute("aria-sort");
  const first = header.dataset.sortDefault || (type === "number" ? "descending" : "ascending");
  const direction = current === "ascending" ? "descending" : current === "descending" ? "ascending" : first;
  headers.forEach((th) => { th.removeAttribute("aria-sort"); th.classList.remove("statistics-sorted"); });
  header.setAttribute("aria-sort", direction);
  header.classList.add("statistics-sorted");
  const rows = [...tbody.rows].map((row, index) => ({ row, index }));
  rows.sort((a, b) => {
    const av = sortValue(a.row.cells[column], type);
    const bv = sortValue(b.row.cells[column], type);
    let cmp = type === "number" ? (av < bv ? -1 : av > bv ? 1 : 0) : String(av).localeCompare(String(bv), "nb", { numeric: true, sensitivity: "base" });
    if (direction === "descending") cmp *= -1;
    return cmp || a.index - b.index;
  });
  rows.forEach(({ row }) => tbody.appendChild(row));
}

function bindSorting() {
  root?.querySelectorAll("table.portal-table").forEach((table) => table.querySelectorAll("thead th").forEach((th) => {
    if (th.dataset.sortBound === "1") return;
    th.dataset.sortBound = "1";
    th.tabIndex = 0;
    th.classList.add("statistics-sortable");
    th.setAttribute("role", "button");
    const run = () => sortTable(table, th);
    th.addEventListener("click", run);
    th.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      run();
    });
  }));
}

function currentClubId() {
  return Number(localStorage.getItem("bd:playerClubId") || document.getElementById("clubSelect")?.value || 0);
}

function ensureSeasonChooser() {
  const head = root?.querySelector('[data-statistics-panel="season"] .statistics-panel-head');
  if (!head) return null;
  let label = head.querySelector(".statistics-season-chooser");
  if (label) return label;
  label = document.createElement("label");
  label.className = "statistics-season-chooser";
  label.innerHTML = `<span>Sesong</span><select aria-label="Velg sesong"></select>`;
  head.appendChild(label);
  label.querySelector("select")?.addEventListener("change", (event) => {
    selectedSeasonId = Number(event.currentTarget.value || 0);
    if (selectedSeasonId) localStorage.setItem("bd:statisticsSeasonId", String(selectedSeasonId));
    renderSeason().catch(() => undefined);
  });
  return label;
}

function seasonOption(season) {
  const status = season.is_active ? "Aktiv" : season.status === "completed" ? "Avsluttet" : "Sesong";
  return `${season.name}${season.starts_on ? ` · ${formatDate(season.starts_on)}` : ""} · ${status}`;
}

async function loadSeasons() {
  const clubId = currentClubId();
  if (!clubId) return;
  const data = await api(`/clubs/${clubId}/seasons`);
  seasons = data.items || [];
  if (!seasons.length) return;
  const remembered = Number(localStorage.getItem("bd:statisticsSeasonId") || 0);
  const active = seasons.find((season) => season.is_active) || seasons[0];
  selectedSeasonId = seasons.some((season) => Number(season.id) === remembered) ? remembered : Number(active.id);
  const chooser = ensureSeasonChooser();
  const select = chooser?.querySelector("select");
  if (select) {
    select.innerHTML = seasons.map((season) => `<option value="${Number(season.id)}">${esc(seasonOption(season))}</option>`).join("");
    select.value = String(selectedSeasonId);
  }
  chooser?.classList.toggle("single-season", seasons.length === 1);
  await renderSeason();
}

function pointsText(value) {
  return Number(value || 0).toLocaleString("nb-NO", { maximumFractionDigits: 2 });
}

async function renderSeason() {
  if (!seasonRoot || !selectedSeasonId || seasonLoading) return;
  seasonLoading = true;
  seasonRoot.innerHTML = `<div class="statistics-loading"><span></span>Henter sesongtabell …</div>`;
  try {
    const data = await api(`/seasons/${selectedSeasonId}/standings`);
    const season = data.season || seasons.find((item) => Number(item.id) === selectedSeasonId) || {};
    const primary = season.ranking_method === "elo" ? "ELO" : "poeng";
    seasonRoot.innerHTML = `
      <div class="season-table-heading"><div><strong>${esc(season.name || "Sesong")}</strong><p class="tie-break-note">Offisiell rekkefølge: ${primary} → leg differanse → 3DA → innbyrdes.</p></div><span class="pill">${season.status === "active" ? "Aktiv" : season.status === "completed" ? "Avsluttet" : "Sesong"}</span></div>
      <div class="table-scroll"><table class="portal-table season-table combined-season-table" data-combined-season="${selectedSeasonId}">
        <thead><tr><th data-sort-type="number" data-sort-default="ascending">Plass</th><th data-sort-type="text" data-sort-default="ascending">Spiller</th><th data-sort-type="number">Poeng</th><th data-sort-type="number">ELO</th><th data-sort-type="number">K</th><th data-sort-type="number">V</th><th data-sort-type="number">U</th><th data-sort-type="number">T</th><th data-sort-type="number" title="Leg differanse">Leg +/−</th><th data-sort-type="number">3DA</th></tr></thead>
        <tbody>${(data.items || []).map((row) => `<tr data-player-profile="${Number(row.id)}"><td data-sort-value="${Number(row.position)}"><strong>${Number(row.position)}</strong></td><td data-sort-value="${esc(row.display_name)}"><strong>${esc(row.display_name)}</strong>${row.nickname ? `<small>${esc(row.nickname)}</small>` : ""}</td><td data-sort-value="${Number(row.points || 0)}"><strong>${pointsText(row.points)}</strong></td><td data-sort-value="${Number(row.elo_rating || 1000)}"><span class="elo-table-value">${Number(row.elo_rating || 1000).toFixed(1)}</span></td><td data-sort-value="${Number(row.matches_played || 0)}">${Number(row.matches_played || 0)}</td><td data-sort-value="${Number(row.wins || 0)}">${Number(row.wins || 0)}</td><td data-sort-value="${Number(row.draws || 0)}">${Number(row.draws || 0)}</td><td data-sort-value="${Number(row.losses || 0)}">${Number(row.losses || 0)}</td><td data-sort-value="${Number(row.leg_diff || 0)}"><span class="leg-diff ${Number(row.leg_diff || 0) > 0 ? "positive" : Number(row.leg_diff || 0) < 0 ? "negative" : ""}">${Number(row.leg_diff || 0) > 0 ? "+" : ""}${Number(row.leg_diff || 0)}</span></td><td data-sort-value="${Number(row.three_dart_average || 0)}">${Number(row.three_dart_average || 0) > 0 ? Number(row.three_dart_average).toFixed(2) : "—"}</td></tr>`).join("")}</tbody>
      </table></div>`;
    seasonRoot.querySelectorAll("[data-player-profile]").forEach((row) => row.addEventListener("click", () => {
      activate("players");
      document.querySelector(`#playerDirectory [data-player-profile="${Number(row.dataset.playerProfile)}"]`)?.click();
    }));
    bindSorting();
  } catch (error) {
    seasonRoot.innerHTML = `<div class="mini-card"><p class="muted">${esc(error.message || "Kunne ikke hente sesongtabellen.")}</p></div>`;
  } finally {
    seasonLoading = false;
  }
}

function queueSeasonRepair() {
  if (!seasonRoot || !selectedSeasonId || seasonLoading || seasonRepairQueued) return;
  if (seasonRoot.querySelector(`[data-combined-season="${selectedSeasonId}"]`)) return;
  seasonRepairQueued = true;
  setTimeout(() => {
    seasonRepairQueued = false;
    if (!seasonRoot.querySelector(`[data-combined-season="${selectedSeasonId}"]`)) renderSeason().catch(() => undefined);
  }, 100);
}

function buildMovements(profile) {
  const history = (profile.elo_history || []).map((item) => ({ ...item, rating: Number(item.rating), tournament_id: Number(item.tournament_id || 0) })).filter((item) => Number.isFinite(item.rating));
  const movements = history.map((item, index) => {
    const before = history[index + 1]?.rating;
    const after = item.rating;
    return { ...item, before: Number.isFinite(before) ? Number(before) : null, after, delta: Number.isFinite(before) ? Number((after - before).toFixed(1)) : null, used: false };
  });
  const grouped = new Map();
  movements.forEach((item) => {
    if (!item.tournament_id) return;
    if (!grouped.has(item.tournament_id)) grouped.set(item.tournament_id, []);
    grouped.get(item.tournament_id).push(item);
  });
  const byMatch = new Map();
  (profile.recent_matches || []).forEach((match) => {
    const movement = (grouped.get(Number(match.tournament_id || 0)) || []).find((item) => !item.used);
    if (!movement) return;
    movement.used = true;
    movement.match = match;
    byMatch.set(Number(match.id), movement);
  });
  return { movements, byMatch };
}

function movementClass(delta) {
  if (delta === null || Math.abs(Number(delta)) < .05) return "neutral";
  return Number(delta) > 0 ? "positive" : "negative";
}

function movementHtml(item, compact = false) {
  if (!item || item.before === null) return "";
  const delta = Number(item.delta || 0);
  const deltaText = `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`;
  return `<span class="elo-movement ${movementClass(delta)}${compact ? " compact" : ""}"><span class="elo-movement-label">ELO</span><span class="elo-before">${item.before.toFixed(1)}</span><span class="elo-arrow">→</span><strong class="elo-after">${item.after.toFixed(1)}</strong><b class="elo-delta">${deltaText}</b></span>`;
}

function renderProfileElo(profile, playerId) {
  if (!profileRoot || profileRoot.classList.contains("hidden")) return;
  const { movements, byMatch } = buildMovements(profile);
  profileRoot.querySelectorAll(".profile-match-history [data-match-detail]").forEach((row) => {
    if (row.querySelector(".elo-movement")) return;
    const movement = byMatch.get(Number(row.dataset.matchDetail || 0));
    if (!movement) return;
    const date = row.querySelector(":scope > span");
    if (date) date.insertAdjacentHTML("beforebegin", movementHtml(movement, true));
    else row.insertAdjacentHTML("beforeend", movementHtml(movement, true));
  });

  const eloSection = [...profileRoot.querySelectorAll(".profile-section")].find((section) => norm(section.querySelector("h3")?.textContent).includes("elo-historikk") || norm(section.querySelector("h3")?.textContent).includes("elo-utvikling"));
  if (!eloSection || eloSection.dataset.eloTimelinePlayer === String(playerId)) return;
  eloSection.dataset.eloTimelinePlayer = String(playerId);
  const usable = movements.filter((item) => item.before !== null).slice(0, 16);
  eloSection.innerHTML = `<div class="section-head"><div><h3>ELO-utvikling</h3><p class="muted">Startverdi, ny rating og endring etter hver ferdig kamp.</p></div></div><div class="elo-timeline">${usable.length ? usable.map((item) => {
    const match = item.match;
    const result = match ? (match.result === "win" ? "Seier" : match.result === "draw" ? "Uavgjort" : "Tap") : "ELO-oppdatering";
    const context = match ? `${result} mot ${esc(match.opponent_name || "motstander")}` : esc(item.tournament_name || result);
    return `<div class="elo-timeline-row"><div class="elo-timeline-context"><strong>${context}</strong><small>${esc(item.tournament_name || "")}${item.calculated_at ? ` · ${esc(formatDate(item.calculated_at))}` : ""}</small></div>${movementHtml(item)}</div>`;
  }).join("") : `<p class="muted">Ingen kampvise ELO-endringer registrert ennå.</p>`}</div>`;
}

async function enhanceProfile() {
  if (!profileRoot || profileRoot.classList.contains("hidden")) return;
  const playerId = Number(profileRoot.querySelector(".profile-all-matches[data-player]")?.dataset.player || 0);
  if (!playerId) return;
  try {
    let profile = profileCache.get(playerId);
    if (!profile) {
      profile = await api(`/players/${playerId}/profile`);
      profileCache.set(playerId, profile);
    }
    renderProfileElo(profile, playerId);
  } catch {}
}

function enhance() {
  if (!root || enhancing) return;
  enhancing = true;
  try {
    prepareTabs();
    filterPlayers();
    bindSorting();
    activate(currentView);
    queueSeasonRepair();
  } finally {
    enhancing = false;
  }
}

function initialize() {
  if (!root) return;
  prepareTabs();
  ensureSeasonChooser();
  root.querySelectorAll("[data-statistics-view]").forEach((button) => {
    button.addEventListener("click", () => activate(button.dataset.statisticsView));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      const buttons = [...root.querySelectorAll("[data-statistics-view]")];
      const index = buttons.indexOf(button);
      buttons[(index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length]?.click();
    });
  });
  search?.addEventListener("input", filterPlayers);

  const contentObserver = new MutationObserver(() => requestAnimationFrame(enhance));
  [seasonRoot, playerRoot].filter(Boolean).forEach((node) => contentObserver.observe(node, { childList: true, subtree: true }));
  if (profileRoot) {
    const profileObserver = new MutationObserver(() => requestAnimationFrame(enhanceProfile));
    profileObserver.observe(profileRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  }

  window.addEventListener("bd:portal-view", (event) => {
    if (event.detail?.target !== "statistics") return;
    enhance();
    if (!seasons.length) loadSeasons().catch(() => undefined);
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== "bd:playerClubId") return;
    seasons = [];
    selectedSeasonId = 0;
    loadSeasons().catch(() => undefined);
  });

  activate("season");
  enhance();
  loadSeasons().catch((error) => {
    if (seasonRoot) seasonRoot.innerHTML = `<div class="mini-card"><p class="muted">${esc(error.message || "Kunne ikke hente sesongene.")}</p></div>`;
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
else initialize();
