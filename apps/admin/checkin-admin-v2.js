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
    <div><p class="eyebrow">Generelt for klubben</p><h3>Check-in</h3></div>
    <p class="muted">Tidspunktene er faste i Blindleia Darts. Du velger bare hvordan spilleren checker inn.</p>
    <div class="settings-grid">
      <label class="wide"><span>Standard metode</span><select id="checkinDefaultMethod"><option value="admin_or_code">Turneringsleder + kode (anbefalt)</option><option value="admin_only">Kun turneringsleder</option><option value="code">Kun kode</option></select></label>
    </div>
    <div class="checkin-policy-cards">
      <article class="mini-card"><strong>Check-in åpner 2 timer før</strong><p class="muted">Regnes automatisk fra planlagt starttid.</p></article>
      <article class="mini-card"><strong>Check-in stenger ved Start</strong><p class="muted">Ingen egen sluttid. Når turneringsleder trykker «Start turnering», stenger check-in umiddelbart.</p></article>
    </div>
    <div class="integration-actions"><button type="submit" class="button">Lagre metode</button></div>
    <p class="muted">Bruker du kode, genereres en unik turneringskode automatisk og vises på Live mens check-in er åpen.</p>`;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    save().catch((error) => message(error.message, true));
  }, true);
  load().catch((error) => message(error.message, true));
  return true;
}

async function load() {
  if (!clubId() || !token()) return;
  const data = await api(`/clubs/${clubId()}/checkin-settings`);
  document.getElementById("checkinDefaultMethod").value = data.settings?.default_method || "admin_or_code";
}

async function save() {
  await api(`/clubs/${clubId()}/checkin-settings`, { method: "PUT", body: {
    default_method: document.getElementById("checkinDefaultMethod").value,
    // Legacy storage stays aligned, but the UI deliberately does not expose timing.
    opens_minutes_before_start: 120,
    closes_minutes_after_start: 0,
  }});
  message("Check-in-metoden er lagret.");
  await load();
}

if (!install()) {
  const timer = window.setInterval(() => { if (install()) window.clearInterval(timer); }, 100);
}
clubSelect?.addEventListener("change", () => window.setTimeout(() => load().catch(() => undefined), 200));
document.getElementById("refreshAllButton")?.addEventListener("click", () => window.setTimeout(() => load().catch(() => undefined), 250));
