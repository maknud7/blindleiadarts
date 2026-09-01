(() => {
  const PAGE_SIZE = 6;
  const PAGE_MS = 20000;
  const eloState = { rows: [], page: 0, timer: null };

  function pageCount() {
    return Math.max(1, Math.ceil(eloState.rows.length / PAGE_SIZE));
  }

  function ensureMeta() {
    const panel = el?.elo?.closest?.('.panel');
    const head = panel?.querySelector?.('.section-head');
    if (!head) return null;
    let meta = head.querySelector('.elo-page-meta');
    if (!meta) {
      meta = document.createElement('span');
      meta.className = 'elo-page-meta';
      head.appendChild(meta);
    }
    return meta;
  }

  function paintPage() {
    if (!el?.elo) return;
    const count = pageCount();
    if (eloState.page >= count) eloState.page = 0;
    const start = eloState.page * PAGE_SIZE;
    const rows = eloState.rows.slice(start, start + PAGE_SIZE);
    el.elo.innerHTML = rows.length ? rows.map((row) => `<div class="list-row"><span class="rank">#${Number(row.position)}</span><div><strong>${esc(row.display_name)}</strong><small>${Number(row.elo_matches_played || 0)} ELO-kamper</small></div><span class="rating">${Number(row.elo_rating || 1000).toFixed(1)}</span></div>`).join("") : `<div class="empty">Ingen ELO-data.</div>`;

    const meta = ensureMeta();
    if (meta) meta.textContent = count > 1 ? `Side ${eloState.page + 1} av ${count} · 20 sek` : 'Alle';
  }

  function restartTimer() {
    if (eloState.timer) window.clearInterval(eloState.timer);
    eloState.timer = null;
    if (pageCount() <= 1) return;
    eloState.timer = window.setInterval(() => {
      if (!document.body.classList.contains('phase-live')) return;
      eloState.page = (eloState.page + 1) % pageCount();
      paintPage();
    }, PAGE_MS);
  }

  renderElo = function renderPagedElo(rows = []) {
    const previousFirstId = eloState.rows[0]?.player_id ?? eloState.rows[0]?.id ?? null;
    const nextFirstId = rows[0]?.player_id ?? rows[0]?.id ?? null;
    eloState.rows = Array.isArray(rows) ? rows.slice() : [];
    if (previousFirstId !== nextFirstId || eloState.page >= pageCount()) eloState.page = 0;
    paintPage();
    restartTimer();
  };
})();
