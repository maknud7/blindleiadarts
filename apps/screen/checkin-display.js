const API_ROOT = "../api/v1";
const TOKEN_KEY = "bd:screenToken";
let timer = null;

function ensureUi() {
  if (document.getElementById("venueCheckinBanner")) return;
  const style = document.createElement("style");
  style.textContent = `.venue-checkin-banner{position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:1000;width:min(720px,calc(100% - 36px));background:rgba(7,19,27,.97);border:2px solid rgba(77,212,166,.65);border-radius:18px;padding:14px 20px;box-shadow:0 18px 55px rgba(0,0,0,.48);display:grid;grid-template-columns:1fr auto;align-items:center;gap:22px}.venue-checkin-banner.hidden{display:none}.venue-checkin-copy{display:grid;gap:3px}.venue-checkin-copy strong{font-size:20px}.venue-checkin-copy span{color:var(--muted,#a8b3bd)}.venue-checkin-code{font-size:38px;font-weight:900;letter-spacing:.16em;white-space:nowrap}.venue-checkin-label{font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#4dd4a6}@media(max-width:680px){.venue-checkin-banner{grid-template-columns:1fr;text-align:center;gap:8px}.venue-checkin-code{font-size:32px}}`;
  document.head.appendChild(style);
  const banner = document.createElement("aside");
  banner.id = "venueCheckinBanner";
  banner.className = "venue-checkin-banner hidden";
  banner.innerHTML = `<div class="venue-checkin-copy"><span class="venue-checkin-label">Check-in åpen</span><strong id="venueCheckinName">Turnering</strong><span>Tast koden i spillerportalen – eller gå til turneringsleder.</span></div><div id="venueCheckinCode" class="venue-checkin-code">------</div>`;
  document.body.appendChild(banner);
}

async function refresh() {
  ensureUi();
  const banner = document.getElementById("venueCheckinBanner");
  const token = localStorage.getItem(TOKEN_KEY) || "";
  if (!token) { banner.classList.add("hidden"); return; }
  try {
    const response = await fetch(`${API_ROOT}/public/check-in-display?screen_token=${encodeURIComponent(token)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    const data = payload?.ok ? payload.data : null;
    if (!response.ok || !data?.active || !data.checkin?.code) { banner.classList.add("hidden"); return; }
    document.getElementById("venueCheckinName").textContent = data.checkin.tournament_name || "Turnering";
    document.getElementById("venueCheckinCode").textContent = data.checkin.code;
    banner.classList.remove("hidden");
  } catch {
    // Do not disturb the venue screen if only the check-in helper endpoint is unavailable.
  }
}

ensureUi();
refresh();
timer = window.setInterval(refresh, 5000);
window.addEventListener("storage", (event) => { if (event.key === TOKEN_KEY) refresh(); });
window.addEventListener("beforeunload", () => { if (timer) window.clearInterval(timer); });
