const API_ROOT = "../api/v1";
const host = document.getElementById("tournaments");

if (host) {
  let currentSettings = null;
  let loadTimer = null;

  function token() { return localStorage.getItem("bd:token") || ""; }
  function tournamentId() { return Number(document.getElementById("tcTournament")?.value || 0); }
  function esc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
  function localInput(value) { return value ? String(value).replace(" ", "T").slice(0, 16) : ""; }
  function sourceLabel(value) { return ({player_code:"Kode",player_geolocation:"GPS fallback",admin_override:"Turneringsleder",legacy:"Legacy"})[value] || value || "—"; }

  async function api(path, { method = "GET", body } = {}) {
    const headers = { Authorization: `Bearer ${token()}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${API_ROOT}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  }

  function ensureCard() {
    if (document.getElementById("tcCheckinCard")) return;
    const registrationGrid = host.querySelector(".tournament-control .tournament-control-grid");
    if (!registrationGrid) return;
    const card = document.createElement("div");
    card.id = "tcCheckinCard";
    card.className = "create-card stack";
    card.innerHTML = `
      <h3>Check-in</h3>
      <p class="muted">Standard er turneringsleder + unik kode i lokalet. Koden vises på Live-skjermen bare mens check-in er åpen.</p>
      <label><span>Metode</span><select id="tcCheckinMethod"><option value="admin_or_code">Turneringsleder + kode (anbefalt)</option><option value="admin_only">Kun turneringsleder</option><option value="code">Kode</option><option value="gps">GPS</option></select></label>
      <div class="tc-two"><label><span>Åpner</span><input id="tcCheckinOpens" type="datetime-local"></label><label><span>Stenger</span><input id="tcCheckinCloses" type="datetime-local"></label></div>
      <div id="tcCheckinCodeBox" class="mini-card"><small class="muted">Kode i lokalet</small><strong id="tcCheckinCode" style="font-size:27px;letter-spacing:.14em">—</strong><button id="tcRotateCode" type="button" class="button secondary">Lag ny kode</button></div>
      <label style="display:flex;align-items:center;gap:8px"><input id="tcGpsFallback" type="checkbox" style="width:auto"><span>Tillat GPS som fallback</span></label>
      <label><span>GPS-radius (meter)</span><input id="tcCheckinRadius" type="number" min="20" max="5000" placeholder="Klubbstandard"></label>
      <div id="tcCheckinEffective" class="muted"></div>
      <button id="tcSaveCheckin" type="button" class="button">Lagre check-in</button>`;
    registrationGrid.appendChild(card);
    document.getElementById("tcSaveCheckin")?.addEventListener("click", save);
    document.getElementById("tcRotateCode")?.addEventListener("click", rotateCode);
    document.getElementById("tcCheckinMethod")?.addEventListener("change", renderCodeVisibility);
  }

  function show(message, tone = "success") {
    const root = document.getElementById("tcMessage");
    if (!root) return;
    root.textContent = message;
    root.className = `message ${tone}`;
  }

  function methodUsesCode(method) { return ["admin_or_code", "code"].includes(String(method)); }
  function renderCodeVisibility() {
    const method = document.getElementById("tcCheckinMethod")?.value || "admin_or_code";
    document.getElementById("tcCheckinCodeBox")?.classList.toggle("hidden", !methodUsesCode(method));
  }

  async function load() {
    ensureCard();
    const id = tournamentId();
    if (!id || !token()) return;
    try {
      const data = await api(`/tournaments/${id}/checkin-settings`);
      currentSettings = data.settings || null;
      if (!currentSettings) return;
      document.getElementById("tcCheckinMethod").value = currentSettings.effective_method || currentSettings.checkin_method || "admin_or_code";
      document.getElementById("tcCheckinOpens").value = localInput(currentSettings.checkin_opens_at);
      document.getElementById("tcCheckinCloses").value = localInput(currentSettings.checkin_closes_at);
      document.getElementById("tcGpsFallback").checked = Number(currentSettings.effective_gps_fallback_enabled || 0) === 1;
      document.getElementById("tcCheckinRadius").value = currentSettings.checkin_radius_meters ?? "";
      document.getElementById("tcCheckinCode").textContent = currentSettings.checkin_code || "Lages ved lagring";
      document.getElementById("tcCheckinEffective").textContent = `Effektivt: ${String(currentSettings.effective_checkin_opens_at).replace(" ", " kl. ")} → ${String(currentSettings.effective_checkin_closes_at).replace(" ", " kl. ")} · ${currentSettings.effective_method || "admin_or_code"}${Number(currentSettings.effective_gps_fallback_enabled) === 1 ? " · GPS fallback" : ""}`;
      renderCodeVisibility();
      decorateRegistrations();
    } catch (error) { show(error.message, "error"); }
  }

  async function save() {
    const id = tournamentId();
    if (!id) return;
    const button = document.getElementById("tcSaveCheckin");
    button.disabled = true;
    try {
      const data = await api(`/tournaments/${id}/checkin-settings`, { method: "PUT", body: {
        checkin_method: document.getElementById("tcCheckinMethod").value,
        checkin_opens_at: document.getElementById("tcCheckinOpens").value || null,
        checkin_closes_at: document.getElementById("tcCheckinCloses").value || null,
        checkin_gps_fallback_enabled: document.getElementById("tcGpsFallback").checked,
        checkin_require_onsite: true,
        checkin_radius_meters: document.getElementById("tcCheckinRadius").value ? Number(document.getElementById("tcCheckinRadius").value) : null,
      }});
      currentSettings = data.settings || null;
      show("Check-in-oppsettet er lagret.");
      await load();
    } catch (error) { show(error.message, "error"); }
    finally { button.disabled = false; }
  }

  async function rotateCode() {
    const id = tournamentId();
    if (!id) return;
    const button = document.getElementById("tcRotateCode");
    if (!window.confirm("Lage ny check-in-kode? Den gamle slutter å virke med en gang.")) return;
    button.disabled = true;
    try {
      const data = await api(`/tournaments/${id}/checkin-code/rotate`, { method: "POST" });
      currentSettings = data.settings || null;
      document.getElementById("tcCheckinCode").textContent = currentSettings?.checkin_code || "—";
      show("Ny check-in-kode er aktiv og vil vises på Live-skjermen i check-in-vinduet.");
    } catch (error) { show(error.message, "error"); }
    finally { button.disabled = false; }
  }

  function decorateRegistrations() {
    const root = document.getElementById("tcRegistrations");
    if (!root) return;
    root.querySelectorAll(".tc-registration").forEach((row) => {
      if (row.querySelector("[data-admin-checkin]")) return;
      const remove = row.querySelector(".tc-remove[data-player-id]");
      const playerId = Number(remove?.dataset.playerId || 0);
      if (!playerId) return;
      const metaText = row.textContent || "";
      if (metaText.includes("checked_in")) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button secondary";
      button.dataset.adminCheckin = String(playerId);
      button.textContent = "Check inn";
      button.addEventListener("click", () => adminCheckin(button));
      remove?.parentNode?.insertBefore(button, remove);
    });
  }

  async function adminCheckin(button) {
    const id = tournamentId();
    const playerId = Number(button.dataset.adminCheckin || 0);
    if (!id || !playerId) return;
    button.disabled = true;
    try {
      const data = await api(`/tournaments/${id}/admin-check-in/${playerId}`, { method: "POST", body: {} });
      show(`Spilleren er checket inn (${sourceLabel(data.registration?.checkin_source)}).`);
      document.getElementById("tcRefresh")?.click();
      window.setTimeout(load, 250);
    } catch (error) {
      show(`${error.message} Normal admin-check-in følger tidsvinduet.`, "error");
      button.disabled = false;
    }
  }

  const observer = new MutationObserver(() => decorateRegistrations());
  const waitForControls = window.setInterval(() => {
    ensureCard();
    const select = document.getElementById("tcTournament");
    const registrations = document.getElementById("tcRegistrations");
    if (!select || !registrations) return;
    clearInterval(waitForControls);
    observer.observe(registrations, { childList: true, subtree: true });
    select.addEventListener("change", () => { clearTimeout(loadTimer); loadTimer = setTimeout(load, 100); });
    document.getElementById("tcRefresh")?.addEventListener("click", () => { clearTimeout(loadTimer); loadTimer = setTimeout(load, 150); });
    load();
  }, 100);
}
