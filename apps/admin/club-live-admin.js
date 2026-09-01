const CLUB_LIVE_ENDPOINT = "../api/club-live.php";
const CLUB_LIVE_PROFILE_ENDPOINT = "../api/club-live-profile.php";

const style = document.createElement("style");
style.textContent = `
  .club-live-card{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:18px;margin:0 0 20px;padding:18px 20px;border:1px solid var(--line);border-radius:18px;background:var(--surface,#fff);box-shadow:0 8px 24px rgba(15,23,42,.05)}
  .club-live-card h2{margin:0 0 5px;font-size:22px;letter-spacing:-.02em;color:var(--text,#0f2744)}
  .club-live-card p{margin:0;color:var(--muted);line-height:1.4}
  .club-live-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px}
  .club-live-code-label{font-size:.75rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
  .club-live-code{display:inline-flex;align-items:center;border-radius:999px;padding:7px 12px;background:rgba(47,111,237,.08);border:1px solid rgba(47,111,237,.18);color:var(--accent-strong,#175bb8);font-size:15px;font-weight:900;letter-spacing:.12em}
  .club-live-status{font-size:.84rem;color:var(--muted)}
  .club-live-status.bad{color:#b42318}.club-live-status.good{color:#18733d}
  .club-live-actions{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
  .club-live-actions .button{min-width:132px;text-align:center}
  .club-live-profiles{grid-column:1/-1;border-top:1px solid var(--line);padding-top:16px}
  .club-live-profiles-head{display:flex;align-items:end;justify-content:space-between;gap:12px;margin-bottom:10px}
  .club-live-profiles-head strong{display:block;color:var(--text,#0f2744);font-size:.92rem}.club-live-profiles-head span{font-size:.78rem;color:var(--muted)}
  .club-live-profile-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  .club-live-profile{position:relative;display:grid;grid-template-columns:76px minmax(0,1fr);gap:12px;align-items:center;padding:11px;border:1px solid var(--line);border-radius:14px;background:var(--surface,#fff);cursor:pointer;transition:border-color .15s ease,box-shadow .15s ease,transform .15s ease}
  .club-live-profile:hover{border-color:#9cbce6;transform:translateY(-1px)}
  .club-live-profile:has(input:checked){border-color:#2f6fed;box-shadow:0 0 0 2px rgba(47,111,237,.13)}
  .club-live-profile input{position:absolute;opacity:0;pointer-events:none}
  .club-live-profile-preview{height:48px;border-radius:9px;border:1px solid rgba(15,39,68,.14);overflow:hidden;display:grid;grid-template-rows:14px 1fr;padding:5px;gap:4px}
  .club-live-profile-preview::before{content:"";display:block;border-radius:4px}.club-live-profile-preview::after{content:"";display:block;border-radius:4px}
  .club-live-profile-preview.blindleia{background:#eef3f8}.club-live-profile-preview.blindleia::before{background:#073a79}.club-live-profile-preview.blindleia::after{background:linear-gradient(90deg,#fff 0 66%,#dce9f6 66%)}
  .club-live-profile-preview.dark{background:#06111f;border-color:#203a55}.club-live-profile-preview.dark::before{background:#0a4287}.club-live-profile-preview.dark::after{background:linear-gradient(90deg,#0b1c2d 0 66%,#102941 66%)}
  .club-live-profile-copy strong{display:block;margin-bottom:2px;color:var(--text,#0f2744);font-size:.88rem}.club-live-profile-copy span{display:block;color:var(--muted);font-size:.75rem;line-height:1.3}
  .club-live-profile-saving{opacity:.58;pointer-events:none}
  @media(max-width:720px){
    .club-live-card{grid-template-columns:1fr;padding:16px;gap:16px}
    .club-live-actions{justify-content:stretch}.club-live-actions .button,.club-live-actions button{flex:1;min-width:0}
    .club-live-profile-grid{grid-template-columns:1fr}.club-live-profiles-head{align-items:start;flex-direction:column}
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
  </div>
  <div class="club-live-profiles">
    <div class="club-live-profiles-head">
      <div><strong>Visningsprofil på Live-skjermen</strong><span>Lagres per klubb og brukes på den faste Live-lenken.</span></div>
      <span id="clubLiveProfileStatus">Henter profil …</span>
    </div>
    <div id="clubLiveProfileGrid" class="club-live-profile-grid" role="radiogroup" aria-label="Live-visningsprofil">
      <label class="club-live-profile">
        <input type="radio" name="clubLiveProfile" value="blindleia">
        <span class="club-live-profile-preview blindleia" aria-hidden="true"></span>
        <span class="club-live-profile-copy"><strong>Blindleia</strong><span>Klubbens blå/hvite profil. Lys, tydelig og kjent.</span></span>
      </label>
      <label class="club-live-profile">
        <input type="radio" name="clubLiveProfile" value="broadcast-dark">
        <span class="club-live-profile-preview dark" aria-hidden="true"></span>
        <span class="club-live-profile-copy"><strong>Dark live</strong><span>Mørk TV-/scoreboardprofil med Blindleia-blå som hovedfarge.</span></span>
      </label>
    </div>
  </div>`;
shortcuts?.insertAdjacentElement("afterend", card);

const el = {
  code: card.querySelector("#clubLiveCode"), status: card.querySelector("#clubLiveStatus"),
  open: card.querySelector("#clubLiveOpen"), copy: card.querySelector("#clubLiveCopy"),
  profileGrid: card.querySelector("#clubLiveProfileGrid"), profileStatus: card.querySelector("#clubLiveProfileStatus"),
};

let currentUrl = "";
let requestKey = "";
let currentProfile = "blindleia";
let savingProfile = false;

function selectedClubId() {
  return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0);
}
function authToken() { return localStorage.getItem("bd:token") || ""; }
function setProfileChoice(profile) {
  currentProfile = ["blindleia", "broadcast-dark"].includes(profile) ? profile : "blindleia";
  card.querySelectorAll('input[name="clubLiveProfile"]').forEach((input) => { input.checked = input.value === currentProfile; });
}
function setProfileBusy(busy) {
  savingProfile = busy;
  el.profileGrid?.classList.toggle("club-live-profile-saving", busy);
  card.querySelectorAll('input[name="clubLiveProfile"]').forEach((input) => { input.disabled = busy; });
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
  el.status.classList.remove("bad", "good");
  el.profileStatus.textContent = "Henter profil …";
  el.open.setAttribute("href", "../live/");
  el.copy.disabled = true;

  try {
    const endpoint = new URL(CLUB_LIVE_ENDPOINT, window.location.href);
    endpoint.searchParams.set("club_id", String(clubId));
    const response = await fetch(endpoint, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok || !payload?.data?.live_url) throw new Error(payload?.error?.message || "Kunne ikke hente Live-lenken.");

    const code = String(payload.data.club?.live_code || "");
    currentUrl = String(payload.data.live_url);
    setProfileChoice(String(payload.data.club?.live_display_profile || "blindleia"));
    el.code.textContent = code || "----";
    el.status.textContent = "Klar";
    el.profileStatus.textContent = currentProfile === "broadcast-dark" ? "Dark live er aktiv" : "Blindleia er aktiv";
    el.open.href = currentUrl;
    el.copy.disabled = false;

    document.querySelectorAll('.topbar-actions a[href*="/live/"]').forEach((anchor) => { anchor.href = currentUrl; });
  } catch (error) {
    currentUrl = "";
    requestKey = "";
    el.status.textContent = error?.message || "Live-lenken er ikke tilgjengelig.";
    el.status.classList.add("bad");
    el.profileStatus.textContent = "Profil ikke tilgjengelig";
  }
}

async function saveProfile(profile) {
  const clubId = selectedClubId();
  if (!clubId || savingProfile || profile === currentProfile) return;
  const previous = currentProfile;
  setProfileChoice(profile);
  setProfileBusy(true);
  el.profileStatus.textContent = "Lagrer …";
  try {
    const response = await fetch(CLUB_LIVE_PROFILE_ENDPOINT, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken()}` },
      body: JSON.stringify({ club_id: clubId, live_display_profile: profile }),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || "Kunne ikke lagre Live-profilen.");
    setProfileChoice(String(payload.data?.club?.live_display_profile || profile));
    el.profileStatus.textContent = currentProfile === "broadcast-dark" ? "Dark live er aktiv" : "Blindleia er aktiv";
    el.status.textContent = "Profil lagret";
    el.status.classList.remove("bad"); el.status.classList.add("good");
  } catch (error) {
    setProfileChoice(previous);
    el.profileStatus.textContent = error?.message || "Kunne ikke lagre profil.";
    el.status.classList.remove("good"); el.status.classList.add("bad");
  } finally {
    setProfileBusy(false);
  }
}

el.profileGrid?.addEventListener("change", (event) => {
  const input = event.target instanceof HTMLInputElement ? event.target : null;
  if (input?.name === "clubLiveProfile" && input.checked) saveProfile(input.value);
});

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
  currentUrl = ""; requestKey = "";
  window.setTimeout(() => loadClubLive(true), 50);
});
document.getElementById("refreshAllButton")?.addEventListener("click", () => {
  window.setTimeout(() => { hideLegacyScreenMetric(); loadClubLive(true); }, 120);
});
window.addEventListener("bd:portal-view", () => { hideLegacyScreenMetric(); loadClubLive(); });

const metrics = document.getElementById("metrics");
if (metrics) new MutationObserver(hideLegacyScreenMetric).observe(metrics, { childList: true });

hideLegacyScreenMetric();
window.setTimeout(() => loadClubLive(true), 100);
