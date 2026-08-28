const content = document.getElementById('matchDetailContent');
const dialog = document.getElementById('matchDetailDialog');

if (content && dialog) {
  injectStyles();

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest?.('[data-match-detail]');
    if (!trigger) return;
    const matchId = Number(trigger.dataset.matchDetail || 0);
    if (!matchId) return;
    content.dataset.matchUxMatchId = String(matchId);
  }, true);

  const observer = new MutationObserver(() => queueMicrotask(enhanceCurrentMatch));
  observer.observe(content, { childList: true, subtree: true });
  enhanceCurrentMatch();
}

function injectStyles() {
  if (document.getElementById('match-detail-ux-styles')) return;
  const style = document.createElement('style');
  style.id = 'match-detail-ux-styles';
  style.textContent = `
    .match-detail-dialog{width:min(720px,calc(100vw - 24px));max-height:min(92dvh,940px);border-radius:22px;overflow:hidden;box-shadow:0 28px 80px rgba(8,29,54,.34)}
    .match-detail-dialog::backdrop{background:rgba(8,29,54,.52);backdrop-filter:blur(2px)}
    .match-detail-content{max-height:min(92dvh,940px);padding:24px;overflow:auto;background:#fff}
    .match-detail-head{position:relative;display:block;padding-right:54px;margin-bottom:18px}
    .match-detail-head h2{font-size:clamp(1.45rem,3vw,2rem);line-height:1.08;margin-top:6px;max-width:620px}
    .match-detail-head .muted{margin-top:9px;font-size:.9rem}
    .match-detail-close{position:absolute;right:0;top:0!important;width:42px!important;height:42px;padding:0!important;border-radius:50%!important;font-size:1.55rem;line-height:1;color:#5f738c!important;background:#fff!important;border:1px solid #d7e1ec!important;box-shadow:none!important;display:grid;place-items:center}
    .match-detail-close:hover{background:#f4f7fb!important;color:#0c2340!important}
    .match-elo-panel{margin:0 0 16px;border:1px solid #d9e5f2;border-radius:16px;padding:14px;background:linear-gradient(180deg,#f8fbff 0%,#fff 100%)}
    .match-elo-title{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}
    .match-elo-title strong{font-size:.78rem;letter-spacing:.08em;text-transform:uppercase;color:#2f6fed}
    .match-elo-title span{font-size:.78rem;color:#73859a}
    .match-elo-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .match-elo-player{min-width:0;border:1px solid #e1e9f2;border-radius:12px;padding:11px 12px;background:#fff}
    .match-elo-player>span{display:block;color:#667a92;font-size:.75rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:5px}
    .match-elo-values{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
    .match-elo-values strong{font-size:1.05rem;color:#0c2340}
    .match-elo-delta{font-style:normal;font-weight:850;font-size:.82rem;border-radius:999px;padding:3px 7px}
    .match-elo-delta.up{color:#087a4b;background:#e7f7ef}
    .match-elo-delta.down{color:#b4232e;background:#fdebed}
    .match-elo-delta.flat{color:#61738a;background:#eef2f6}
    .match-elo-unavailable{margin:0;color:#73859a;font-size:.82rem}
    .match-stat-board{margin-top:0;border-radius:16px;border-color:#d9e3ee;background:#fff;overflow:hidden}
    .match-stat-names{padding:16px 18px;background:#f6f9fd;grid-template-columns:minmax(0,1fr) 54px minmax(0,1fr);gap:12px}
    .match-stat-names strong{font-size:1rem;line-height:1.18}
    .match-stat-row{padding:13px 18px;grid-template-columns:minmax(72px,1fr) 130px minmax(72px,1fr);gap:12px;min-height:52px}
    .match-stat-row strong{font-size:1.06rem}
    .match-stat-row span{font-size:.84rem;color:#71849a;text-align:center}
    .match-stat-row.match-average-row{background:#f4f8ff}
    .match-stat-row.match-average-row span{font-weight:850;color:#205da7}
    .match-stat-row.match-average-row strong{font-size:1.16rem;color:#123f74}
    .match-stat-row.match-winning-checkout{background:#f8fbff}
    .match-stat-row.match-winning-checkout span{color:#2f6fed;font-weight:800}
    .match-stat-row.match-winning-checkout strong:not(.empty-value){color:#0c5cc9}
    .match-legs{margin-top:20px}
    .match-legs h3{font-size:1.15rem;margin-bottom:3px}
    .match-legs>.match-leg-help{margin:0 0 10px;font-size:.78rem;color:#71849a}
    .leg-card{border-color:#dbe5ef;border-radius:14px;background:#fff;margin-bottom:9px;overflow:hidden}
    .leg-card-toggle{padding:14px 16px;background:#fff!important;box-shadow:none!important}
    .leg-card-toggle:hover{background:#f8fbff!important}
    .leg-card-toggle>span:first-child strong{color:#2f6fed}
    .leg-card-toggle>span:last-child{display:grid;gap:1px;justify-items:end;border-radius:10px;background:#edf4ff;color:#1858bc;padding:6px 10px;font-weight:800;white-space:nowrap}
    .leg-card-toggle>span:last-child small{font-size:.58rem;letter-spacing:.07em;text-transform:uppercase;color:#6a82a1}
    .leg-card-toggle>span:last-child strong{font-size:.82rem;color:#1858bc;font-variant-numeric:tabular-nums}
    .leg-visits{background:#fbfcfe;padding:5px 14px 9px}
    .leg-average-breakdown{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:7px 0 9px}
    .leg-average-player{display:grid;gap:2px;padding:9px 10px;border:1px solid #dce7f2;border-radius:10px;background:#fff}
    .leg-average-player small{font-size:.64rem;color:#71849a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .leg-average-player strong{font-size:1rem;color:#174a82;font-variant-numeric:tabular-nums}
    @media(max-width:680px){
      .match-detail-dialog{width:calc(100vw - 18px);max-height:calc(100dvh - 24px);border-radius:22px}
      .match-detail-content{max-height:calc(100dvh - 24px);padding:20px 16px 22px}
      .match-detail-head{display:block;padding-right:48px}
      .match-detail-head h2{font-size:1.72rem}
      .match-detail-close{width:40px!important;height:40px}
      .match-elo-grid{grid-template-columns:1fr}
      .match-stat-names{padding:14px 12px;grid-template-columns:minmax(0,1fr) 34px minmax(0,1fr)}
      .match-stat-names strong{font-size:.94rem}
      .match-stat-row{padding:12px 12px;grid-template-columns:minmax(64px,1fr) 116px minmax(64px,1fr);gap:8px}
      .match-stat-row strong{font-size:1rem}
      .match-stat-row span{font-size:.76rem}
      .leg-card-toggle{padding:13px 14px}
      .leg-average-breakdown{grid-template-columns:1fr}
    }
  `;
  document.head.appendChild(style);
}

function enhanceCurrentMatch() {
  if (!content) return;
  const board = content.querySelector('.match-stat-board');
  if (!board || board.dataset.matchUxEnhanced === '1') return;
  board.dataset.matchUxEnhanced = '1';

  const matchId = Number(content.dataset.matchUxMatchId || 0);
  const close = content.querySelector('.match-detail-close');
  if (close) {
    close.textContent = '×';
    close.setAttribute('aria-label', 'Lukk kampdetaljer');
    close.setAttribute('title', 'Lukk');
  }

  const nameNodes = [...board.querySelectorAll('.match-stat-names strong')];
  const playerAName = nameNodes[0]?.textContent?.trim() || 'Spiller 1';
  const playerBName = nameNodes[1]?.textContent?.trim() || 'Spiller 2';

  const rows = [...board.querySelectorAll('.match-stat-row')];
  const rowByLabel = new Map(rows.map((row) => [row.querySelector('span')?.textContent?.trim() || '', row]));

  const averageRow = rowByLabel.get('3DA');
  if (averageRow) {
    averageRow.classList.add('match-average-row');
    const label = averageRow.querySelector('span');
    if (label) label.textContent = 'Kampsnitt (3DA)';
  }

  rowByLabel.get('Checkout')?.remove();
  rowByLabel.get('Høy checkout')?.remove();

  populateFirstNine(rowByLabel.get('First 9'), playerAName, playerBName);
  addWinningCheckout(board, rowByLabel.get('First 9'), playerAName, playerBName);
  enhanceLegAverages(playerAName, playerBName);

  if (matchId > 0) renderElo(matchId, playerAName, playerBName, board);
}

function enhanceLegAverages(playerAName, playerBName) {
  const legsRoot = content.querySelector('.match-legs');
  if (legsRoot && !legsRoot.querySelector('.match-leg-help')) {
    legsRoot.querySelector('h3')?.insertAdjacentHTML('afterend', '<p class="match-leg-help">Åpne et leg for å se leg-snitt (3DA) og kast for begge spillere.</p>');
  }

  content.querySelectorAll('.leg-card').forEach((card) => {
    if (card.dataset.legAverageEnhanced === '1') return;
    const toggle = card.querySelector('.leg-card-toggle');
    const summary = toggle?.querySelector(':scope > span:last-child');
    const values = String(summary?.textContent || '').split('·').map((value) => value.trim());
    const aAverage = values[0] || '—';
    const bAverage = values[1] || '—';
    if (summary) summary.innerHTML = `<small>Leg 3DA</small><strong>${escapeHtml(aAverage)} / ${escapeHtml(bAverage)}</strong>`;

    const visits = card.querySelector('.leg-visits');
    if (visits) {
      visits.insertAdjacentHTML('afterbegin', `
        <div class="leg-average-breakdown">
          <span class="leg-average-player"><small>${escapeHtml(playerAName)}</small><strong>3DA ${escapeHtml(aAverage)}</strong></span>
          <span class="leg-average-player"><small>${escapeHtml(playerBName)}</small><strong>3DA ${escapeHtml(bAverage)}</strong></span>
        </div>`);
    }
    card.dataset.legAverageEnhanced = '1';
  });
}

function visitData() {
  const byPlayer = new Map();
  [...content.querySelectorAll('.leg-card')].forEach((legCard) => {
    [...legCard.querySelectorAll('.visit-row')].forEach((row) => {
      const spans = row.querySelectorAll('span');
      const player = spans[0]?.textContent?.trim();
      const score = Number(row.querySelector('strong')?.textContent?.trim());
      const stateText = spans[1]?.textContent?.trim() || '';
      if (!player || !Number.isFinite(score)) return;
      if (!byPlayer.has(player)) byPlayer.set(player, []);
      byPlayer.get(player).push({ score: /bust/i.test(stateText) ? 0 : score, stateText, row });
    });
  });
  return byPlayer;
}

function firstNineAverage(visits) {
  if (!Array.isArray(visits) || visits.length < 3) return null;
  const firstThreeVisits = visits.slice(0, 3);
  return firstThreeVisits.reduce((sum, visit) => sum + Number(visit.score || 0), 0) / 3;
}

function populateFirstNine(row, playerAName, playerBName) {
  if (!row) return;
  const byPlayer = visitData();
  const a = firstNineAverage(byPlayer.get(playerAName));
  const b = firstNineAverage(byPlayer.get(playerBName));
  const values = row.querySelectorAll('strong');
  if (values[0] && a !== null) values[0].textContent = a.toFixed(2);
  if (values[1] && b !== null) values[1].textContent = b.toFixed(2);
}

function addWinningCheckout(board, anchorRow, playerAName, playerBName) {
  if (board.querySelector('.match-winning-checkout')) return;
  const legs = [...content.querySelectorAll('.leg-card')];
  const finalLeg = legs.at(-1);
  if (!finalLeg) return;

  const winnerText = finalLeg.querySelector('.leg-card-toggle small')?.textContent?.trim() || '';
  const winnerName = winnerText.replace(/\s+vant$/i, '').trim();
  if (!winnerName) return;

  let winningCheckout = null;
  [...finalLeg.querySelectorAll('.visit-row')].forEach((row) => {
    const spans = row.querySelectorAll('span');
    const player = spans[0]?.textContent?.trim();
    const stateText = spans[1]?.textContent?.trim() || '';
    const score = Number(row.querySelector('strong')?.textContent?.trim());
    if (player === winnerName && /(^|\s)0\s+igjen$/i.test(stateText) && Number.isFinite(score)) {
      winningCheckout = score;
    }
  });
  if (winningCheckout === null) return;

  const row = document.createElement('div');
  row.className = 'match-stat-row match-winning-checkout';
  const aValue = winnerName === playerAName ? String(winningCheckout) : '—';
  const bValue = winnerName === playerBName ? String(winningCheckout) : '—';
  row.innerHTML = `<strong class="${aValue === '—' ? 'empty-value' : ''}">${aValue}</strong><span>Vinnende checkout</span><strong class="${bValue === '—' ? 'empty-value' : ''}">${bValue}</strong>`;
  (anchorRow || board.querySelector('.match-stat-row'))?.insertAdjacentElement('afterend', row);
}

async function renderElo(matchId, playerAName, playerBName, board) {
  if (content.querySelector('.match-elo-panel')) return;
  const panel = document.createElement('section');
  panel.className = 'match-elo-panel';
  panel.innerHTML = `<div class="match-elo-title"><strong>ELO</strong><span>Endring etter kampen</span></div><p class="match-elo-unavailable">Henter ELO-endring …</p>`;
  board.insertAdjacentElement('beforebegin', panel);

  try {
    const response = await fetch(`../api/match-elo.php?match_id=${encodeURIComponent(matchId)}`, { cache: 'no-store' });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error('elo_failed');
    if (Number(content.dataset.matchUxMatchId || 0) !== matchId) return;
    const event = payload.data?.event;
    if (!event || event.rating_a_before === null || event.rating_b_before === null || event.rating_a_after === null || event.rating_b_after === null) {
      panel.innerHTML = `<div class="match-elo-title"><strong>ELO</strong><span>Endring etter kampen</span></div><p class="match-elo-unavailable">ELO-endring er ikke lagret for denne historiske kampen.</p>`;
      return;
    }
    panel.innerHTML = `
      <div class="match-elo-title"><strong>ELO</strong><span>Endring etter kampen</span></div>
      <div class="match-elo-grid">
        ${eloPlayer(playerAName, event.rating_a_before, event.rating_a_after, event.delta_a)}
        ${eloPlayer(playerBName, event.rating_b_before, event.rating_b_after, event.delta_b)}
      </div>`;
  } catch {
    panel.innerHTML = `<div class="match-elo-title"><strong>ELO</strong><span>Endring etter kampen</span></div><p class="match-elo-unavailable">Kunne ikke hente ELO-endringen akkurat nå.</p>`;
  }
}

function eloPlayer(name, before, after, delta) {
  const numericDelta = Number(delta ?? (Number(after) - Number(before)));
  const cls = numericDelta > 0.0001 ? 'up' : numericDelta < -0.0001 ? 'down' : 'flat';
  const sign = numericDelta > 0 ? '+' : '';
  return `<div class="match-elo-player"><span>${escapeHtml(name)}</span><div class="match-elo-values"><strong>${Number(before).toFixed(1)} → ${Number(after).toFixed(1)}</strong><em class="match-elo-delta ${cls}">${sign}${numericDelta.toFixed(1)}</em></div></div>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
