const CLUB_LIVE_ENDPOINT = "../api/club-live.php";

const style = document.createElement("style");
style.textContent = `
  .club-live-card{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:18px;margin:0 0 20px;padding:18px 20px;border:1px solid var(--line);border-radius:18px;background:var(--surface,#fff);box-shadow:0 8px 24px rgba(15,23,42,.05)}
  .club-live-card h2{margin:0 0 5px;font-size:22px;letter-spacing:-.02em;color:var(--text,#0f2744)}
  .club-live-card p{margin:0;color:var(--muted);line-height:1.4}
  .club-live-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px}
  .club-live-code-label{font-size:.75rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
  .club-live-code{display:inline-flex;align-items:center;border-radius:999px;padding:7px 12px;background:rgba(47,111,237,.08);border:1px solid rgba(47,111,237,.18);color:var(--accent-strong,#175bb8);font-size:15px;font-weight:900;letter-spacing:.12em}
  .club-live-status{font-size:.84rem;color:var(--muted)}
  .club-live-status.bad{color:#b42318}
  .club-live-actions{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
  .club-live-actions .button{min-width:132px;text-align:center}
  @media(max-width:720px){
    .club-live-card{grid-template-columns:1fr;padding:16px;gap:16px}
    .club-live-actions{justify-content:stretch}
    .club-live-actions .button,.club-live-actions button{flex:1;min-width:0}
  }
`;
document.head.appendChild(style);

// Venue screen registration is legacy UX. Keep the backend/table temporarily,
// but remove it from the club administrator's equipment flow.
document.getElementById("screens")?.remove();

const equipmentShortcut = document.querySelector('.portal-shortcuts a[href="#kiosks"] span');
if (equipmentShortcut) equipmentShortcut.textContent = "Skiver, nettbrett og Scolia";

const overview = document.getElementById("overview");
const shortcuts = overview?.querySelector(".portal-shortcuts");
const card = document.createElement("section");
card.className = "club-live-card";
card.innerHTML = `
  <div>
    <p class="eyebrow">Klubbens Live</p>
    <h2>Fast Live-lenke</h2>
    <p>Samme Live-side brukes på klubb-TV, ved deling og for alle klubbens turneringer.</p>
    <div class="club-live-meta">
      <span class="club-live-code-label">Live-kode</span>
      <span id="clubLiveCode" class="club-live-code">----</span>
      <span id="clubLiveStatus" class="club-live-status">Henter …</span>
    </div>
  </div>
  <div class="club-live-actions">
    <a id="clubLiveOpen" class="button" href="../live/" target="_blank" rel="noopener">Åpne Live</a>
    <button id="clubLiveCopy" type="button" class="button secondary">Kopier lenke</button>
  </div>`;
shortcuts?.insertAdjacentElement("afterend", card);

const el = {
  code: card.querySelector("#clubLiveCode"),
  status: card.querySelector("#clubLiveStatus"),
  open: card.querySelector("#clubLiveOpen"),
  copy: card.querySelector("#clubLiveCopy"),
};

let currentUrl = "";
let requestKey = "";

function selectedClubId() {
  return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0);
}

function hideLegacyScreenMetric() {
  const metrics = document.getElementById("metrics");
  if (!metrics) return;
  [...metrics.querySelectorAll(".metric")].forEach((metric) => {
    const label = metric.querySelector("span")?.textContent?.trim().toLocaleLowerCase("nb") || "";
    if (label === "live-skjermer") metric.remove();
  });
}

async function loadClubLive(force = false) {
  const clubId = selectedClubId();
  if (!clubId) return;
  const key = String(clubId);
  if (!force && key === requestKey && currentUrl) return;
  requestKey = key;

  el.code.textContent = "----";
  el.status.textContent = "Henter …";
  el.status.classList.remove("bad");
  el.open.setAttribute("href", "../live/");
  el.copy.disabled = true;

  try {
    const endpoint = new URL(CLUB_LIVE_ENDPOINT, window.location.href);
    endpoint.searchParams.set("club_id", String(clubId));
    const response = await fetch(endpoint, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok || !payload?.data?.live_url) {
      throw new Error(payload?.error?.message || "Kunne ikke hente Live-lenken.");
    }

    const code = String(payload.data.club?.live_code || "");
    currentUrl = String(payload.data.live_url);
    el.code.textContent = code || "----";
    el.status.textContent = "Klar";
    el.open.href = currentUrl;
    el.copy.disabled = false;

    // The existing top-bar Live button follows the selected club too.
    document.querySelectorAll('.topbar-actions a[href*="/live/"]').forEach((anchor) => {
      anchor.href = currentUrl;
    });
  } catch (error) {
    currentUrl = "";
    requestKey = "";
    el.status.textContent = error?.message || "Live-lenken er ikke tilgjengelig.";
    el.status.classList.add("bad");
  }
}

el.copy?.addEventListener("click", async () => {
  if (!currentUrl) return;
  try {
    await navigator.clipboard.writeText(currentUrl);
    const previous = el.copy.textContent;
    el.copy.textContent = "Kopiert";
    window.setTimeout(() => { el.copy.textContent = previous; }, 1200);
  } catch {
    el.status.textContent = "Kunne ikke kopiere lenken.";
    el.status.classList.add("bad");
  }
});

document.getElementById("clubSelect")?.addEventListener("change", () => {
  currentUrl = "";
  requestKey = "";
  window.setTimeout(() => loadClubLive(true), 50);
});

document.getElementById("refreshAllButton")?.addEventListener("click", () => {
  window.setTimeout(() => {
    hideLegacyScreenMetric();
    loadClubLive(true);
  }, 120);
});

window.addEventListener("bd:portal-view", () => {
  hideLegacyScreenMetric();
  loadClubLive();
});

const metrics = document.getElementById("metrics");
if (metrics) {
  new MutationObserver(hideLegacyScreenMetric).observe(metrics, { childList: true });
}

hideLegacyScreenMetric();
window.setTimeout(() => loadClubLive(true), 100);
