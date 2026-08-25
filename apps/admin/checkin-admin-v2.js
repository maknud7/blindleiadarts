const API_ROOT = "../api/v1";
const clubSelect = document.getElementById("clubSelect");
let installed = false;

function token() { return localStorage.getItem("bd:token") || ""; }
function clubId() { return Number(clubSelect?.value || localStorage.getItem("bd:selectedClubId") || 0); }

async function api(path, { method = "GET", body } = {}) {
  const headers = { Authorization: `Bearer ${token()}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API_ROOT}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data;
}

function message(text, bad = false) {
  const root = document.getElementById("scoliaAdminMessage");
  if (!root) return;
  root.textContent = text;
  root.className = `integration-status ${bad ? "bad" : "good"}`;
}

function install() {
  const form = document.getElementById("checkinGeneralForm");
  if (!form || installed) return false;
  installed = true;
  form.innerHTML = `
    <div><p class="eyebrow">Generelt for klubben</p><h3>Check-in-standard</h3></div>
    <p class="muted">Anbefalt flyt er at turneringsleder checker inn spillere, eller at spilleren taster en unik turneringskode som vises på Live-skjermen.</p>
    <div class="settings-grid">
      <label class="wide"><span>Standard metode</span><select id="checkinDefaultMethod"><option value="admin_or_code">Turneringsleder + kode (anbefalt)</option><option value="admin_only">Kun turneringsleder</option><option value="code">Kun kode</option><option value="gps">GPS</option></select></label>
      <label><span>Åpner før start (min)</span><input id="checkinBefore" type="number" min="0" max="1440"></label>
      <label><span>Stenger etter start (min)</span><input id="checkinAfter" type="number" min="0" max="360"></label>
      <label class="check-row wide"><input id="checkinGpsFallback" type="checkbox"><span>Tillat GPS som fallback når kode ikke kan brukes</span></label>
      <div class="wide" style="border-top:1px solid var(--line);padding-top:10px"><strong>GPS-fallback</strong><p class="muted">Disse feltene brukes bare når GPS-metoden/fallback faktisk velges.</p></div>
      <label><span>Breddegrad</span><input id="venueLat" inputmode="decimal" placeholder="58.24..."></label>
      <label><span>Lengdegrad</span><input id="venueLng" inputmode="decimal" placeholder="8.37..."></label>
      <label><span>Radius på arena (meter)</span><input id="venueRadius" type="number" min="20" max="5000"></label>
      <label><span>Maks GPS-unøyaktighet (meter)</span><input id="venueAccuracy" type="number" min="20" max="2000"></label>
      <label class="check-row wide"><input id="checkinRequireGeo" type="checkbox"><span>GPS-fallback må være fysisk innenfor arena-radius</span></label>
    </div>
    <div class="integration-actions"><button type="submit" class="button">Lagre check-in-standard</button><button id="useVenueLocation" type="button" class="button secondary">Sett GPS-fallback-posisjon her</button></div>
    <p id="venueReadout" class="muted location-readout"></p>`;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    save().catch((error) => message(error.message, true));
  }, true);
  document.getElementById("useVenueLocation")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    useLocation().catch((error) => message(error.message, true));
  }, true);
  load().catch((error) => message(error.message, true));
  return true;
}

async function load() {
  if (!clubId() || !token()) return;
  const data = await api(`/clubs/${clubId()}/checkin-settings`);
  const s = data.settings || {};
  document.getElementById("checkinDefaultMethod").value = s.default_method || "admin_or_code";
  document.getElementById("checkinBefore").value = Number(s.opens_minutes_before_start ?? 60);
  document.getElementById("checkinAfter").value = Number(s.closes_minutes_after_start ?? 10);
  document.getElementById("checkinGpsFallback").checked = Number(s.gps_fallback_enabled ?? 1) === 1;
  document.getElementById("venueLat").value = s.venue_latitude ?? "";
  document.getElementById("venueLng").value = s.venue_longitude ?? "";
  document.getElementById("venueRadius").value = Number(s.onsite_radius_meters || 150);
  document.getElementById("venueAccuracy").value = Number(s.max_location_accuracy_meters || 250);
  document.getElementById("checkinRequireGeo").checked = Number(s.require_geolocation ?? 1) === 1;
  document.getElementById("venueReadout").textContent = s.venue_latitude != null && s.venue_longitude != null
    ? `GPS-fallback: ${Number(s.venue_latitude).toFixed(7)}, ${Number(s.venue_longitude).toFixed(7)}`
    : "GPS-fallback-posisjon er ikke satt. Det påvirker ikke kode/admin-check-in.";
}

async function save() {
  const latRaw = document.getElementById("venueLat").value.trim();
  const lngRaw = document.getElementById("venueLng").value.trim();
  await api(`/clubs/${clubId()}/checkin-settings`, { method: "PUT", body: {
    default_method: document.getElementById("checkinDefaultMethod").value,
    opens_minutes_before_start: Number(document.getElementById("checkinBefore").value || 60),
    closes_minutes_after_start: Number(document.getElementById("checkinAfter").value || 10),
    gps_fallback_enabled: document.getElementById("checkinGpsFallback").checked,
    venue_latitude: latRaw === "" ? null : Number(latRaw),
    venue_longitude: lngRaw === "" ? null : Number(lngRaw),
    onsite_radius_meters: Number(document.getElementById("venueRadius").value || 150),
    max_location_accuracy_meters: Number(document.getElementById("venueAccuracy").value || 250),
    require_geolocation: document.getElementById("checkinRequireGeo").checked,
  }});
  message("Check-in-standarden er lagret.");
  await load();
}

function useLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("Nettleseren støtter ikke posisjon.")); return; }
    navigator.geolocation.getCurrentPosition((pos) => {
      document.getElementById("venueLat").value = pos.coords.latitude.toFixed(7);
      document.getElementById("venueLng").value = pos.coords.longitude.toFixed(7);
      document.getElementById("venueReadout").textContent = `Valgt GPS-fallback-posisjon: ${pos.coords.latitude.toFixed(7)}, ${pos.coords.longitude.toFixed(7)} · nøyaktighet ca. ${Math.round(pos.coords.accuracy)} m`;
      resolve();
    }, () => reject(new Error("Kunne ikke lese posisjonen.")), { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  });
}

const timer = window.setInterval(() => { if (install()) window.clearInterval(timer); }, 100);
clubSelect?.addEventListener("change", () => window.setTimeout(() => load().catch(() => undefined), 200));
document.getElementById("refreshAllButton")?.addEventListener("click", () => window.setTimeout(() => load().catch(() => undefined), 250));
