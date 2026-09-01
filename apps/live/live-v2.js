(() => {
  const liveV2State = {
    tournamentId: 0,
    highlights: null,
    loading: false,
    lastLoadedAt: 0,
    tableTournamentId: 0,
    tableGroups: [],
    tablePage: 0,
    tableTimer: null,
    eloTournamentId: 0,
    eloRows: [],
    eloPage: 0,
    eloTimer: null,
  };

  function fmtV2(value, decimals = 2) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed.toFixed(decimals) : "—";
  }

  function renderRankList(title, rows, valueFor, emptyText) {
    const items = Array.isArray(rows) ? rows.slice(0, 3) : [];
    return `<section class="live-top3-block">
      <h3>${esc(title)}</h3>
      <div class="live-top3-list">
        ${items.length ? items.map((row, index) => `<div class="live-top3-row">
          <span class="live-top3-rank">${index + 1}</span>
          <strong>${esc(row.display_name || "Spiller")}</strong>
          <em>${esc(valueFor(row))}</em>
        </div>`).join("") : `<div class="live-top3-empty">${esc(emptyText)}</div>`}
      </div>
    </section>`;
  }

  function paintHighlights() {
    if (!el?.highlights) return;
    const data = liveV2State.highlights;
    if (!data) {
      el.highlights.innerHTML = `<div class="live-top3-loading">Henter høydepunkter …</div>`;
      return;
    }

    el.highlights.innerHTML = [
      renderRankList("Topp 3 visits", data.top_visits, (row) => String(Number(row.score || 0)), "Ingen visits ennå"),
      renderRankList("Topp 3 checkout", data.top_checkouts, (row) => String(Number(row.checkout || 0)), "Ingen checkout ennå"),
      renderRankList("Topp 3 3DA", data.top_three_dart_averages, (row) => fmtV2(row.three_dart_average), "Ingen 3DA ennå"),
    ].join("");
  }

  async function loadHighlightsForCurrentTournament(force = false) {
    const tournamentId = Number(state?.payload?.tournament?.id || 0);
    if (!tournamentId) {
      liveV2State.tournamentId = 0;
      liveV2State.highlights = null;
      paintHighlights();
      return;
    }

    const now = Date.now();
    if (!force && liveV2State.loading) return;
    if (!force && liveV2State.tournamentId === tournamentId && liveV2State.highlights && now - liveV2State.lastLoadedAt < 2500) {
      paintHighlights();
      return;
    }

    liveV2State.loading = true;
    try {
      const data = await api(`/tournaments/${tournamentId}/live-highlights`);
      if (Number(state?.payload?.tournament?.id || 0) !== tournamentId) return;
      liveV2State.tournamentId = tournamentId;
      liveV2State.highlights = data;
      liveV2State.lastLoadedAt = Date.now();
      paintHighlights();
    } catch (error) {
      console.warn("Kunne ikke hente live-høydepunkter", error);
      if (!liveV2State.highlights) {
        el.highlights.innerHTML = `<div class="live-top3-loading">Høydepunkter oppdateres …</div>`;
      }
    } finally {
      liveV2State.loading = false;
    }
  }

  function groupPageMetaElement() {
    const head = el?.tables?.closest(".section")?.querySelector(".section-head");
    if (!head) return null;
    let meta = head.querySelector(".group-page-meta");
    if (!meta) {
      meta = document.createElement("span");
      meta.className = "group-page-meta hidden";
      head.appendChild(meta);
    }
    return meta;
  }

  function qualifiersPerGroup() {
    const direct = Number(state?.payload?.qualifiers_per_group || 0);
    if (direct > 0) return direct;
    const playoff = Number(state?.payload?.playoff?.playoff?.qualifiers_per_group || 0);
    return playoff > 0 ? playoff : 0;
  }

  function paintGroupTables() {
    if (!el?.tables) return;
    const groups = Array.isArray(liveV2State.tableGroups) ? liveV2State.tableGroups : [];
    const pageSize = 2;
    const totalPages = Math.max(1, Math.ceil(groups.length / pageSize));
    if (liveV2State.tablePage >= totalPages) liveV2State.tablePage = 0;

    const start = liveV2State.tablePage * pageSize;
    const visibleGroups = groups.slice(start, start + pageSize);
    const qualifiers = qualifiersPerGroup();
    el.tables.dataset.groupCount = String(groups.length);
    el.tables.dataset.groupPage = String(liveV2State.tablePage + 1);
    el.tables.dataset.visibleGroups = String(visibleGroups.length);
    el.tables.dataset.qualifiersPerGroup = String(qualifiers);

    el.tables.innerHTML = visibleGroups.length ? visibleGroups.map((group) => {
      const rows = Array.isArray(group.rows) ? group.rows : [];
      return `<article class="table-card"><h3>${esc(group.name)}</h3><div class="table-scroll"><table class="portal-table live-table-v2"><thead><tr><th>#</th><th>Spiller</th><th>K</th><th>V</th><th>U</th><th>T</th><th>Leg</th><th class="three-da-col" title="3-dart average">3DA</th><th>P</th></tr></thead><tbody>${rows.map((row) => {
        const cutoff = qualifiers > 0 && qualifiers < rows.length && Number(row.position) === qualifiers;
        return `<tr${cutoff ? ' class="qualifier-cutoff"' : ""}><td>${Number(row.position)}</td><td><strong>${esc(row.display_name)}</strong></td><td>${Number(row.played)}</td><td>${Number(row.wins)}</td><td>${Number(row.draws)}</td><td>${Number(row.losses)}</td><td>${Number(row.leg_diff) >= 0 ? "+" : ""}${Number(row.leg_diff)}</td><td class="three-da-col"><strong>${fmtV2(row.three_dart_average)}</strong></td><td><strong>${Number(row.points)}</strong></td></tr>`;
      }).join("")}</tbody></table></div></article>`;
    }).join("") : `<div class="empty">Tabellen kommer når kampene er i gang.</div>`;

    const meta = groupPageMetaElement();
    if (!meta) return;
    if (groups.length <= pageSize) {
      meta.textContent = "";
      meta.classList.add("hidden");
      return;
    }
    const end = Math.min(start + pageSize, groups.length);
    meta.textContent = `Gruppe ${start + 1}–${end} av ${groups.length} · side ${liveV2State.tablePage + 1} av ${totalPages} · 20 sek`;
    meta.classList.remove("hidden");
  }

  function syncGroupRotation() {
    const needsRotation = liveV2State.tableGroups.length > 2;
    if (!needsRotation) {
      if (liveV2State.tableTimer) window.clearInterval(liveV2State.tableTimer);
      liveV2State.tableTimer = null;
      liveV2State.tablePage = 0;
      return;
    }
    if (liveV2State.tableTimer) return;
    liveV2State.tableTimer = window.setInterval(() => {
      if (!document.body.classList.contains("phase-live")) return;
      const pages = Math.ceil(liveV2State.tableGroups.length / 2);
      if (pages <= 1) return;
      liveV2State.tablePage = (liveV2State.tablePage + 1) % pages;
      paintGroupTables();
    }, 20000);
  }

  function eloPageMetaElement() {
    const head = el?.elo?.closest(".section")?.querySelector(".section-head");
    if (!head) return null;
    let meta = head.querySelector(".elo-page-meta");
    if (!meta) {
      meta = document.createElement("span");
      meta.className = "elo-page-meta hidden";
      head.appendChild(meta);
    }
    return meta;
  }

  function paintElo() {
    if (!el?.elo) return;
    const rows = Array.isArray(liveV2State.eloRows) ? liveV2State.eloRows : [];
    const pageSize = 6;
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
    if (liveV2State.eloPage >= totalPages) liveV2State.eloPage = 0;
    const start = liveV2State.eloPage * pageSize;
    const visibleRows = rows.slice(start, start + pageSize);

    el.elo.dataset.eloPage = String(liveV2State.eloPage + 1);
    el.elo.dataset.eloPages = String(totalPages);
    el.elo.innerHTML = visibleRows.length ? visibleRows.map((row) => `<div class="list-row"><span class="rank">#${Number(row.position)}</span><div><strong>${esc(row.display_name)}</strong><small>${Number(row.elo_matches_played || 0)} ELO-kamper</small></div><span class="rating">${Number(row.elo_rating || 1000).toFixed(1)}</span></div>`).join("") : `<div class="empty">Ingen ELO-data.</div>`;

    const meta = eloPageMetaElement();
    if (!meta) return;
    if (totalPages <= 1) {
      meta.textContent = "";
      meta.classList.add("hidden");
      return;
    }
    meta.textContent = `Side ${liveV2State.eloPage + 1} av ${totalPages} · 20 sek`;
    meta.classList.remove("hidden");
  }

  function syncEloRotation() {
    const needsRotation = liveV2State.eloRows.length > 6;
    if (!needsRotation) {
      if (liveV2State.eloTimer) window.clearInterval(liveV2State.eloTimer);
      liveV2State.eloTimer = null;
      liveV2State.eloPage = 0;
      return;
    }
    if (liveV2State.eloTimer) return;
    liveV2State.eloTimer = window.setInterval(() => {
      if (!document.body.classList.contains("phase-live")) return;
      const pages = Math.ceil(liveV2State.eloRows.length / 6);
      if (pages <= 1) return;
      liveV2State.eloPage = (liveV2State.eloPage + 1) % pages;
      paintElo();
    }, 20000);
  }

  renderTables = function renderTablesV2(data = {}) {
    const tournamentId = Number(state?.payload?.tournament?.id || 0);
    const groups = Array.isArray(data.groups) ? data.groups : [];
    if (liveV2State.tableTournamentId !== tournamentId) {
      liveV2State.tableTournamentId = tournamentId;
      liveV2State.tablePage = 0;
    }
    liveV2State.tableGroups = groups;
    const pages = Math.max(1, Math.ceil(groups.length / 2));
    if (liveV2State.tablePage >= pages) liveV2State.tablePage = 0;
    paintGroupTables();
    syncGroupRotation();
  };

  renderElo = function renderEloV2(rows = []) {
    const tournamentId = Number(state?.payload?.tournament?.id || 0);
    if (liveV2State.eloTournamentId !== tournamentId) {
      liveV2State.eloTournamentId = tournamentId;
      liveV2State.eloPage = 0;
    }
    liveV2State.eloRows = Array.isArray(rows) ? rows : [];
    const pages = Math.max(1, Math.ceil(liveV2State.eloRows.length / 6));
    if (liveV2State.eloPage >= pages) liveV2State.eloPage = 0;
    paintElo();
    syncEloRotation();
  };

  renderHighlights = function renderHighlightsV2() {
    paintHighlights();
    loadHighlightsForCurrentTournament().catch(() => undefined);
  };

  const originalRender = render;
  render = function renderPublicLiveV2(payload) {
    originalRender(payload);
    document.body.dataset.publicLiveV2 = "3da-top3-elo-rotation";
    loadHighlightsForCurrentTournament().catch(() => undefined);
  };
})();
