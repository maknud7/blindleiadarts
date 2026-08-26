const ACTIVITY_API = "../api/v1";
const ACTIVITY_MIN_REFRESH_MS = 15000;
let activityLoadPromise = null;
let activityLastLoadedAt = 0;

function authToken() { return localStorage.getItem("bd:token") || ""; }
function selectedClubId() { return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0); }
function esc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function formatTime(value) {
  if (!value) return "—";
  const date = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

async function api(path) {
  const response = await fetch(`${ACTIVITY_API}${path}`, { headers: authToken() ? { Authorization: `Bearer ${authToken()}` } : {}, cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    const error = new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload.data;
}

function normalizeLiveLinks() {
  document.querySelectorAll('a[href="../screen/"]').forEach((link) => {
    const inScreenPanel = Boolean(link.closest("#screens"));
    if (inScreenPanel) {
      link.textContent = "Åpne venue-skjerm";
      return;
    }
    link.href = "../live/";
    link.textContent = "Live";
  });
}

function ensureActivityPanel() {
  let settings = document.getElementById("integrations");
  if (!settings) {
    settings = document.createElement("section");
    settings.id = "integrations";
    settings.dataset.portalSection = "integrations";
    settings.className = "panel";
    settings.innerHTML = `<div class="panel-head"><div><p class="eyebrow">Klubbdrift</p><h2>Innstillinger</h2><p class="muted">Integrasjoner, aktivitet og avanserte klubbvalg.</p></div></div>`;
    document.querySelector("main.main")?.appendChild(settings);
  }
  if (document.getElementById("activityAdminPanel")) return;
  const panel = document.createElement("section");
  panel.id = "activityAdminPanel";
  panel.className = "claim-admin-card";
  panel.innerHTML = `
    <div class="panel-head"><div><p class="eyebrow">Bruk av tjenesten</p><h3>Aktivitet</h3><p class="muted">Førsteparts aktivitetslogg uten analyse-cookie. Innloggede hendelser kobles til brukerkontoen; anonyme besøk får ingen varig sporings-ID.</p></div><button id="activityRefresh" type="button" class="button secondary">Oppdater</button></div>
    <div id="activityMetrics" class="metrics"></div>
    <div class="kiosk-layout">
      <div><div class="subsection-head"><h3>Flater · 30 dager</h3></div><div id="activitySurfaces" class="list"></div></div>
      <div><div class="subsection-head"><h3>Mest besøkt</h3></div><div id="activityPaths" class="list"></div></div>
    </div>
    <div class="subsection-head"><h3>Siste aktivitet</h3><span class="pill">maks 100</span></div>
    <div id="activityRecent" class="list"></div>
    <div id="activityMessage" class="message hidden"></div>`;
  settings.appendChild(panel);
  panel.querySelector("#activityRefresh")?.addEventListener("click", () => loadActivity({ force: true }));
}

function render(data) {
  const totals = data.totals || {};
  document.getElementById("activityMetrics").innerHTML = [
    ["Hendelser", Number(totals.events || 0)],
    ["Sidevisninger", Number(totals.page_views || 0)],
    ["Innloggede brukere", Number(totals.logged_in_users || 0)],
  ].map(([label, value]) => `<div class="metric"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("");

  const surfaces = data.surfaces || [];
  document.getElementById("activitySurfaces").innerHTML = surfaces.length
    ? surfaces.map((row) => `<div class="list-row"><div><strong>${esc(row.surface)}</strong><small>${Number(row.page_views || 0)} sidevisninger</small></div><span class="pill">${Number(row.events || 0)} hendelser</span></div>`).join("")
    : `<div class="empty">Ingen aktivitet ennå.</div>`;

  const paths = data.top_paths || [];
  document.getElementById("activityPaths").innerHTML = paths.length
    ? paths.map((row) => `<div class="list-row"><div><strong>${esc(row.path)}</strong></div><span class="pill">${Number(row.page_views || 0)}</span></div>`).join("")
    : `<div class="empty">Ingen sidevisninger ennå.</div>`;

  const recent = data.recent || [];
  document.getElementById("activityRecent").innerHTML = recent.length
    ? recent.map((row) => {
        const actor = row.display_name || row.email || "Anonym";
        return `<div class="list-row"><div><strong>${esc(actor)}</strong><small>${esc(row.surface)} · ${esc(row.event_name)} · ${esc(row.path)}</small></div><span class="pill">${esc(formatTime(row.occurred_at))}</span></div>`;
      }).join("")
    : `<div class="empty">Ingen aktivitet ennå.</div>`;
}

function isActivityViewActive() {
  return document.body.dataset.portalActive === "integrations" || window.location.hash === "#integrations";
}

async function loadActivity({ force = false } = {}) {
  ensureActivityPanel();
  const clubId = selectedClubId();
  if (!clubId || !authToken()) return;
  if (activityLoadPromise) return activityLoadPromise;
  if (!force && Date.now() - activityLastLoadedAt < ACTIVITY_MIN_REFRESH_MS) return;

  activityLoadPromise = (async () => {
    try {
      render(await api(`/clubs/${clubId}/activity?days=30`));
      activityLastLoadedAt = Date.now();
      const message = document.getElementById("activityMessage");
      if (message) message.className = "message hidden";
    } catch (error) {
      const message = document.getElementById("activityMessage");
      if (message) {
        message.textContent = error.status === 429
          ? "For mange forespørsler. Aktivitet oppdateres ikke automatisk nå; prøv igjen senere."
          : error.message;
        message.className = "message error";
      }
    } finally {
      activityLoadPromise = null;
    }
  })();

  return activityLoadPromise;
}

normalizeLiveLinks();
ensureActivityPanel();
document.getElementById("clubSelect")?.addEventListener("change", () => {
  activityLastLoadedAt = 0;
  if (isActivityViewActive()) setTimeout(() => loadActivity({ force: true }), 100);
});
window.addEventListener("bd:portal-view", (event) => {
  if (event.detail?.target === "integrations") loadActivity();
});
setTimeout(() => {
  normalizeLiveLinks();
  if (isActivityViewActive()) loadActivity();
}, 700);
