(() => {
  const TOKEN_KEY = "bd:screenToken";
  const API_ROOT = "../api/v1";
  const pulse = document.getElementById("pulseMetrics");
  const context = document.getElementById("contextContent");
  const contextSubtitle = document.getElementById("contextSubtitle");
  let latest = null;
  let busy = false;

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

  function decimal(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed.toFixed(2) : "—";
  }

  async function get(path) {
    const response = await fetch(`${API_ROOT}${path}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  }

  function itemMarkup(item, index, value) {
    return `<div class="live-highlight-item">
      <span class="live-highlight-rank">${index + 1}</span>
      <strong class="live-highlight-name">${esc(item.display_name || "—")}</strong>
      <span class="live-highlight-value">${esc(value)}</span>
    </div>`;
  }

  function categoryMarkup(label, items, valueFn) {
    const rows = Array.isArray(items) ? items.slice(0, 3) : [];
    return `<section class="live-highlight-category">
      <div class="live-highlight-label">${esc(label)}</div>
      <div class="live-highlight-items">
        ${rows.length ? rows.map((item, index) => itemMarkup(item, index, valueFn(item))).join("") : '<span class="live-highlight-empty">Ingen data ennå</span>'}
      </div>
    </section>`;
  }

  function renderHighlights() {
    if (!pulse || !latest) return;
    pulse.innerHTML = `<div class="live-highlight-leaderboard">
      ${categoryMarkup("Topp 3 visits", latest.top_visits, (item) => String(number(item.score)))}
      ${categoryMarkup("Topp 3 checkout", latest.top_checkouts, (item) => String(number(item.checkout)))}
      ${categoryMarkup("Topp 3 3DA", latest.top_three_dart_averages, (item) => decimal(item.three_dart_average))}
    </div>`;
  }

  function renderStandingsIfNeeded() {
    if (!context || !latest) return;
    const hasGroupTables = context.querySelector(".phase3-groups-grid, .phase3-bracket-strip");
    if (hasGroupTables) return;
    const fallbackTable = context.querySelector(".phase3-table-head.simple, .phase3-table-row.simple");
    if (!fallbackTable && context.querySelector(".live-standings-v2")) return;
    if (!fallbackTable) return;

    const rows = Array.isArray(latest.standings) ? latest.standings.slice(0, 6) : [];
    if (contextSubtitle) contextSubtitle.textContent = "Poeng → leg differanse → 3DA";
    context.innerHTML = rows.length
      ? `<section class="phase3-group-table live-standings-v2">
          <div class="phase3-table-head"><span>#</span><span>Spiller</span><span>P</span><span>LD</span><span>3DA</span></div>
          ${rows.map((row, index) => `<div class="phase3-table-row">
            <span>${number(row.position, index + 1)}</span>
            <strong>${esc(row.display_name)}</strong>
            <span>${number(row.points)}</span>
            <span>${number(row.leg_diff) >= 0 ? "+" : ""}${number(row.leg_diff)}</span>
            <span>${decimal(row.three_dart_average)}</span>
          </div>`).join("")}
        </section>`
      : '<div class="phase3-empty">Tabellen fylles når kampene starter.</div>';
  }

  function applyLatest() {
    renderHighlights();
    renderStandingsIfNeeded();
  }

  async function refresh() {
    const token = localStorage.getItem(TOKEN_KEY) || "";
    if (!token || busy) return;
    busy = true;
    try {
      const screen = await get(`/public/screen?screen_token=${encodeURIComponent(token)}`);
      const tournamentId = number(screen?.tournament?.id, 0);
      if (tournamentId <= 0) {
        latest = null;
        return;
      }
      latest = await get(`/tournaments/${tournamentId}/live-highlights`);
      applyLatest();
    } catch (error) {
      console.warn("Kunne ikke oppdatere live-høydepunkter", error);
    } finally {
      busy = false;
    }
  }

  if (pulse) {
    new MutationObserver(() => {
      if (latest && !pulse.querySelector(".live-highlight-leaderboard")) renderHighlights();
    }).observe(pulse, { childList: true, subtree: true });
  }

  if (context) {
    new MutationObserver(() => {
      if (latest && context.querySelector(".phase3-table-head.simple, .phase3-table-row.simple")) renderStandingsIfNeeded();
    }).observe(context, { childList: true, subtree: true });
  }

  refresh();
  window.setInterval(refresh, 1800);
})();
