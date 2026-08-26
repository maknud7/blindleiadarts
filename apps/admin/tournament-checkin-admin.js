const API_ROOT = "../api/v1";
const host = document.getElementById("tournaments");

if (host) {
  let currentSettings = null;
  let loadTimer = null;

  function token() { return localStorage.getItem("bd:token") || ""; }
  function tournamentId() { return Number(document.getElementById("tcTournament")?.value || 0); }
  function localInput(value) { return value ? String(value).replace(" ", "T").slice(0, 16) : ""; }
  function methodLabel(value) { return ({admin_or_code:"Turneringsleder + kode",admin_only:"Kun turneringsleder",code:"Kun kode"})[value] || value || "—"; }

  async function api(path, { method = "GET", body } = {}) {
    const headers = { Authorization: `Bearer ${token()}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${API_ROOT}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  }

  function ensureCard() {
    if (document.getElementById("tcCheckinSettings")) return true;
    const settingsHost = document.getElementById("tcCheckinSettingsHost");
    if (!settingsHost) return false;
    settingsHost.innerHTML = `
      <details id="tcCheckinSettings" class="tc-disclosure tc-checkin-settings">
        <summary><span>Innsjekk</span><small id="tcCheckinSummary">Klubbstandard</small></summary>
        <div class="tc-disclosure-body stack">
          <label><span>Metode</span><select id="tcCheckinMethod"><option value="admin_or_code">Turneringsleder + kode</option><option value="admin_only">Kun turneringsleder</option><option value="code">Kun kode</option></select></label>
          <label><span>Innsjekk åpner</span><input id="tcCheckinOpens" type="datetime-local"></label>
          <div id="tcCheckinCodeBox" class="tc-code-box"><div><small class="muted">Innsjekk-kode</small><strong id="tcCheckinCode">—</strong></div><button id="tcRotateCode" type="button" class="button secondary">Ny kode</button></div>
          <button id="tcSaveCheckin" type="button" class="button secondary">Lagre</button>
        </div>
      </details>`;
    document.getElementById("tcSaveCheckin")?.addEventListener("click", save);
    document.getElementById("tcRotateCode")?.addEventListener("click", rotateCode);
    document.getElementById("tcCheckinMethod")?.addEventListener("change", renderCodeVisibility);
    return true;
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
    if (!ensureCard()) return;
    const id = tournamentId();
    if (!id || !token()) return;
    try {
      const data = await api(`/tournaments/${id}/checkin-settings`);
      currentSettings = data.settings || null;
      if (!currentSettings) return;
      const method = currentSettings.effective_method || currentSettings.checkin_method || "admin_or_code";
      document.getElementById("tcCheckinMethod").value = method;
      document.getElementById("tcCheckinOpens").value = localInput(currentSettings.checkin_opens_at);
      document.getElementById("tcCheckinCode").textContent = currentSettings.checkin_code || "Lages ved behov";
      document.getElementById("tcCheckinSummary").textContent = methodUsesCode(method) && currentSettings.checkin_code
        ? `${methodLabel(method)} · ${currentSettings.checkin_code}`
        : methodLabel(method);
      renderCodeVisibility();
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
      }});
      currentSettings = data.settings || null;
      show("Innsjekk er oppdatert.");
      await load();
    } catch (error) { show(error.message, "error"); }
    finally { button.disabled = false; }
  }

  async function rotateCode() {
    const id = tournamentId();
    if (!id) return;
    const button = document.getElementById("tcRotateCode");
    button.disabled = true;
    try {
      const data = await api(`/tournaments/${id}/checkin-code/rotate`, { method: "POST" });
      currentSettings = data.settings || null;
      show("Ny innsjekk-kode er klar.");
      await load();
    } catch (error) { show(error.message, "error"); }
    finally { button.disabled = false; }
  }

  const waitForControls = window.setInterval(() => {
    if (!ensureCard()) return;
    const select = document.getElementById("tcTournament");
    if (!select) return;
    window.clearInterval(waitForControls);
    select.addEventListener("change", () => { clearTimeout(loadTimer); loadTimer = setTimeout(load, 100); });
    document.getElementById("tcRefresh")?.addEventListener("click", () => { clearTimeout(loadTimer); loadTimer = setTimeout(load, 150); });
    load();
  }, 100);
}
