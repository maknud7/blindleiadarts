const API_ROOT = "../api/v1";

const tournamentSelect = document.getElementById("tcTournament");
const saveRegistrationButton = document.getElementById("tcSaveSettings");

if (tournamentSelect && saveRegistrationButton) {
  const wrapper = document.createElement("label");
  wrapper.className = "tc-elo-setting";
  wrapper.innerHTML = `
    <span>ELO-rating</span>
    <span class="checkbox-row">
      <input id="tcEloEnabled" type="checkbox" checked>
      <span>Denne turneringen teller på ELO</span>
    </span>
    <small class="muted">Slå av for trening, generalprøve eller andre urangerte kvelder.</small>
  `;
  saveRegistrationButton.before(wrapper);

  const eloEnabled = document.getElementById("tcEloEnabled");
  const status = document.createElement("small");
  status.className = "muted";
  wrapper.appendChild(status);

  function token() {
    return localStorage.getItem("bd:token") || "";
  }

  async function api(path, { method = "GET", body, auth = false } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth && token()) headers.Authorization = `Bearer ${token()}`;
    const response = await fetch(`${API_ROOT}${path}`, {
      method,
      headers,
      cache: "no-store",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    }
    return payload.data;
  }

  async function loadSetting() {
    const tournamentId = Number(tournamentSelect.value || 0);
    if (!tournamentId) return;
    eloEnabled.disabled = true;
    status.textContent = "Henter ELO-innstilling …";
    try {
      const data = await api(`/tournaments/${tournamentId}/elo-settings`);
      eloEnabled.checked = Boolean(data.tournament?.elo_enabled);
      status.textContent = eloEnabled.checked ? "Rangert turnering" : "Urangert turnering";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      eloEnabled.disabled = false;
    }
  }

  eloEnabled.addEventListener("change", async () => {
    const tournamentId = Number(tournamentSelect.value || 0);
    if (!tournamentId) return;
    const intended = eloEnabled.checked;
    eloEnabled.disabled = true;
    status.textContent = "Lagrer …";
    try {
      const data = await api(`/tournaments/${tournamentId}/elo-settings`, {
        method: "PUT",
        auth: true,
        body: { elo_enabled: intended },
      });
      eloEnabled.checked = Boolean(data.tournament?.elo_enabled);
      status.textContent = eloEnabled.checked ? "Rangert turnering" : "Urangert turnering";
    } catch (error) {
      eloEnabled.checked = !intended;
      status.textContent = error.message;
    } finally {
      eloEnabled.disabled = false;
    }
  });

  tournamentSelect.addEventListener("change", () => setTimeout(loadSetting, 0));
  document.getElementById("tcRefresh")?.addEventListener("click", () => setTimeout(loadSetting, 150));
  setTimeout(loadSetting, 0);
}
