(() => {
  const PAGE_SIZE = 8;
  const ROTATE_MS = 6000;
  const boards = document.getElementById("boards");
  if (!boards) return;

  const style = document.createElement("style");
  style.dataset.venueWallBoards = "single-board-feature";
  style.textContent = `
    @media (min-width:1180px) and (min-height:650px) {
      body.phase-live .priority-section .boards-grid[data-layout-count="1"] {
        grid-template-columns:minmax(0,1fr) !important;
        grid-template-rows:minmax(0,1fr) !important;
        align-items:stretch !important;
      }

      body.phase-live .priority-section .boards-grid[data-layout-count="1"] .board-card {
        width:100% !important;
        max-width:none !important;
        min-width:0 !important;
        height:100% !important;
        padding:8px 12px !important;
        grid-template-rows:26px minmax(0,1fr) 20px !important;
      }

      body.phase-live .priority-section .boards-grid[data-layout-count="1"] .players {
        min-width:0 !important;
        display:grid !important;
        grid-template-columns:repeat(2,minmax(0,1fr)) !important;
        grid-template-rows:minmax(0,1fr) !important;
        gap:0 !important;
      }

      body.phase-live .priority-section .boards-grid[data-layout-count="1"] .player-line {
        min-width:0 !important;
        height:100% !important;
        grid-template-columns:minmax(0,1fr) 106px 34px !important;
        gap:10px !important;
        padding:8px 12px !important;
        border-top:0 !important;
        align-items:center !important;
      }

      body.phase-live .priority-section .boards-grid[data-layout-count="1"] .player-line + .player-line {
        border-left:1px solid #d8e2ec !important;
      }

      body.phase-live .priority-section .boards-grid[data-layout-count="1"] .player-line strong {
        min-width:0 !important;
        font-size:clamp(1.05rem,1.35vw,1.55rem) !important;
        line-height:1.02 !important;
        white-space:nowrap !important;
        overflow:hidden !important;
        text-overflow:ellipsis !important;
      }

      body.phase-live .priority-section .boards-grid[data-layout-count="1"] .remaining {
        font-size:clamp(2.55rem,3.25vw,3.8rem) !important;
        line-height:.86 !important;
        letter-spacing:-.035em !important;
        text-align:right !important;
      }

      body.phase-live .priority-section .boards-grid[data-layout-count="1"] .legs {
        height:34px !important;
        font-size:1rem !important;
      }

      body.phase-live .priority-section .boards-grid[data-layout-count="1"] .player-line.active {
        background:linear-gradient(90deg,rgba(20,99,210,.12),rgba(20,99,210,.025)) !important;
      }

      body.phase-live .priority-section .boards-grid[data-layout-count="1"] .player-line.active::after {
        right:154px !important;
        display:block !important;
      }

      body.phase-live .priority-section .boards-grid[data-layout-count="1"] .round {
        font-size:.62rem !important;
        line-height:1 !important;
      }
    }
  `;
  document.head.appendChild(style);

  let currentPage = 0;
  let totalBoards = 0;
  let totalPages = 1;
  let signature = "";
  let nextRotationAt = 0;
  let meta = null;

  function boardCards() {
    return Array.from(boards.querySelectorAll(":scope > .board-card"));
  }

  function boardSignature(cards) {
    return cards.map((card, index) => {
      const label = card.querySelector(".board-number")?.textContent?.trim();
      return label || `board-${index + 1}`;
    }).join("|");
  }

  function ensureMeta() {
    if (meta?.isConnected) return meta;
    const heading = boards.closest(".priority-section")?.querySelector(".section-head");
    if (!heading) return null;
    meta = document.createElement("span");
    meta.className = "board-page-meta hidden";
    const updatedAt = heading.querySelector("#updatedAt");
    if (updatedAt) heading.insertBefore(meta, updatedAt);
    else heading.appendChild(meta);
    return meta;
  }

  function updateMeta(start, end) {
    const node = ensureMeta();
    if (!node) return;
    const rotating = totalBoards > PAGE_SIZE;
    node.classList.toggle("hidden", !rotating);
    if (!rotating) {
      node.textContent = "";
      return;
    }
    node.textContent = `Skiver ${start + 1}–${end} av ${totalBoards} · side ${currentPage + 1}/${totalPages} · 6 sek`;
  }

  function applyLayout({ resetOnChange = true } = {}) {
    const cards = boardCards();
    const nextSignature = boardSignature(cards);
    const changed = nextSignature !== signature;

    totalBoards = cards.length;
    totalPages = Math.max(1, Math.ceil(totalBoards / PAGE_SIZE));

    if (changed && resetOnChange) {
      currentPage = 0;
      nextRotationAt = Date.now() + ROTATE_MS;
    }
    signature = nextSignature;

    if (currentPage >= totalPages) currentPage = 0;

    const rotating = totalBoards > PAGE_SIZE;
    const start = rotating ? currentPage * PAGE_SIZE : 0;
    const end = rotating ? Math.min(start + PAGE_SIZE, totalBoards) : totalBoards;

    cards.forEach((card, index) => {
      card.classList.toggle("wall-page-hidden", rotating && (index < start || index >= end));
    });

    const visibleBoards = Math.max(0, end - start);
    const layoutCount = rotating ? PAGE_SIZE : Math.min(PAGE_SIZE, totalBoards);
    boards.dataset.visibleBoardCount = String(visibleBoards);
    boards.dataset.totalBoardCount = String(totalBoards);
    boards.dataset.layoutCount = String(layoutCount);
    boards.dataset.rotation = rotating ? "on" : "off";

    if (!rotating) nextRotationAt = 0;
    updateMeta(start, end);
  }

  const observer = new MutationObserver(() => applyLayout());
  observer.observe(boards, { childList: true });

  window.setInterval(() => {
    if (totalBoards <= PAGE_SIZE || totalPages <= 1) return;
    if (!nextRotationAt) nextRotationAt = Date.now() + ROTATE_MS;
    if (Date.now() < nextRotationAt) return;

    currentPage = (currentPage + 1) % totalPages;
    nextRotationAt = Date.now() + ROTATE_MS;
    applyLayout({ resetOnChange: false });
  }, 250);

  applyLayout();
})();
