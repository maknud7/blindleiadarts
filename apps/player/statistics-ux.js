const stylesheet = document.createElement("link");
stylesheet.rel = "stylesheet";
stylesheet.href = new URL("./statistics-ux.css?v=20260827-1435", import.meta.url).href;
document.head.appendChild(stylesheet);

const root = document.getElementById("statistics");
const search = document.getElementById("playerSearch");
let currentView = "season";
let applying = false;
let observer = null;

function normalizeName(value) {
  return String(value || "").trim().toLocaleLowerCase("nb-NO").replace(/\s+/g, " ");
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
  root.querySelectorAll("[data-statistics-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.statisticsPanel !== currentView);
  });
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
    } else {
      row.remove();
    }
  });
}

function cleanupDuplicatePublicRows() {
  if (!root) return;

  // Only collapse rows when name + core rating/match footprint are identical.
  // This avoids hiding legitimate namesakes while keeping known duplicate identities
  // from appearing twice in public statistics until the canonical player merge is done.
  dedupeRows(
    "#eloTable tbody tr",
    (row) => `${normalizeName(row.children[1]?.textContent)}|${numericCell(row, 2).toFixed(1)}|${numericCell(row, 3)}`,
    (row) => numericCell(row, 4) * 1000 + numericCell(row, 5)
  );

  dedupeRows(
    "#seasonStandings tbody tr",
    (row) => `${normalizeName(row.children[1]?.textContent)}|${numericCell(row, 2)}|${numericCell(row, 6)}`,
    (row) => numericCell(row, 3) * 1000 + numericCell(row, 5)
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
    const haystack = normalizeName(card.textContent);
    const show = !query || haystack.includes(query);
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
  } else {
    empty?.remove();
  }
}

function enhance() {
  if (!root || applying) return;
  applying = true;
  try {
    cleanupDuplicatePublicRows();
    filterPlayers();
    activate(currentView);
  } finally {
    applying = false;
  }
}

function initialize() {
  if (!root) return;
  root.querySelectorAll("[data-statistics-view]").forEach((button) => {
    button.addEventListener("click", () => activate(button.dataset.statisticsView));
    button.addEventListener("keydown", (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      const buttons = [...root.querySelectorAll("[data-statistics-view]")];
      const index = buttons.indexOf(button);
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      const next = buttons[(index + delta + buttons.length) % buttons.length];
      next?.focus();
      next?.click();
    });
  });
  search?.addEventListener("input", filterPlayers);

  observer = new MutationObserver(() => window.requestAnimationFrame(enhance));
  [document.getElementById("eloTable"), document.getElementById("seasonStandings"), document.getElementById("playerDirectory")]
    .filter(Boolean)
    .forEach((node) => observer.observe(node, { childList: true, subtree: true }));

  window.addEventListener("bd:portal-view", (event) => {
    if (event.detail?.target === "statistics") enhance();
  });

  activate("season");
  enhance();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
else initialize();
