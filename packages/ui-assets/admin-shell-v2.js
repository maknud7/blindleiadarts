const isAdminSurface = document.body.dataset.bdSurface === "admin";

if (isAdminSurface) {
  const API_ROOT = "../api/v1";

  const esc = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  const token = () => localStorage.getItem("bd:token") || "";
  const clubId = () => Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0);

  async function api(path, auth = false) {
    const headers = {};
    if (auth && token()) headers.Authorization = `Bearer ${token()}`;
    const response = await fetch(`${API_ROOT}${path}`, { headers, cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  }

  function ensurePlayerArea() {
    const nav = document.querySelector(".section-nav.portal-menu");
    const main = document.querySelector("main.main");
    if (!nav || !main) return;

    if (!nav.querySelector('a[href="#playerbase"]')) {
      const link = document.createElement("a");
      link.href = "#playerbase";
      link.dataset.portalNav = "1";
      link.textContent = "Spillere";
      const tournaments = nav.querySelector('a[href="#tournaments"]');
      tournaments?.after(link);
    }

    if (!document.getElementById("playerbase")) {
      const section = document.createElement("section");
      section.id = "playerbase";
      section.dataset.portalSection = "playerbase";
      section.className = "panel";
      section.innerHTML = `
        <div class="panel-head">
          <div><p class="eyebrow">Spillerbase</p><h2>Spillere</h2><p class="muted">Spillerprofiler og dartstatistikk er skilt fra medlemskap og kontingent.</p></div>
          <a class="button secondary" href="../player/#statistics" target="_blank" rel="noopener">Åpne spillerstatistikk</a>
        </div>
        <div class="subsection-head"><h3>Klubbens spillere</h3><span id="adminPlayerBaseCount" class="pill">0</span></div>
        <div id="adminPlayerBase" class="admin-player-grid"><div class="empty">Laster spillere …</div></div>`;
      document.getElementById("players")?.before(section);
    }

    const shortcuts = document.querySelector("#overview .portal-shortcuts");
    if (shortcuts && !shortcuts.querySelector('a[href="#playerbase"]')) {
      const card = document.createElement("a");
      card.className = "shortcut-card";
      card.href = "#playerbase";
      card.dataset.portalNav = "1";
      card.innerHTML = "<strong>Spillere</strong><span>Profiler, kampdata og dartstatistikk</span>";
      const memberCard = shortcuts.querySelector('a[href="#players"]');
      memberCard?.before(card);
    }
  }

  function ensureAdminTools() {
    const nav = document.querySelector(".section-nav.portal-menu");
    if (!nav || document.getElementById("adminToolSection")) return;

    const tools = document.createElement("div");
    tools.id = "adminToolSection";
    tools.className = "admin-tool-section";
    tools.dataset.roleAccess = "admin";
    tools.innerHTML = `
      <span class="admin-tools-label">Adminverktøy</span>
      <a href="../player/" data-admin-icon="player">Spillerportal</a>
      <a href="../live/" target="_blank" rel="noopener" data-admin-icon="live">Live-skjerm</a>
      <a href="../screen/" target="_blank" rel="noopener" data-admin-icon="screen">Venue-skjerm</a>
      <a href="../kiosk/" target="_blank" rel="noopener" data-admin-icon="terminal">Kiosk / terminal</a>`;
    nav.appendChild(tools);
  }

  function roleLabel(role) {
    if (role === "super_admin") return "Superadmin";
    if (role === "club_admin") return "Klubbadministrator";
    return "Administrator";
  }

  function initials(value) {
    const parts = String(value || "Admin").trim().split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).map((part) => part[0]?.toUpperCase() || "").join("") || "AD";
  }

  async function ensureAdminIdentity() {
    const nav = document.querySelector(".section-nav.portal-menu");
    if (!nav || !token()) return;
    let account = document.getElementById("adminSidebarAccount");
    if (!account) {
      account = document.createElement("div");
      account.id = "adminSidebarAccount";
      account.className = "admin-sidebar-account";
      account.innerHTML = `<span class="admin-sidebar-avatar">AD</span><div><strong>Admin</strong><span>Administrator</span></div>`;
      nav.appendChild(account);
    }
    try {
      const data = await api("/auth/me", true);
      const user = data?.user || {};
      const label = user.display_name || user.name || user.username || user.email || "Admin";
      account.querySelector(".admin-sidebar-avatar").textContent = initials(label);
      account.querySelector("strong").textContent = label;
      account.querySelector("div > span").textContent = roleLabel(user.role);
      document.body.dataset.adminRole = user.role || "";
    } catch {
      // The canonical admin app handles expired sessions; shell identity is best effort only.
    }
  }

  function formatAverage(value) {
    const number = Number(value || 0);
    return number > 0 ? number.toFixed(2) : "—";
  }

  async function loadPlayerArea() {
    const root = document.getElementById("adminPlayerBase");
    const count = document.getElementById("adminPlayerBaseCount");
    const id = clubId();
    if (!root || !count || !id) return;
    try {
      const data = await api(`/clubs/${id}/player-directory`);
      const items = Array.isArray(data?.items) ? data.items : [];
      count.textContent = `${items.length} stk`;
      if (!items.length) {
        root.innerHTML = `<div class="empty">Ingen spillere med registrert aktivitet ennå.</div>`;
        return;
      }
      root.innerHTML = items.map((player) => `
        <article class="admin-player-card">
          <div class="admin-player-card-head">
            <div><strong>${esc(player.display_name)}</strong>${player.nickname ? `<div class="player-nick">${esc(player.nickname)}</div>` : ""}</div>
            <span class="badge ${Number(player.is_active ?? 1) === 1 ? "good" : "neutral"}">${Number(player.is_active ?? 1) === 1 ? "Aktiv" : "Inaktiv"}</span>
          </div>
          <div class="admin-player-stats">
            <div class="admin-player-stat"><strong>${Number(player.matches_played || 0)}</strong><span>Kamper</span></div>
            <div class="admin-player-stat"><strong>${formatAverage(player.three_dart_average ?? player.recorded_average)}</strong><span>3DA</span></div>
            <div class="admin-player-stat"><strong>${Number(player.score_180 || 0)}</strong><span>180</span></div>
          </div>
          <div class="admin-player-actions"><a href="../player/#statistics" target="_blank" rel="noopener">Se i spillerportalen</a></div>
        </article>`).join("");
    } catch (error) {
      root.innerHTML = `<div class="empty">Kunne ikke hente spillerbasen: ${esc(error.message)}</div>`;
    }
  }

  function addLinearSeasonOption() {
    const select = document.querySelector('#seasonForm select[name="ranking_method"]');
    if (!select || select.querySelector('option[value="linear"]')) return;
    const option = document.createElement("option");
    option.value = "linear";
    option.textContent = "Lineær (DartsAtlas)";
    select.prepend(option);
  }

  async function loadSeasonAdmin() {
    try {
      await import(new URL("../../apps/admin/season-admin.js?v=20260827-1238", import.meta.url).href);
      addLinearSeasonOption();
    } catch (error) {
      console.warn("Season admin unavailable", error);
    }
  }

  function initialize() {
    ensurePlayerArea();
    ensureAdminTools();
    ensureAdminIdentity();
    loadPlayerArea();
    loadSeasonAdmin();
  }

  document.getElementById("clubSelect")?.addEventListener("change", () => window.setTimeout(loadPlayerArea, 80));
  window.addEventListener("bd:portal-view", (event) => {
    if (event.detail?.target === "playerbase") loadPlayerArea();
    addLinearSeasonOption();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === "bd:token") ensureAdminIdentity();
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
}
