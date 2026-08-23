(() => {
  'use strict';

  const state = {
    initialised: false,
    previous180: 0,
    previousCheckout: 0,
    matchFingerprints: new Map(),
    overlayTimer: null,
    requestInFlight: false,
  };

  const $ = (id) => document.getElementById(id);

  const apiUrl = new URL('../api/live.php', window.location.href);
  const ownParams = new URLSearchParams(window.location.search);
  if (ownParams.has('tournament_id')) {
    apiUrl.searchParams.set('tournament_id', ownParams.get('tournament_id'));
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function formatNumber(value, decimals = 0) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '–';
    return Number(value).toLocaleString('nb-NO', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  function compactName(player) {
    if (!player) return 'Ukjent';
    return player.nickname || player.name || player.display_name || 'Ukjent';
  }

  function feedLabel(feed) {
    if (!feed) return 'Ingen feed';
    const age = feed.age_seconds;
    if (feed.status === 'live') return 'LIVE';
    if (feed.status === 'delayed') return age == null ? 'Forsinket' : `${age}s bak`;
    if (feed.status === 'stale') return age == null ? 'Ikke live' : `${age}s siden`;
    return 'Venter';
  }

  function updateFeed(feed) {
    const pill = $('feedPill');
    pill.className = `feed-pill feed-${feed?.status || 'idle'}`;
    $('feedText').textContent = feedLabel(feed);
  }

  function playerRow(player, match, side) {
    const stats = player.stats || {};
    const legs = player.legs ?? 0;
    const score = player.score;
    const isWinner = player.winner;
    const avg = stats.average == null ? '' : `AVG ${formatNumber(stats.average, 2)}`;
    const firstNine = stats.first_nine == null ? '' : `F9 ${formatNumber(stats.first_nine, 2)}`;
    const statsLine = [avg, firstNine].filter(Boolean).join(' · ');

    return `
      <div class="player-row${isWinner ? ' winner' : ''}" data-side="${side}">
        <div>
          <div class="player-name" title="${escapeHtml(player.display_name || player.name)}">${escapeHtml(player.display_name || player.name)}</div>
          <div class="player-stats">${escapeHtml(statsLine || ' ')}</div>
        </div>
        <div class="player-score legs" title="Legs">${escapeHtml(legs)}</div>
        <div class="player-score remaining" title="Gjenværende score">${score == null ? '–' : escapeHtml(score)}</div>
      </div>
    `;
  }

  function matchFingerprint(match) {
    const a = match.players?.a || {};
    const b = match.players?.b || {};
    return [
      match.status,
      a.legs, b.legs, a.score, b.score,
      a.stats?.average, b.stats?.average,
      a.stats?.['180s'], b.stats?.['180s'],
      a.stats?.highest_checkout, b.stats?.highest_checkout,
    ].join('|');
  }

  function matchCard(match) {
    const board = match.board?.number ? `Skive ${match.board.number}` : (match.board?.name || 'Skive –');
    const round = match.round || match.bracket || `Best of ${match.best_of_legs}`;
    const a = match.players.a;
    const b = match.players.b;
    const footer = [];

    const total180 = (a.stats?.['180s'] || 0) + (b.stats?.['180s'] || 0);
    if (total180 > 0) footer.push(`${total180} × 180`);
    const highCheckout = Math.max(a.stats?.highest_checkout || 0, b.stats?.highest_checkout || 0);
    if (highCheckout > 0) footer.push(`CO ${highCheckout}`);
    if (match.best_of_legs) footer.push(`Bo${match.best_of_legs}`);

    const fingerprint = matchFingerprint(match);
    const previous = state.matchFingerprints.get(match.id);
    const changed = state.initialised && previous !== undefined && previous !== fingerprint;
    state.matchFingerprints.set(match.id, fingerprint);

    return `
      <article class="match-card live${changed ? ' changed' : ''}" data-match-id="${match.id}">
        <div class="match-meta">
          <span class="board-badge">${escapeHtml(board)}</span>
          <span>${escapeHtml(round)}</span>
        </div>
        ${playerRow(a, match, 'a')}
        ${playerRow(b, match, 'b')}
        <div class="match-footer">
          ${footer.map((item) => `<span class="micro-stat">${escapeHtml(item)}</span>`).join('')}
        </div>
      </article>
    `;
  }

  function renderLiveMatches(matches) {
    const container = $('liveMatches');
    $('liveCount').textContent = `${matches.length} aktive`;
    if (!matches.length) {
      container.innerHTML = '<div class="empty-state"><div><strong>Ingen kamp er live akkurat nå</strong><br><br>Skjermen oppdateres automatisk når neste kamp starter.</div></div>';
      return;
    }
    container.innerHTML = matches.slice(0, 6).map(matchCard).join('');
  }

  function stripMatch(match, mode) {
    const a = match.players.a;
    const b = match.players.b;
    const board = match.board?.number ? `Skive ${match.board.number}` : (match.round || 'Kamp');
    const showLegs = mode === 'recent';

    const aValue = showLegs ? (a.legs ?? (a.winner ? '✓' : '–')) : '';
    const bValue = showLegs ? (b.legs ?? (b.winner ? '✓' : '–')) : '';

    return `
      <article class="strip-match">
        <div class="strip-meta">${escapeHtml(board)}${match.round ? ` · ${escapeHtml(match.round)}` : ''}</div>
        <div class="strip-player"><span class="${a.winner ? 'winner' : ''}">${escapeHtml(compactName(a))}</span><span>${escapeHtml(aValue)}</span></div>
        <div class="strip-player"><span class="${b.winner ? 'winner' : ''}">${escapeHtml(compactName(b))}</span><span>${escapeHtml(bValue)}</span></div>
      </article>
    `;
  }

  function renderStrip(id, matches, mode, emptyText) {
    const container = $(id);
    if (!matches.length) {
      container.innerHTML = `<div class="empty-inline">${escapeHtml(emptyText)}</div>`;
      return;
    }
    container.innerHTML = matches.slice(0, 5).map((m) => stripMatch(m, mode)).join('');
  }

  function renderHighlights(highlights) {
    const total180 = Number(highlights?.total_180 || 0);
    $('total180').textContent = formatNumber(total180);

    const checkout = highlights?.highest_checkout;
    $('highestCheckout').textContent = checkout ? formatNumber(checkout.value) : '–';
    $('highestCheckoutPlayer').textContent = checkout?.player ? compactName(checkout.player) : 'Ingen registrert';

    const avg = highlights?.best_average;
    $('bestAverage').textContent = avg ? formatNumber(avg.value, 2) : '–';
    $('bestAveragePlayer').textContent = avg?.player ? compactName(avg.player) : 'Ingen registrert';

    if (state.initialised) {
      if (total180 > state.previous180) {
        showEvent('180!', 'ONE HUNDRED AND EIGHTY');
      } else if ((checkout?.value || 0) > state.previousCheckout && state.previousCheckout > 0) {
        showEvent(String(checkout.value), `NY HØY CHECKOUT · ${compactName(checkout.player)}`);
      }
    }

    state.previous180 = total180;
    state.previousCheckout = Number(checkout?.value || 0);
  }

  function renderLeaderboard(rows) {
    const container = $('leaderboard');
    if (!rows?.length) {
      container.innerHTML = '<div class="empty-state small">Ingen ferdige kamper ennå.</div>';
      return;
    }

    const header = `
      <div class="leader-row leader-head">
        <span>#</span><span>Spiller</span><span>V</span><span>AVG</span><span>180</span>
      </div>
    `;
    const body = rows.slice(0, 8).map((row, index) => `
      <div class="leader-row">
        <span class="leader-pos">${index + 1}</span>
        <span class="leader-name" title="${escapeHtml(row.name)}">${escapeHtml(row.nickname || row.name)}</span>
        <span class="leader-num">${formatNumber(row.wins)}</span>
        <span class="leader-num">${row.average == null ? '–' : formatNumber(row.average, 1)}</span>
        <span class="leader-num">${formatNumber(row['180s'] || 0)}</span>
      </div>
    `).join('');
    container.innerHTML = header + body;
  }

  function showEvent(value, label) {
    const overlay = $('eventOverlay');
    $('eventValue').textContent = value;
    $('eventLabel').textContent = label;
    overlay.classList.add('visible');
    overlay.setAttribute('aria-hidden', 'false');
    window.clearTimeout(state.overlayTimer);
    state.overlayTimer = window.setTimeout(() => {
      overlay.classList.remove('visible');
      overlay.setAttribute('aria-hidden', 'true');
    }, 3200);
  }

  function render(payload) {
    const tournament = payload.tournament;
    if (!tournament) {
      $('seasonName').textContent = 'BLINDLEIA DARTKLUBB';
      $('tournamentName').textContent = 'Ingen aktiv turnering';
      renderLiveMatches([]);
      renderStrip('upcomingMatches', [], 'upcoming', 'Ingen ventende kamper');
      renderStrip('recentMatches', [], 'recent', 'Ingen resultater ennå');
      renderHighlights(payload.highlights || {});
      renderLeaderboard([]);
      updateFeed(payload.feed);
      return;
    }

    $('seasonName').textContent = tournament.season_name || tournament.club_name || 'Blindleia Dartklubb';
    $('tournamentName').textContent = tournament.name || 'Blindleia Live';
    updateFeed(payload.feed);
    renderLiveMatches(payload.matches?.live || []);
    renderStrip('upcomingMatches', payload.matches?.upcoming || [], 'upcoming', 'Ingen ventende kamper');
    renderStrip('recentMatches', payload.matches?.recent || [], 'recent', 'Ingen resultater ennå');
    renderHighlights(payload.highlights || {});
    renderLeaderboard(payload.leaderboard || []);

    const age = payload.feed?.age_seconds;
    $('footerStatus').textContent = `Turnering #${tournament.id} · ${payload.matches?.live?.length || 0} live · ${payload.matches?.upcoming?.length || 0} neste`;
    $('lastUpdated').textContent = age == null
      ? 'Sist oppdatert: –'
      : `DartsAtlas sist sett: ${age}s siden`;

    state.initialised = true;
  }

  async function refresh() {
    if (state.requestInFlight) return;
    state.requestInFlight = true;
    try {
      const response = await fetch(apiUrl, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!payload.ok) throw new Error(payload.error || 'Live API error');
      render(payload);
    } catch (error) {
      const pill = $('feedPill');
      pill.className = 'feed-pill feed-stale';
      $('feedText').textContent = 'API utilgjengelig';
      $('lastUpdated').textContent = 'Kunne ikke hente nye data';
      console.error('Blindleia Live refresh failed', error);
    } finally {
      state.requestInFlight = false;
    }
  }

  function tickClock() {
    $('clock').textContent = new Intl.DateTimeFormat('nb-NO', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
  }

  tickClock();
  window.setInterval(tickClock, 1000);
  refresh();
  window.setInterval(refresh, 3000);
})();
