const CLUB_LIVE_ENDPOINT = "../api/club-live.php";

const style = document.createElement("style");
style.textContent = `
  .club-live-card{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:18px;margin:0 0 20px;padding:18px 20px;border:1px solid var(--line);border-radius:18px;background:linear-gradient(135deg,rgba(233,185,73,.09),rgba(21,27,36,.94))}
  .club-live-card h2{margin:0 0 5px;font-size:22px;letter-spacing:-.02em}
  .club-live-card p{margin:0;color:var(--muted);line-height:1.4}
  .club-live-link{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-top:10px}
  .club-live-link code{display:inline-flex;align-items:center;min-height:36px;padding:7px 10px;border:1px solid var(--line);border-radius:10px;background:#0f151e;color:#f4f7fb;font:700 13px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
  .club-live-code{display:inline-flex;align-items:center;border-radius:999px;padding:5px 9px;background:rgba(233,185,73,.12);border:1px solid rgba(233,185,73,.35);color:var(--accent-strong);font-size:12px;font-weight:900;letter-spacing:.08em}
  .club-live-actions{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
  .club-live-error{color:#ffc4c4!important}
  @media(max-width:720px){.club-live-card{grid-template-columns:1fr;padding:15px}.club-live-actions{justify-content:stretch}.club-live-actions .button,.club-live-actions button{flex:1}.club-live-link{display:grid}.club-live-link code{width:100%}}
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
    <h2>Én fast Live-lenke</h2>
    <p>Samme adresse brukes på klubb-TV, ved deling og for alle klubbens turneringer.</p>
    <div class="club-live-link"><span id="clubLiveCode" class="club-live-code">----</span><code id="clubLiveUrl">Henter Live-lenke …</code></div>
  </div>
  <div class="club-live-actions">
    <a id="clubLiveOpen" class="button" href="../live/" target="_blank" rel="noopener">Åpne Live</a>
    <button id="clubLiveCopy" type="button" class="button secondary">Kopier lenke</button>
  </div>`;
shortcuts?.insertAdjacentElement("afterend", card);

const el = {
  code: card.querySelector("#clubLiveCode"),
  url: card.querySelector("#clubLiveUrl"),
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
  el.url.textContent = "Henter Live-lenke …";
  el.url.classList.remove("club-live-error");
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
    el.url.textContent = currentUrl;
    el.open.href = currentUrl;
    el.copy.disabled = false;

    // The existing top-bar Live button follows the selected club too.
    document.querySelectorAll('.topbar-actions a[href*="/live/"]').forEach((anchor) => {
      anchor.href = currentUrl;
    });
  } catch (error) {
    currentUrl = "";
    requestKey = "";
    el.url.textContent = error?.message || "Live-lenken er ikke tilgjengelig.";
    el.url.classList.add("club-live-error");
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
    el.url.textContent = currentUrl;
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
