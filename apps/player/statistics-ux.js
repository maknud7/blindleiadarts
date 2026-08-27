const stylesheet = document.createElement("link");
stylesheet.rel = "stylesheet";
stylesheet.href = new URL("./statistics-ux.css?v=20260827-1510", import.meta.url).href;
document.head.appendChild(stylesheet);

const API_ROOT = "../api/v1";
const root = document.getElementById("statistics");
const search = document.getElementById("playerSearch");
const seasonStandings = document.getElementById("seasonStandings");
const playerProfile = document.getElementById("playerProfile");
let currentView = "season";
let applying = false;
let observer = null;
let profileObserver = null;
let seasonItems = [];
let selectedSeasonId = 0;
let seasonLoading = false;
let seasonRenderQueued = false;
let profileRequestId = 0;
const profileCache = new Map();

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeName(value) {
  return String(value || "").trim().toLocaleLowerCase("nb-NO").replace(/\s+/g, " ");
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

async function api(path) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${API_ROOT}${path}`, { cache: "no-store", signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  } finally {
    window.clearTimeout(timeout);
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

function simplifyStatisticsTabs() {
  root?.querySelector('[data-statistics-view="elo"]')?.remove();
  root?.querySelector('[data-statistics-panel="elo"]')?.remove();
  const tabs = root?.querySelector(".statistics-tabs");
  if (tabs) tabs.dataset.tabCount = String(tabs.querySelectorAll("[data-statistics-view]").length);
}

function numericCell(row, index) {
  const raw = row.children[index]?.textContent?.replace(/[^0-9,.-]/g, "").replace(",", ".") || "0";
  const number = Number(raw);
  return Number.isFinite(number) ? number : 0;
}

function dedupeRows(selector, keyFactory, qualityFactory) {
  const rows = [...root.querySelectorAll(selector)];
  const best = new Map();
  rows.forEach((row) => {
    const key = keyFactory(row);
    if (!key) return;
    const quality = qualityFactory(row);
    const existing = best.get(key);
    if (!existing || quality > existing.quality) {
      if (existing) existing.row.remove();
      best.set(key, { row, quality });
    } else row.remove();
  });
}

function cleanupDuplicatePublicRows() {
  if (!root) return;
  dedupeRows(
    "#seasonStandings tbody tr",
    (row) => `${normalizeName(row.children[1]?.textContent)}|${numericCell(row, 2)}|${numericCell(row, 8)}`,
    (row) => numericCell(row, 3) * 1000 + numericCell(row, 9)
  );
  const cards = [...root.querySelectorAll("#playerDirectory .player-card")];
  const seen = new Map();
  cards.forEach((card) => {
    const name = normalizeName(card.querySelector(".player-card-name")?.textContent);
    const meta = normalizeName(card.querySelector(".player-card-meta")?.textContent);
    const key = `${name}|${meta}`;
    if (!name) return;
    if (seen.has(key)) card.remove();
    else seen.set(key, card);
  });
}

function filterPlayers() {
  if (!root || !search) return;
  const query = normalizeName(search.value);
  const cards = [...root.querySelectorAll("#playerDirectory .player-card")];
  let visible = 0;
  cards.forEach((card) => {
    const show = !query || normalizeName(card.textContent).includes(query);
    card.hidden = !show;
    if (show) visible += 1;
  });
  let empty = root.querySelector(".statistics-empty-search");
  if (query && visible === 0) {
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "statistics-empty-search";
      empty.textContent = "Ingen spillere matcher søket.";
      document.getElementById("playerDirectory")?.appendChild(empty);
    }
  } else empty?.remove();
}

function sortValue(cell, type) {
  const text = cell?.dataset.sortValue ?? cell?.textContent ?? "";
  if (type === "number") {
    const normalized = String(text).replace(/\s/g, "").replace(",", ".").replace(/[^0-9.+-]/g, "");
    const value = Number(normalized);
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
  }
  return normalizeName(text);
}

function sortTable(table, th) {
  const tbody = table.tBodies?.[0];
  if (!tbody) return;
  const headers = [...th.parentElement.children];
  const column = headers.indexOf(th);
  if (column < 0) return;
  const type = th.dataset.sortType || "text";
  const current = th.getAttribute("aria-sort");
  const firstDirection = th.dataset.sortDefault || (type === "number" ? "descending" : "ascending");
  const direction = current === "ascending" ? "descending" : current === "descending" ? "ascending" : firstDirection;
  headers.forEach((header) => {
    header.removeAttribute("aria-sort");
    header.classList.remove("statistics-sorted");
  });
  th.setAttribute("aria-sort", direction);
  th.classList.add("statistics-sorted");
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

function bindSortableTables() {
  root?.querySelectorAll("table.portal-table").forEach((table) => {
    table.querySelectorAll("thead th").forEach((th) => {
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
    });
  });
}

function clubId() {
  return Number(localStorage.getItem("bd:playerClubId") || document.getElementById("clubSelect")?.value || 0);
}

function seasonLabel(season) {
  const state = season.is_active ? "Aktiv" : season.status === "completed" ? "Avsluttet" : "Sesong";
  return `${season.name}${season.starts_on ? ` · ${formatDate(season.starts_on)}` : ""} · ${state}`;
}

function ensureSeasonChooser() {
  const panel = root?.querySelector('[data-statistics-panel="season"]');
  const head = panel?.querySelector(".statistics-panel-head");
  if (!head) return null;
  let chooser = head.querySelector(".statistics-season-chooser");
  if (!chooser) {
    chooser = document.createElement("label");
    chooser.className = "statistics-season-chooser";
    chooser.innerHTML = `<span>Sesong</span><select id="statisticsSeasonSelect" aria-label="Velg sesong"></select>`;
    head.appendChild(chooser);
    chooser.querySelector("select")?.addEventListener("change", (event) => {
      selectedSeasonId = Number(event.currentTarget.value || 0);
      if (selectedSeasonId) localStorage.setItem("bd:statisticsSeasonId", String(selectedSeasonId));
      renderSelectedSeason().catch(() => undefined);
    });
  }
  return chooser;
}

async function loadSeasons() {
  const id = clubId();
  if (!id) return;
  const data = await api(`/clubs/${id}/seasons`);
  seasonItems = data.items || [];
  if (!seasonItems.length) return;
  const remembered = Number(localStorage.getItem("bd:statisticsSeasonId") || 0);
  const active = seasonItems.find((season) => season.is_active) || seasonItems[0];
  selectedSeasonId = seasonItems.some((season) => Number(season.id) === remembered) ? remembered : Number(active.id);
  const chooser = ensureSeasonChooser();
  const select = chooser?.querySelector("select");
  if (select) {
    select.innerHTML = seasonItems.map((season) => `<option value="${Number(season.id)}">${esc(seasonLabel(season))}</option>`).join("");
    select.value = String(selectedSeasonId);
  }
  chooser?.classList.toggle("single-season", seasonItems.length === 1);
  await renderSelectedSeason();
}

function pointsText(value) {
  return Number(value || 0).toLocaleString("nb-NO", { maximumFractionDigits: 2 });
}

async function renderSelectedSeason() {
  if (!seasonStandings || !selectedSeasonId || seasonLoading) return;
  seasonLoading = true;
  seasonStandings.innerHTML = `<div class="statistics-loading"><span></span>Henter sesongtabell …</div>`;
  try {
    const data = await api(`/seasons/${selectedSeasonId}/standings`);
    const season = data.season || seasonItems.find((item) => Number(item.id) === selectedSeasonId) || {};
    const rows = data.items || [];
    seasonStandings.innerHTML = `
      <div class="season-table-heading">
        <div><strong>${esc(season.name || "Sesong")}</strong><p class="tie-break-note">Offisiell rekkefølge: poeng → leg differanse → 3DA → innbyrdes.</p></div>
        <span class="pill">${season.status === "active" ? "Aktiv" : season.status === "completed" ? "Avsluttet" : "Sesong"}</span>
      </div>
      <div class="table-scroll"><table class="portal-table season-table combined-season-table" data-combined-season="${Number(selectedSeasonId)}">
        <thead><tr>
          <th data-sort-type="number" data-sort-default="ascending" title="Offisiell plassering">Plass</th>
          <th data-sort-type="text" data-sort-default="ascending">Spiller</th>
          <th data-sort-type="number">Poeng</th><th data-sort-type="number">ELO</th><th data-sort-type="number">K</th><th data-sort-type="number">V</th><th data-sort-type="number">U</th><th data-sort-type="number">T</th><th data-sort-type="number" title="Leg differanse">Leg +/−</th><th data-sort-type="number">3DA</th>
        </tr></thead>
        <tbody>${rows.map((row) => `<tr data-player-profile="${Number(row.id)}">
          <td data-sort-value="${Number(row.position)}"><strong>${Number(row.position)}</strong></td>
          <td data-sort-value="${esc(row.display_name)}"><strong>${esc(row.display_name)}</strong>${row.nickname ? `<small>${esc(row.nickname)}</small>` : ""}</td>
          <td data-sort-value="${Number(row.points || 0)}"><strong>${pointsText(row.points)}</strong></td>
          <td data-sort-value="${Number(row.elo_rating || 1000)}"><span class="elo-table-value">${Number(row.elo_rating || 1000).toFixed(1)}</span></td>
          <td data-sort-value="${Number(row.matches_played || 0)}">${Number(row.matches_played || 0)}</td><td data-sort-value="${Number(row.wins || 0)}">${Number(row.wins || 0)}</td><td data-sort-value="${Number(row.draws || 0)}">${Number(row.draws || 0)}</td><td data-sort-value="${Number(row.losses || 0)}">${Number(row.losses || 0)}</td>
          <td data-sort-value="${Number(row.leg_diff || 0)}"><span class="leg-diff ${Number(row.leg_diff || 0) > 0 ? "positive" : Number(row.leg_diff || 0) < 0 ? "negative" : ""}">${Number(row.leg_diff || 0) > 0 ? "+" : ""}${Number(row.leg_diff || 0)}</span></td>
          <td data-sort-value="${Number(row.three_dart_average || 0)}">${Number(row.three_dart_average || 0) > 0 ? Number(row.three_dart_average).toFixed(2) : "—"}</td>
        </tr>`).join("")}</tbody></table></div>`;
    seasonStandings.querySelectorAll("[data-player-profile]").forEach((row) => row.addEventListener("click", () => {
      const target = document.querySelector(`#playerDirectory [data-player-profile="${Number(row.dataset.playerProfile)}"]`);
      activate("players");
      target?.click();
    }));
    bindSortableTables();
  } catch (error) {
    seasonStandings.innerHTML = `<div class="mini-card"><p class="muted">${esc(error.message || "Kunne ikke hente sesongtabellen.")}</p></div>`;
  } finally {
    seasonLoading = false;
  }
}

function queueSeasonRepair() {
  if (!seasonStandings || seasonLoading || !selectedSeasonId || seasonRenderQueued) return;
  if (seasonStandings.querySelector(`[data-combined-season="${selectedSeasonId}"]`)) return;
  seasonRenderQueued = true;
  window.setTimeout(() => {
    seasonRenderQueued = false;
    if (!seasonStandings.querySelector(`[data-combined-season="${selectedSeasonId}"]`)) renderSelectedSeason().catch(() => undefined);
  }, 80);
}

function buildEloMovements(profile) {
  const history = (profile.elo_history || []).map((entry) => ({ ...entry, rating: Number(entry.rating), tournament_id: Number(entry.tournament_id || 0) })).filter((entry) => Number.isFinite(entry.rating));
  const movements = history.map((entry, index) => {
    const before = history[index + 1] && Number.isFinite(history[index + 1].rating) ? Number(history[index + 1].rating) : null;
    const after = Number(entry.rating);
    return { ...entry, before, after, delta: before === null ? null : Number((after - before).toFixed(1)), used: false };
  });
  const byTournament = new Map();
  movements.forEach((movement) => {
    if (!movement.tournament_id) return;
    if (!byTournament.has(movement.tournament_id)) byTournament.set(movement.tournament_id, []);
    byTournament.get(movement.tournament_id).push(movement);
  });
  const matchMap = new Map();
  (profile.recent_matches || []).forEach((match) => {
    const movement = (byTournament.get(Number(match.tournament_id || 0)) || []).find((candidate) => !candidate.used);
    if (!movement) return;
    movement.used = true;
    movement.match = match;
    matchMap.set(Number(match.id), movement);
  });
  return { movements, matchMap };
}

function movementClass(delta) {
  if (delta === null || delta === undefined || Math.abs(Number(delta)) < 0.05) return "neutral";
  return Number(delta) > 0 ? "positive" : "negative";
}

function movementHtml(movement, compact = false) {
  if (!movement || movement.before === null || movement.after === null) return "";
  const delta = Number(movement.delta || 0);
  const deltaText = `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`;
  return `<span class="elo-movement ${movementClass(delta)}${compact ? " compact" : ""}" aria-label="ELO fra ${movement.before.toFixed(1)} til ${movement.after.toFixed(1)}, endring ${deltaText}"><span class="elo-movement-label">ELO</span><span class="elo-before">${movement.before.toFixed(1)}</span><span class="elo-arrow">→</span><strong class="elo-after">${movement.after.toFixed(1)}</strong><b class="elo-delta">${deltaText}</b></span>`;
}

function enrichProfileWithElo(profile) {
  if (!playerProfile || playerProfile.classList.contains("hidden")) return;
  const { movements, matchMap } = buildEloMovements(profile);
  playerProfile.querySelectorAll(".profile-match-history [data-match-detail]").forEach((row) => {
    const movement = matchMap.get(Number(row.dataset.matchDetail || 0));
    if (!movement || row.querySelector(".elo-movement")) return;
    const date = row.querySelector(":scope > span");
    if (date) date.insertAdjacentHTML("beforebegin", movementHtml(movement, true));
    else row.insertAdjacentHTML("beforeend", movementHtml(movement, true));
  });
  const sections = [...playerProfile.querySelectorAll(".profile-section")];
  const eloSection = sections.find((section) => normalizeName(section.querySelector("h3")?.textContent).includes("elo-historikk") || normalizeName(section.querySelector("h3")?.textContent).includes("elo-utvikling"));
  if (!eloSection) return;
  const usable = movements.filter((movement) => movement.before !== null).slice(0, 16);
  eloSection.innerHTML = `<div class="section-head"><div><h3>ELO-utvikling</h3><p class="muted">Slik flyttet ratingen seg etter hver ferdig kamp.</p></div></div><div class="elo-timeline">${usable.length ? usable.map((movement) => {
    const match = movement.match;
    const context = match ? `${match.result === "win" ? "Seier" : match.result === "draw" ? "Uavgjort" : "Tap"} mot ${esc(match.opponent_name || "motstander")}` : esc(movement.tournament_name || "ELO-oppdatering");
    return `<div class="elo-timeline-row"><div class="elo-timeline-context"><strong>${context}</strong><small>${esc(movement.tournament_name || "")}${movement.calculated_at ? ` · ${esc(formatDate(movement.calculated_at))}` : ""}</small></div>${movementHtml(movement)}</div>`;
  }).join("") : `<p class="muted">Ingen kampvise ELO-endringer registrert ennå.</p>`}</div>`;
}

async function enhanceCurrentProfile() {
  if (!playerProfile || playerProfile.classList.contains("hidden")) return;
  const playerId = Number(playerProfile.querySelector(".profile-all-matches[data-player]")?.dataset.player || 0);
  if (!playerId) return;
  const requestId = ++profileRequestId;
  try {
    let profile = profileCache.get(playerId);
    if (!profile) {
      profile = await api(`/players/${playerId}/profile`);
      profileCache.set(playerId, profile);
    }
    if (requestId === profileRequestId) enrichProfileWithElo(profile);
  } catch {}
}

function enhance() {
  if (!root || applying) return;
  applying = true;
  try {
    simplifyStatisticsTabs();
    cleanupDuplicatePublicRows();
    filterPlayers();
    bindSortableTables();
    activate(currentView);
    queueSeasonRepair();
  } finally {
    applying = false;
  }
}

function initialize() {
  if (!root) return;
  simplifyStatisticsTabs();
  ensureSeasonChooser();
  root.querySelectorAll("[data-statistics-view]").forEach((button) => {
    button.addEventListener("click", () => activate(button.dataset.statisticsView));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      const buttons = [...root.querySelectorAll("[data-statistics-view]")];
      const index = buttons.indexOf(button);
      const next = buttons[(index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length];
      next?.focus();
      next?.click();
    });
  });
  search?.addEventListener("input", filterPlayers);
  observer = new MutationObserver(() => window.requestAnimationFrame(enhance));
  [seasonStandings, document.getElementById("playerDirectory")].filter(Boolean).forEach((node) => observer.observe(node, { childList: true, subtree: true }));
  if (playerProfile) {
    profileObserver = new MutationObserver(() => window.requestAnimationFrame(enhanceCurrentProfile));
    profileObserver.observe(playerProfile, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  }
  window.addEventListener("bd:portal-view", (event) => {
    if (event.detail?.target === "statistics") {
      enhance();
      if (!seasonItems.length) loadSeasons().catch(() => undefined);
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === "bd:playerClubId") {
      seasonItems = [];
      selectedSeasonId = 0;
      loadSeasons().catch(() => undefined);
    }
  });
  activate("season");
  enhance();
  loadSeasons().catch((error) => {
    if (seasonStandings) seasonStandings.innerHTML = `<div class="mini-card"><p class="muted">${esc(error.message || "Kunne ikke hente sesongene.")}</p></div>`;
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
else initialize();
