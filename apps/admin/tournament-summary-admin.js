const API_ROOT = "../api/v1";
const host = document.getElementById("tournaments");

if (host) {
  const section = document.createElement("div");
  section.className = "tournament-control tc-summary-admin";
  section.innerHTML = `
    <div class="subsection-head">
      <div>
        <h3>Turneringsoppsummering</h3>
        <p class="muted">Lagre teksten som utkast eller publiser den i spillerportalen.</p>
      </div>
    </div>
    <div id="tsaMessage" class="message hidden"></div>
    <div class="create-card stack">
      <label><span>Turnering</span><select id="tsaTournament"></select></label>
      <label><span>Tittel</span><input id="tsaTitle" maxlength="180" placeholder="Mandagsserien – en kveld med ..."></label>
      <label><span>Oppsummering</span><textarea id="tsaBody" rows="12" placeholder="Skriv eller lim inn oppsummeringen her ..."></textarea></label>
      <label><span>Status</span><select id="tsaStatus"><option value="draft">Utkast</option><option value="published">Publisert</option></select></label>
      <button id="tsaSave" type="button" class="button">Lagre oppsummering</button>
    </div>`;
  host.appendChild(section);

  const el = {
    tournament: document.getElementById("tsaTournament"),
    title: document.getElementById("tsaTitle"),
    body: document.getElementById("tsaBody"),
    status: document.getElementById("tsaStatus"),
    save: document.getElementById("tsaSave"),
    message: document.getElementById("tsaMessage"),
    clubSelect: document.getElementById("clubSelect"),
  };

  function token() { return localStorage.getItem("bd:token") || ""; }
  function clubId() { return Number(localStorage.getItem("bd:selectedClubId") || el.clubSelect?.value || 0); }
  function esc(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }
  function show(message, tone = "info") {
    el.message.textContent = message;
    el.message.className = `message ${tone}`;
  }
  async function api(path, { method = "GET", body } = {}) {
    const headers = { Authorization: `Bearer ${token()}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${API_ROOT}${path}`, { method, headers, cache: "no-store", body: body !== undefined ? JSON.stringify(body) : undefined });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  }

  async function loadTournaments() {
    const id = clubId();
    if (!id || !token()) return;
    const data = await api(`/clubs/${id}/registration-tournaments`);
    const selected = Number(el.tournament.value || 0);
    el.tournament.innerHTML = (data.items || []).map((t) => `<option value="${Number(t.id)}">${esc(t.name)}</option>`).join("");
    if ([...(data.items || [])].some((t) => Number(t.id) === selected)) el.tournament.value = String(selected);
    await loadSummary();
  }

  async function loadSummary() {
    const tournamentId = Number(el.tournament.value || 0);
    if (!tournamentId || !token()) {
      el.title.value = "";
      el.body.value = "";
      el.status.value = "draft";
      return;
    }
    try {
      const data = await api(`/tournaments/${tournamentId}/summary/admin`);
      const summary = data.summary || null;
      el.title.value = summary?.title || "";
      el.body.value = summary?.body_text || "";
      el.status.value = summary?.status || "draft";
    } catch (error) {
      show(error.message, "error");
    }
  }

  el.tournament.addEventListener("change", loadSummary);
  el.save.addEventListener("click", async () => {
    const tournamentId = Number(el.tournament.value || 0);
    if (!tournamentId) return;
    el.save.disabled = true;
    try {
      const data = await api(`/tournaments/${tournamentId}/summary/admin`, {
        method: "PUT",
        body: { title: el.title.value.trim(), body_text: el.body.value.trim(), status: el.status.value },
      });
      show(data.summary?.status === "published" ? "Oppsummeringen er publisert i spillerportalen." : "Oppsummeringen er lagret som utkast.", "success");
    } catch (error) {
      show(error.message, "error");
    } finally {
      el.save.disabled = false;
    }
  });

  el.clubSelect?.addEventListener("change", () => setTimeout(() => loadTournaments().catch((error) => show(error.message, "error")), 0));
  setTimeout(() => loadTournaments().catch(() => {}), 0);
}
