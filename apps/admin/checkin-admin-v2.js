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
    <div><p class="eyebrow">Innsjekk</p><h3>Standard for klubben</h3></div>
    <div class="settings-grid">
      <label class="wide"><span>Metode</span><select id="checkinDefaultMethod"><option value="admin_or_code">Turneringsleder + kode</option><option value="admin_only">Kun turneringsleder</option><option value="code">Kun kode</option></select></label>
      <label><span>Åpner før start</span><div class="field-with-unit"><input id="checkinBefore" type="number" min="0" max="1440"><span>min</span></div></label>
    </div>
    <div class="integration-actions"><button type="submit" class="button">Lagre</button></div>`;

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
  const s = data.settings || {};
  document.getElementById("checkinDefaultMethod").value = s.default_method || "admin_or_code";
  document.getElementById("checkinBefore").value = Number(s.opens_minutes_before_start ?? 60);
}

async function save() {
  await api(`/clubs/${clubId()}/checkin-settings`, { method: "PUT", body: {
    default_method: document.getElementById("checkinDefaultMethod").value,
    opens_minutes_before_start: Number(document.getElementById("checkinBefore").value || 60),
  }});
  message("Innsjekk-standarden er lagret.");
  await load();
}

if (!install()) {
  const timer = window.setInterval(() => { if (install()) window.clearInterval(timer); }, 100);
}
clubSelect?.addEventListener("change", () => window.setTimeout(() => load().catch(() => undefined), 200));
document.getElementById("refreshAllButton")?.addEventListener("click", () => window.setTimeout(() => load().catch(() => undefined), 250));
