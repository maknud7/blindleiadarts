const API_ROOT = "../api/v1";

const host = document.getElementById("tournaments");
if (host) {
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "./tournament-admin.css";
  document.head.appendChild(css);

  const shell = document.createElement("div");
  shell.className = "tournament-control";
  shell.innerHTML = `
    <div class="subsection-head tournament-control-head">
      <div>
        <h3>Påmelding og gruppeoppsett</h3>
        <p class="muted">Velg turnering, administrer deltakere og trekk puljer tilfeldig eller seedet etter ELO.</p>
      </div>
      <button id="tcRefresh" type="button" class="button secondary">Oppdater</button>
    </div>
    <div id="tcMessage" class="message hidden"></div>
    <div class="tournament-control-grid">
      <div class="create-card stack">
        <label><span>Turnering</span><select id="tcTournament"></select></label>
        <div class="tc-two">
          <label><span>Påmelding åpner</span><input id="tcOpens" type="datetime-local"></label>
          <label><span>Påmelding stenger</span><input id="tcCloses" type="datetime-local"></label>
        </div>
        <label><span>Maks antall spillere</span><input id="tcMaxPlayers" type="number" min="2" placeholder="Ingen grense"></label>
        <button id="tcSaveSettings" type="button" class="button">Lagre påmelding</button>
      </div>

      <div class="create-card stack">
        <h3>Legg til spiller</h3>
        <label><span>Spiller</span><select id="tcPlayer"><option value="">Velg spiller …</option></select></label>
        <button id="tcAddPlayer" type="button" class="button">Legg til</button>
        <div id="tcCounts" class="muted"></div>
      </div>
    </div>

    <div class="tc-panel">
      <div class="subsection-head"><h3>Deltakere</h3><span id="tcRegistrationCount" class="pill">0</span></div>
      <div id="tcRegistrations" class="list"></div>
    </div>

    <div class="tournament-control-grid">
      <div class="create-card stack">
        <h3>Gruppetrekk</h3>
        <div class="tc-two">
          <label><span>Antall grupper</span><input id="tcGroupCount" type="number" min="1" value="1"></label>
          <label><span>Fordeling</span>
            <select id="tcDrawMode">
              <option value="elo_snake">Seedet etter ELO (snake)</option>
              <option value="elo_pots">ELO-potter + tilfeldig trekning</option>
              <option value="random">Helt tilfeldig</option>
            </select>
          </label>
        </div>
        <button id="tcDraw" type="button" class="button">Trekk grupper</button>
        <p class="muted">ELO lagres som snapshot i turneringen. Samme draw seed gjør en tilfeldig trekning reproduserbar.</p>
      </div>

      <div class="create-card stack">
        <h3>Round robin</h3>
        <label><span>Best of legs</span><input id="tcBestOf" type="number" min="1" max="21" step="2" value="3"></label>
        <button id="tcGenerate" type="button" class="button">Generer alle gruppekamper</button>
        <p class="muted">Kampene genereres først når gruppene er låst. Formatet velges eksplisitt her.</p>
      </div>
    </div>

    <div class="tc-panel">
      <div class="subsection-head"><h3>Grupper</h3><span id="tcDrawMeta" class="pill">Ikke trukket</span></div>
      <div id="tcGroups" class="tc-groups"></div>
    </div>
  `;
  host.appendChild(shell);

  const el = Object.fromEntries([
    "tcRefresh", "tcMessage", "tcTournament", "tcOpens", "tcCloses", "tcMaxPlayers",
    "tcSaveSettings", "tcPlayer", "tcAddPlayer", "tcCounts", "tcRegistrationCount",
    "tcRegistrations", "tcGroupCount", "tcDrawMode", "tcDraw", "tcBestOf", "tcGenerate",
    "tcDrawMeta", "tcGroups",
  ].map((id) => [id, document.getElementById(id)]));

  const state = { tournaments: [], players: [], tournament: null, groups: [] };

  function token() { return localStorage.getItem("bd:token") || ""; }
  function clubId() { return Number(localStorage.getItem("bd:selectedClubId") || 0); }
  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }
  function localInput(value) {
    if (!value) return "";
    return String(value).replace(" ", "T").slice(0, 16);
  }
  function show(message, tone = "info") {
    el.tcMessage.textContent = message;
    el.tcMessage.className = `message ${tone}`;
  }
  function hideMessage() {
    el.tcMessage.textContent = "";
    el.tcMessage.className = "message hidden";
  }
  async function api(path, { method = "GET", body, auth = false } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth && token()) headers.Authorization = `Bearer ${token()}`;
    const response = await fetch(`${API_ROOT}${path}`, {
      method, headers, cache: "no-store",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  }

  async function loadBase() {
    const id = clubId();
    if (!id) return;
    const [tournaments, players] = await Promise.all([
      api(`/clubs/${id}/registration-tournaments`),
      api(`/clubs/${id}/players`),
    ]);
    state.tournaments = tournaments.items || [];
    state.players = players.items || [];
    const selected = Number(el.tcTournament.value || 0);
    el.tcTournament.innerHTML = state.tournaments
      .map((t) => `<option value="${Number(t.id)}">${esc(t.name)} · ${esc(t.status)}</option>`).join("");
    if (state.tournaments.some((t) => Number(t.id) === selected)) el.tcTournament.value = String(selected);
    renderPlayerOptions();
    await loadSelectedTournament();
  }

  function renderPlayerOptions() {
    const registeredIds = new Set((state.tournament?.registrations || [])
      .filter((r) => r.status !== "withdrawn")
      .map((r) => Number(r.player_id)));
    el.tcPlayer.innerHTML = `<option value="">Velg spiller …</option>` + state.players
      .filter((player) => !registeredIds.has(Number(player.id)))
      .map((player) => `<option value="${Number(player.id)}">${esc(player.display_name)}</option>`).join("");
  }

  async function loadSelectedTournament() {
    const tournamentId = Number(el.tcTournament.value || 0);
    if (!tournamentId) {
      state.tournament = null;
      state.groups = [];
      render();
      return;
    }
    const [detail, groups] = await Promise.all([
      api(`/tournaments/${tournamentId}`),
      api(`/tournaments/${tournamentId}/groups`),
    ]);
    state.tournament = detail.tournament || null;
    state.groups = groups.groups || [];
    const settings = state.tournaments.find((t) => Number(t.id) === tournamentId) || groups.tournament || {};
    el.tcOpens.value = localInput(settings.registration_opens_at);
    el.tcCloses.value = localInput(settings.registration_closes_at);
    el.tcMaxPlayers.value = settings.max_players || "";
    if (settings.group_count) el.tcGroupCount.value = String(settings.group_count);
    if (settings.group_draw_mode) el.tcDrawMode.value = settings.group_draw_mode;
    renderPlayerOptions();
    render();
  }

  function render() {
    const registrations = state.tournament?.registrations || [];
    const active = registrations.filter((r) => !["withdrawn", "no_show", "eliminated"].includes(String(r.status)));
    const confirmed = active.filter((r) => ["registered", "checked_in"].includes(String(r.status))).length;
    const waitlisted = active.filter((r) => r.status === "waitlisted").length;
    el.tcRegistrationCount.textContent = `${active.length} aktive`;
    el.tcCounts.textContent = `${confirmed} med plass${waitlisted ? ` · ${waitlisted} på venteliste` : ""}`;
    el.tcRegistrations.innerHTML = active.length ? active.map((r) => `
      <article class="list-row tc-registration">
        <div><strong>${esc(r.display_name)}</strong><div class="row-meta"><span>${esc(r.status)}</span>${r.seed ? `<span>Seed ${Number(r.seed)}</span>` : ""}</div></div>
        <button type="button" class="button quiet tc-remove" data-player-id="${Number(r.player_id)}">Fjern</button>
      </article>`).join("") : `<div class="empty">Ingen aktive påmeldinger.</div>`;

    el.tcGroups.innerHTML = state.groups.length ? state.groups.map((group) => `
      <article class="tc-group-card">
        <div class="subsection-head"><h3>${esc(group.name)}</h3><span class="pill">${group.players.length} spillere</span></div>
        <ol>${group.players.map((p) => `<li><span>${esc(p.display_name)}</span><small>Seed ${p.seed_number ?? "—"} · ELO ${p.seed_rating !== null ? Number(p.seed_rating).toFixed(1) : "—"}</small></li>`).join("")}</ol>
      </article>`).join("") : `<div class="empty">Gruppene er ikke trukket ennå.</div>`;

    const firstGroup = state.groups[0];
    el.tcDrawMeta.textContent = firstGroup
      ? `${firstGroup.draw_mode} · seed ${firstGroup.draw_seed}`
      : "Ikke trukket";

    document.querySelectorAll(".tc-remove").forEach((button) => button.addEventListener("click", async () => {
      const tournamentId = Number(el.tcTournament.value || 0);
      button.disabled = true;
      try {
        await api(`/tournaments/${tournamentId}/registrations/${Number(button.dataset.playerId)}`, { method: "DELETE", auth: true });
        show("Spilleren er fjernet. Eventuell ventelistespiller er flyttet opp automatisk.", "success");
        await loadBase();
      } catch (error) {
        show(error.message, "error");
        button.disabled = false;
      }
    }));
  }

  el.tcRefresh.addEventListener("click", () => loadBase().catch((error) => show(error.message, "error")));
  el.tcTournament.addEventListener("change", () => loadSelectedTournament().catch((error) => show(error.message, "error")));

  el.tcSaveSettings.addEventListener("click", async () => {
    const tournamentId = Number(el.tcTournament.value || 0);
    if (!tournamentId) return;
    el.tcSaveSettings.disabled = true;
    try {
      await api(`/tournaments/${tournamentId}/registration-settings`, {
        method: "PUT", auth: true,
        body: {
          registration_opens_at: el.tcOpens.value || null,
          registration_closes_at: el.tcCloses.value || null,
          max_players: el.tcMaxPlayers.value ? Number(el.tcMaxPlayers.value) : null,
        },
      });
      show("Påmeldingsinnstillingene er lagret.", "success");
      await loadBase();
    } catch (error) {
      show(error.message, "error");
    } finally {
      el.tcSaveSettings.disabled = false;
    }
  });

  el.tcAddPlayer.addEventListener("click", async () => {
    const tournamentId = Number(el.tcTournament.value || 0);
    const playerId = Number(el.tcPlayer.value || 0);
    if (!tournamentId || !playerId) return;
    el.tcAddPlayer.disabled = true;
    try {
      const data = await api(`/tournaments/${tournamentId}/registrations`, {
        method: "POST", auth: true, body: { player_id: playerId },
      });
      show(data.registration?.status === "waitlisted" ? "Spilleren er lagt på venteliste." : "Spilleren er meldt på.", "success");
      await loadBase();
    } catch (error) {
      show(error.message, "error");
    } finally {
      el.tcAddPlayer.disabled = false;
    }
  });

  el.tcDraw.addEventListener("click", async () => {
    const tournamentId = Number(el.tcTournament.value || 0);
    const groupCount = Number(el.tcGroupCount.value || 0);
    if (!tournamentId || !groupCount) return;
    el.tcDraw.disabled = true;
    try {
      await api(`/tournaments/${tournamentId}/groups/draw`, {
        method: "POST", auth: true,
        body: { group_count: groupCount, mode: el.tcDrawMode.value },
      });
      show("Gruppene er trukket og ELO-snapshot er lagret.", "success");
      await loadBase();
    } catch (error) {
      show(error.message, "error");
    } finally {
      el.tcDraw.disabled = false;
    }
  });

  el.tcGenerate.addEventListener("click", async () => {
    const tournamentId = Number(el.tcTournament.value || 0);
    const bestOfLegs = Number(el.tcBestOf.value || 0);
    if (!tournamentId || !bestOfLegs) return;
    el.tcGenerate.disabled = true;
    try {
      const data = await api(`/tournaments/${tournamentId}/groups/round-robin`, {
        method: "POST", auth: true, body: { best_of_legs: bestOfLegs },
      });
      show(`${Number(data.created_match_count || 0)} kamper er generert.`, "success");
      await loadBase();
    } catch (error) {
      show(error.message, "error");
    } finally {
      el.tcGenerate.disabled = false;
    }
  });

  document.getElementById("clubSelect")?.addEventListener("change", () => {
    setTimeout(() => loadBase().catch((error) => show(error.message, "error")), 0);
  });

  hideMessage();
  loadBase().catch((error) => show(error.message, "error"));
}
