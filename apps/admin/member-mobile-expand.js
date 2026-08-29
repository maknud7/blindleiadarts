(() => {
  const MOBILE_QUERY = window.matchMedia('(max-width:760px)');
  const selector = '.member-access-table-wrap tr[data-member-id]';

  function prepareRow(row) {
    if (!(row instanceof HTMLElement) || row.dataset.mobileExpandReady === '1') return;
    row.dataset.mobileExpandReady = '1';
    row.setAttribute('tabindex', '0');
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', 'false');
    const name = row.querySelector('[data-label="Medlem"] strong')?.textContent?.trim();
    if (name) row.setAttribute('aria-label', `Vis mer informasjon om ${name}`);
  }

  function setExpanded(row, expanded) {
    row.classList.toggle('member-expanded', expanded);
    row.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function toggleRow(row) {
    if (!MOBILE_QUERY.matches) return;
    const expanded = !row.classList.contains('member-expanded');
    document.querySelectorAll(selector + '.member-expanded').forEach(other => {
      if (other !== row) setExpanded(other, false);
    });
    setExpanded(row, expanded);
  }

  function prepareAll() {
    document.querySelectorAll(selector).forEach(prepareRow);
  }

  document.addEventListener('click', event => {
    if (!MOBILE_QUERY.matches) return;
    const row = event.target.closest(selector);
    if (!row) return;
    if (event.target.closest('button,a,input,select,textarea,label')) return;
    toggleRow(row);
  });

  document.addEventListener('keydown', event => {
    if (!MOBILE_QUERY.matches || (event.key !== 'Enter' && event.key !== ' ')) return;
    const row = event.target.closest(selector);
    if (!row || event.target.closest('button,a,input,select,textarea')) return;
    event.preventDefault();
    toggleRow(row);
  });

  const observer = new MutationObserver(prepareAll);
  const start = () => {
    prepareAll();
    const root = document.querySelector('#players') || document.body;
    observer.observe(root, { childList: true, subtree: true });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  MOBILE_QUERY.addEventListener?.('change', event => {
    if (!event.matches) document.querySelectorAll(selector + '.member-expanded').forEach(row => setExpanded(row, false));
    prepareAll();
  });
})();
