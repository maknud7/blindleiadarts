const API_ROOT = "../api/v1";
const host = document.getElementById("tournaments");

if (host) {
  const workspace = host.querySelector(".tc-workspace");

  if (workspace && !document.getElementById("tcDesktopRail")) {
    const style = document.createElement("style");
    style.textContent = `
      .tc-desktop-grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:22px;align-items:start}
      .tc-workflow-main{min-width:0}
      .tc-desktop-rail{position:sticky;top:92px;display:grid;gap:14px;min-width:0}
      .tc-rail-card{border:1px solid var(--line);border-radius:16px;background:#f8fbfd;padding:14px;box-shadow:0 8px 22px rgba(26,65,96,.045)}
      .tc-rail-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
      .tc-rail-head h4{margin:0;color:var(--text);font-size:14px}
      .tc-rail-head small{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:800}
      .tc-rail-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}
      .tc-rail-stat{display:grid;gap:2px;padding:9px 8px;border:1px solid var(--line);border-radius:11px;background:#fff;text-align:center}
      .tc-rail-stat strong{font-size:20px;line-height:1;color:var(--text)}
      .tc-rail-stat span{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:800}
      .tc-upcoming-list{display:grid;gap:7px}
      .tc-upcoming-item{display:grid;gap:3px;padding:9px 10px;border:1px solid var(--line);border-radius:11px;background:#fff;color:var(--text)}
      .tc-upcoming-item strong{font-size:12px;line-height:1.25}
      .tc-upcoming-item span{font-size:10px;color:var(--muted);font-weight:600}
      .tc-upcoming-item.is-current{border-color:#9bc1df;background:#edf6fd}
      .tc-rail-empty{margin:0;color:var(--muted);font-size:11px;line-height:1.4}
      @media(max-width:1100px){.tc-desktop-grid{grid-template-columns:minmax(0,1fr) 260px;gap:16px}.tc-rail-stats{grid-template-columns:1fr}.tc-rail-stat{grid-template-columns:auto 1fr;align-items:center;text-align:left}.tc-rail-stat strong{font-size:18px}.tc-rail-stat span{justify-self:end}}
      @media(max-width:900px){.tc-desktop-grid{display:block}.tc-desktop-rail{display:none}}
    `;
    document.head.appendChild(style);

    const roomHead = workspace.querySelector(":scope > .tc-room-head");
    const grid = document.createElement("div");
    grid.className = "tc-desktop-grid";

    const main = document.createElement("div");
    main.className = "tc-workflow-main";
    [...workspace.children].forEach((child) => {
      if (child !== roomHead) main.appendChild(child);
    });

    const rail = document.createElement("aside");
    rail.id = "tcDesktopRail";
    rail.className = "tc-desktop-rail";
    rail.setAttribute("aria-label", "Turneringsoversikt");
    rail.innerHTML = `
      <section class="tc-rail-card">
        <div class="tc-rail-head"><h4>Nå</h4><small>Kveldens status</small></div>
        <div class="tc-rail-stats">
          <div class="tc-rail-stat"><strong id="tcRailActive">0</strong><span>Aktive</span></div>
          <div class="tc-rail-stat"><strong id="tcRailChecked">0</strong><span>Klare</span></div>
          <div class="tc-rail-stat"><strong id="tcRailPending">0</strong><span>Mangler</span></div>
        </div>
      </section>
      <section class="tc-rail-card">
        <div class="tc-rail-head"><h4>Kommende</h4><small>Kun oversikt</small></div>
        <div id="tcUpcomingList" class="tc-upcoming-list"><p class="tc-rail-empty">Laster …</p></div>
      </section>`;

    grid.append(main, rail);
    if (roomHead) roomHead.after(grid);
    else workspace.appendChild(grid);

    let tournaments = [];
    let context = window.__bdTournamentContext || null;

    function clubId() {
      return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0);
    }

    function esc(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function dateValue(value) {
      if (!value) return null;
      const date = new Date(String(value).replace(" ", "T"));
      return Number.isNaN(date.getTime()) ? null : date;
    }

    function formatDate(value) {
      const date = dateValue(value);
      if (!date) return "Tid ikke satt";
      return new Intl.DateTimeFormat("nb-NO", {
        weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
      }).format(date);
    }

    function renderStats() {
      document.getElementById("tcRailActive").textContent = String(Number(document.getElementById("tcAllCount")?.textContent || 0));
      document.getElementById("tcRailChecked").textContent = String(Number(document.getElementById("tcCheckedCount")?.textContent || 0));
      document.getElementById("tcRailPending").textContent = String(Number(document.getElementById("tcPendingCount")?.textContent || 0));
    }

    function renderUpcoming() {
      const target = document.getElementById("tcUpcomingList");
      if (!target) return;
      const now = Date.now() - 12 * 60 * 60 * 1000;
      const items = tournaments
        .filter((item) => !["completed", "archived"].includes(String(item.status || "")))
        .filter((item) => {
          const date = dateValue(item.start_at);
          return !date || date.getTime() >= now || String(item.status) === "in_progress";
        })
        .sort((a, b) => (dateValue(a.start_at)?.getTime() || Number.MAX_SAFE_INTEGER) - (dateValue(b.start_at)?.getTime() || Number.MAX_SAFE_INTEGER))
        .slice(0, 5);

      if (!items.length) {
        target.innerHTML = `<p class="tc-rail-empty">Ingen kommende turneringer.</p>`;
        return;
      }

      target.innerHTML = items.map((item) => {
        const current = Number(item.id) === Number(context?.id || 0);
        const status = String(item.status || "");
        const suffix = status === "in_progress" ? " · Pågår" : status === "ready" ? " · Klar" : "";
        return `<div class="tc-upcoming-item ${current ? "is-current" : ""}">
          <strong>${esc(item.name)}</strong>
          <span>${esc(formatDate(item.start_at) + suffix)}</span>
        </div>`;
      }).join("");
    }

    async function loadUpcoming() {
      const id = clubId();
      if (!id) return;
      try {
        const response = await fetch(`${API_ROOT}/clubs/${id}/registration-tournaments`, { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) throw new Error();
        tournaments = payload.data?.items || [];
        renderUpcoming();
      } catch {
        const target = document.getElementById("tcUpcomingList");
        if (target) target.innerHTML = `<p class="tc-rail-empty">Kommende turneringer kunne ikke lastes.</p>`;
      }
    }

    function refreshFromContext(nextContext) {
      context = nextContext || context;
      window.requestAnimationFrame(() => {
        renderStats();
        renderUpcoming();
      });
    }

    window.addEventListener("bd:tournament-context", (event) => refreshFromContext(event.detail));
    document.getElementById("clubSelect")?.addEventListener("change", () => {
      tournaments = [];
      loadUpcoming();
    });
    document.getElementById("tcRefresh")?.addEventListener("click", loadUpcoming);

    renderStats();
    loadUpcoming();
  }
}
