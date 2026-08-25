const API_ROOT = "../api/v1";
const host = document.getElementById("tournaments");

if (host) {
  let currentSettings = null;
  let loadTimer = null;

  function token() { return localStorage.getItem("bd:token") || ""; }
  function tournamentId() { return Number(document.getElementById("tcTournament")?.value || 0); }
  function esc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
  function localInput(value) { return value ? String(value).replace(" ", "T").slice(0, 16) : ""; }

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
      <h3>Arena-checkin</h3>
      <p class="muted">Klubbstandarden brukes hvis feltene under står tomme. Admin kan alltid checke inn en spiller manuelt ved GPS-/sen ankomst-problemer.</p>
      <div class="tc-two"><label><span>Åpner</span><input id="tcCheckinOpens" type="datetime-local"></label><label><span>Stenger</span><input id="tcCheckinCloses" type="datetime-local"></label></div>
      <label style="display:flex;align-items:center;gap:8px"><input id="tcCheckinOnsite" type="checkbox" style="width:auto"><span>Krev on-site</span></label>
      <label><span>Radius (meter)</span><input id="tcCheckinRadius" type="number" min="20" max="5000" placeholder="Klubbstandard"></label>
      <div id="tcCheckinEffective" class="muted"></div>
      <button id="tcSaveCheckin" type="button" class="button">Lagre check-in</button>`;
    registrationGrid.appendChild(card);
    document.getElementById("tcSaveCheckin")?.addEventListener("click", save);
  }

  function show(message, tone = "success") {
    const root = document.getElementById("tcMessage");
    if (!root) return;
    root.textContent = message;
    root.className = `message ${tone}`;
  }

  async function load() {
    ensureCard();
    const id = tournamentId();
    if (!id || !token()) return;
    try {
      const data = await api(`/tournaments/${id}/checkin-settings`);
      currentSettings = data.settings || null;
      if (!currentSettings) return;
      document.getElementById("tcCheckinOpens").value = localInput(currentSettings.checkin_opens_at);
      document.getElementById("tcCheckinCloses").value = localInput(currentSettings.checkin_closes_at);
      document.getElementById("tcCheckinOnsite").checked = Number(currentSettings.effective_require_onsite || 0) === 1;
      document.getElementById("tcCheckinRadius").value = currentSettings.checkin_radius_meters ?? "";
      document.getElementById("tcCheckinEffective").textContent = `Effektivt: ${String(currentSettings.effective_checkin_opens_at).replace(" ", " kl. ")} → ${String(currentSettings.effective_checkin_closes_at).replace(" ", " kl. ")} · ${Number(currentSettings.effective_require_onsite) === 1 ? `on-site ${Number(currentSettings.effective_radius_meters)} m` : "uten geolokasjon"}`;
      decorateRegistrations();
    } catch (error) {
      show(error.message, "error");
    }
  }

  async function save() {
    const id = tournamentId();
    if (!id) return;
    const button = document.getElementById("tcSaveCheckin");
    button.disabled = true;
    try {
      await api(`/tournaments/${id}/checkin-settings`, { method: "PUT", body: {
        checkin_opens_at: document.getElementById("tcCheckinOpens").value || null,
        checkin_closes_at: document.getElementById("tcCheckinCloses").value || null,
        checkin_require_onsite: document.getElementById("tcCheckinOnsite").checked,
        checkin_radius_meters: document.getElementById("tcCheckinRadius").value ? Number(document.getElementById("tcCheckinRadius").value) : null,
      }});
      show("Check-in-reglene er lagret.");
      await load();
    } catch (error) {
      show(error.message, "error");
    } finally {
      button.disabled = false;
    }
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
      button.textContent = "Check inn manuelt";
      button.addEventListener("click", () => adminCheckin(button));
      remove?.parentNode?.insertBefore(button, remove);
    });
  }

  async function adminCheckin(button) {
    const id = tournamentId();
    const playerId = Number(button.dataset.adminCheckin || 0);
    if (!id || !playerId) return;
    if (!window.confirm("Checke inn spilleren manuelt? Dette overstyrer tidsvindu og on-site-krav og blir logget som admin_override.")) return;
    button.disabled = true;
    try {
      await api(`/tournaments/${id}/admin-check-in/${playerId}`, { method: "POST" });
      show("Spilleren er checket inn med admin-overstyring.");
      document.getElementById("tcRefresh")?.click();
      window.setTimeout(load, 200);
    } catch (error) {
      show(error.message, "error");
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
