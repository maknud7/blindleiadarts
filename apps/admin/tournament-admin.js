const API_ROOT = "../api/v1";
const host = document.getElementById("tournaments");

if (host) {
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "./tournament-admin.css";
  document.head.appendChild(css);
  host.classList.add("tc-room-active");

  const shell = document.createElement("div");
  shell.className = "tournament-control tc-workspace";
  shell.innerHTML = `
    <div class="tc-room-head">
      <div>
        <p class="eyebrow">Turneringsrom</p>
        <h3>Én oppgave om gangen</h3>
        <p class="muted">Turneringsrommet viser det som er relevant i fasen du jobber i.</p>
      </div>
      <div class="tc-room-actions">
        <button id="tcBrowse" type="button" class="button quiet">Vis alle turneringer</button>
        <button id="tcRefresh" type="button" class="button secondary">Oppdater</button>
      </div>
    </div>

    <div class="tc-context-card">
      <label class="tc-tournament-picker"><span>Turnering</span><select id="tcTournament"></select></label>
      <div id="tcFlowStatus" class="tc-flow-status"></div>
    </div>

    <nav id="tcPhaseNav" class="tc-phase-nav" aria-label="Turneringsfase">
      <button type="button" data-tc-view="checkin"><span>1</span><b>Innsjekk</b><small id="tcNavCheckinMeta">—</small></button>
      <button type="button" data-tc-view="format"><span>2</span><b>Format & start</b><small id="tcNavFormatMeta">—</small></button>
      <button type="button" data-tc-view="live"><span>3</span><b>Drift</b><small id="tcNavLiveMeta">—</small></button>
      <button type="button" data-tc-view="after"><span>4</span><b>Etterpå</b><small id="tcNavAfterMeta">—</small></button>
    </nav>

    <div id="tcMessage" class="message hidden"></div>

    <section id="tcStageCheckin" class="tc-stage" data-stage="checkin">
      <div class="tc-stage-head">
        <div>
          <p class="eyebrow">Akkurat nå</p>
          <h3>Hvem er faktisk her?</h3>
          <p id="tcCounts" class="muted"></p>
        </div>
        <div class="tc-stage-count"><strong id="tcRegistrationCount">0</strong><span>klare</span></div>
      </div>

      <div id="tcCheckinProgress" class="tc-checkin-progress"></div>

      <div class="tc-filterbar" role="group" aria-label="Filtrer deltakere">
        <button type="button" data-tc-filter="pending" class="active">Mangler innsjekk <span id="tcPendingCount">0</span></button>
        <button type="button" data-tc-filter="checked">Sjekket inn <span id="tcCheckedCount">0</span></button>
        <button type="button" data-tc-filter="all">Alle <span id="tcAllCount">0</span></button>
      </div>

      <div id="tcRegistrations" class="list tc-registration-list"></div>

      <div class="tc-primary-next">
        <div><strong id="tcNextTitle">Check inn spillerne</strong><p id="tcNextText" class="muted"></p></div>
        <button id="tcToFormat" type="button" class="button">Gå videre til format</button>
      </div>

      <details class="tc-disclosure">
        <summary>Legg til spiller manuelt</summary>
        <div class="tc-disclosure-body">
          <p class="muted">Bruk dette bare når noen ikke har meldt seg på selv.</p>
          <div class="tc-inline-form">
            <label><span>Spiller</span><select id="tcPlayer"><option value="">Velg spiller …</option></select></label>
            <button id="tcAddPlayer" type="button" class="button secondary">Legg til</button>
          </div>
        </div>
      </details>

      <div id="tcCheckinSettingsHost"></div>
    </section>

    <section id="tcStageFormat" class="tc-stage hidden" data-stage="format">
      <div class="tc-stage-head">
        <div><p class="eyebrow">Neste steg</p><h3>Velg format og start</h3><p class="muted">Nå bruker vi bare spillerne som faktisk er sjekket inn.</p></div>
        <span id="tcFormatBadge" class="pill">Venter på innsjekk</span>
      </div>

      <div id="tcRecommendation" class="tc-recommendation"></div>

      <details id="tcFormatAdvanced" class="tc-disclosure">
        <summary>Tilpass format</summary>
        <div class="tc-disclosure-body">
          <div class="tournament-control-grid compact-grid">
            <label><span>Antall grupper</span><input id="tcGroupCount" type="number" min="1" max="32" value="1"></label>
            <label><span>Trekkemetode</span><select id="tcDrawMode"><option value="elo_snake">ELO-seedet snake</option><option value="elo_pots">ELO-potter + tilfeldig</option><option value="random">Helt tilfeldig</option></select></label>
            <label><span>Gruppespill · best of</span><input id="tcBestOf" type="number" min="1" max="21" step="2" value="3"></label>
            <label><span>Videre per gruppe</span><input id="tcQualifiers" type="number" min="1" max="16" value="2"></label>
            <label><span>Sluttspill · best of</span><input id="tcPlayoffBestOf" type="number" min="1" max="21" step="2" value="3"></label>
          </div>
        </div>
      </details>

      <div id="tcStartWarning" class="tc-start-warning"></div>
      <button id="tcStart" type="button" class="button tc-start-button">Start turnering</button>
    </section>

    <section id="tcStageLive" class="tc-stage hidden" data-stage="live">
      <div class="tc-stage-head"><div><p class="eyebrow">Turneringen pågår</p><h3>Grupper og kampflyt</h3><p class="muted">Boards og kampkø vises i driftsvisningen under.</p></div><span id="tcDrawMeta" class="pill">Ikke trukket</span></div>
      <div id="tcGroups" class="tc-groups"></div>
    </section>

    <section id="tcStageAfter" class="tc-stage hidden" data-stage="after">
      <div class="tc-stage-head"><div><p class="eyebrow">Etter turneringen</p><h3>Sluttspill, resultat og oppsummering</h3><p class="muted">Verktøyene for avslutning og publisering vises under når denne fasen er valgt.</p></div></div>
    </section>`;
  host.appendChild(shell);

  const ids = [
    "tcBrowse","tcRefresh","tcMessage","tcTournament","tcFlowStatus","tcNavCheckinMeta","tcNavFormatMeta","tcNavLiveMeta","tcNavAfterMeta",
    "tcStageCheckin","tcCounts","tcRegistrationCount","tcCheckinProgress","tcPendingCount","tcCheckedCount","tcAllCount","tcRegistrations","tcNextTitle","tcNextText","tcToFormat","tcPlayer","tcAddPlayer",
    "tcStageFormat","tcFormatBadge","tcRecommendation","tcFormatAdvanced","tcGroupCount","tcDrawMode","tcBestOf","tcQualifiers","tcPlayoffBestOf","tcStartWarning","tcStart",
    "tcStageLive","tcDrawMeta","tcGroups","tcStageAfter",
  ];
  const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  const state = { tournaments: [], players: [], tournament: null, groups: [], plan: null, formatTouched: false, view: "checkin", filter: "pending", selectionVersion: 0 };

  function token() { return localStorage.getItem("bd:token") || ""; }
  function clubId() { return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0); }
  function esc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
  function statusLabel(status) { return ({draft:"Planlagt",ready:"Klar",in_progress:"Pågår",completed:"Ferdig",registered:"Påmeldt",checked_in:"Sjekket inn",waitlisted:"Venteliste",no_show:"Ikke møtt",withdrawn:"Meldt av",paused:"Pause"})[status] || status || "—"; }
  function formatDate(value) { if (!value) return "—"; const d = new Date(String(value).replace(" ", "T")); return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat("nb-NO", { weekday:"short", day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" }).format(d); }
  function show(message, tone = "info") { el.tcMessage.textContent = message; el.tcMessage.className = `message ${tone}`; }
  function hideMessage() { el.tcMessage.textContent = ""; el.tcMessage.className = "message hidden"; }
  function odd(value) { const n = Number(value); return Number.isInteger(n) && n >= 1 && n <= 21 && n % 2 === 1; }

  async function api(path, { method = "GET", body, auth = false, timeoutMs = 0 } = {}) {
    const headers = {};
    if (auth && token()) headers.Authorization = `Bearer ${token()}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetch(`${API_ROOT}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: controller?.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        const error = new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
        error.code = payload?.error?.code || "request_failed";
        throw error;
      }
      return payload.data;
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeoutError = new Error("Turneringsdata bruker for lang tid på å svare. Du kan fortsette i turneringsrommet og prøve Oppdater igjen.");
        timeoutError.code = "request_timeout";
        throw timeoutError;
      }
      throw error;
    } finally {
      if (timer) window.clearTimeout(timer);
    }
  }

  function checkedInRegistrations() { return (state.tournament?.registrations || []).filter((r) => String(r.status) === "checked_in"); }
  function activeRegistrations() { return (state.tournament?.registrations || []).filter((r) => ["registered","checked_in","waitlisted","paused"].includes(String(r.status))); }
  function recommendedGroups(count) { return Math.max(1, Math.ceil(Math.max(1, count) / 6)); }
  function defaultView(tournament) {
    const status = String(tournament?.status || "");
    if (["completed","archived"].includes(status)) return "after";
    if (status === "in_progress") return "live";
    return "checkin";
  }

  function publishContext() {
    const context = {
      id: Number(state.tournament?.id || 0),
      status: String(state.tournament?.status || ""),
      view: state.view,
      clubId: clubId(),
    };
    window.__bdTournamentContext = context;
    window.dispatchEvent(new CustomEvent("bd:tournament-context", { detail: context }));
  }

  function setView(view, { focus = false } = {}) {
    state.view = ["checkin","format","live","after"].includes(view) ? view : "checkin";
    document.querySelectorAll("[data-stage]").forEach((section) => section.classList.toggle("hidden", section.dataset.stage !== state.view));
    document.querySelectorAll("[data-tc-view]").forEach((button) => button.classList.toggle("active", button.dataset.tcView === state.view));
    publishContext();
    if (focus) shell.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function applyFormatDefaults() {
    const checked = checkedInRegistrations().length;
    el.tcGroupCount.value = String(state.groups.length || state.plan?.group_count || recommendedGroups(checked));
    el.tcDrawMode.value = state.groups[0]?.draw_mode || state.plan?.group_draw_mode || "elo_snake";
    el.tcBestOf.value = String(state.plan?.group_best_of_legs || 3);
    el.tcQualifiers.value = String(state.plan?.qualifiers_per_group || 2);
    el.tcPlayoffBestOf.value = String(state.plan?.playoff_best_of_legs || 3);
  }

  async function loadBase() {
    const id = clubId();
    if (!id) return;
    const tournaments = await api(`/clubs/${id}/registration-tournaments`, { timeoutMs: 10000 });
    state.tournaments = tournaments.items || [];
    const selected = Number(el.tcTournament.value || 0);
    el.tcTournament.innerHTML = state.tournaments.map((t) => `<option value="${Number(t.id)}">${esc(t.name)} · ${esc(statusLabel(t.status))}</option>`).join("");
    if (state.tournaments.some((t) => Number(t.id) === selected)) el.tcTournament.value = String(selected);

    const selectedLoad = loadSelectedTournament();
    api(`/clubs/${id}/players`, { timeoutMs: 10000 }).then((players) => {
      if (id !== clubId()) return;
      state.players = players.items || [];
      renderPlayerOptions();
    }).catch((error) => console.warn("Spillerlisten kunne ikke lastes sammen med turneringsrommet", error));
    await selectedLoad;
  }

  async function loadSelectedTournament() {
    const tournamentId = Number(el.tcTournament.value || 0);
    const selectionVersion = ++state.selectionVersion;
    state.formatTouched = false;
    state.filter = "pending";
    if (!tournamentId) {
      state.tournament = null;
      state.groups = [];
      state.plan = null;
      state.view = "checkin";
      render();
      return;
    }

    // The list endpoint already knows enough to show the correct tournament phase.
    // Render that immediately so a slow detail/group query can never leave the room
    // stuck in the default check-in state or hold the canonical loader open.
    const summary = state.tournaments.find((item) => Number(item.id) === tournamentId) || null;
    if (summary) {
      state.tournament = { ...summary, registrations: [] };
      state.groups = [];
      state.plan = null;
      state.view = defaultView(state.tournament);
      applyFormatDefaults();
      renderPlayerOptions();
      render();
    }

    let detail;
    try {
      detail = await api(`/tournaments/${tournamentId}`, { timeoutMs: 12000 });
    } catch (error) {
      if (selectionVersion === state.selectionVersion) show(error.message, "error");
      return;
    }
    if (selectionVersion !== state.selectionVersion) return;

    state.tournament = detail.tournament || summary || null;
    state.groups = [];
    state.plan = null;
    state.view = defaultView(state.tournament);
    applyFormatDefaults();
    renderPlayerOptions();
    render();

    // Groups and wizard settings improve the room, but they are secondary data.
    // Never block the selected tournament on them; merge them in when available.
    Promise.allSettled([
      api(`/tournaments/${tournamentId}/groups`, { timeoutMs: 7000 }),
      api(`/tournaments/${tournamentId}/wizard-plan`, { auth: true, timeoutMs: 7000 }),
    ]).then(([groupsResult, planResult]) => {
      if (selectionVersion !== state.selectionVersion) return;
      if (groupsResult.status === "fulfilled") state.groups = groupsResult.value.groups || [];
      else console.warn("Gruppedata kunne ikke lastes uten å blokkere turneringsrommet", groupsResult.reason);
      if (planResult.status === "fulfilled") state.plan = planResult.value.plan || null;
      else console.warn("Turneringsplan kunne ikke lastes uten å blokkere turneringsrommet", planResult.reason);
      applyFormatDefaults();
      renderPlayerOptions();
      render();
    });
  }

  function renderPlayerOptions() {
    const used = new Set(activeRegistrations().map((r) => Number(r.player_id)));
    el.tcPlayer.innerHTML = `<option value="">Velg spiller …</option>` + state.players.filter((p) => !used.has(Number(p.id))).map((p) => `<option value="${Number(p.id)}">${esc(p.display_name)}</option>`).join("");
  }

  function registrationActions(registration, locked) {
    const playerId = Number(registration.player_id);
    const status = String(registration.status || "");
    if (locked) return `<span class="badge ${status === "checked_in" ? "good" : "neutral"}">${esc(statusLabel(status))}</span>`;
    if (status === "registered") {
      return `<div class="tc-row-actions"><button type="button" class="button tc-checkin" data-player-id="${playerId}">Sjekk inn</button><button type="button" class="button quiet tc-remove" data-player-id="${playerId}">Fjern</button></div>`;
    }
    if (status === "checked_in") {
      return `<div class="tc-row-actions"><span class="badge good">✓ Klar</span><button type="button" class="button quiet tc-remove" data-player-id="${playerId}">Fjern</button></div>`;
    }
    return `<div class="tc-row-actions"><span class="badge neutral">${esc(statusLabel(status))}</span><button type="button" class="button quiet tc-remove" data-player-id="${playerId}">Fjern</button></div>`;
  }

  function renderRegistrations(active, locked) {
    const checked = active.filter((r) => String(r.status) === "checked_in");
    const pending = active.filter((r) => String(r.status) === "registered");
    const shown = state.filter === "checked" ? checked : state.filter === "pending" ? pending : active;
    el.tcPendingCount.textContent = String(pending.length);
    el.tcCheckedCount.textContent = String(checked.length);
    el.tcAllCount.textContent = String(active.length);
    document.querySelectorAll("[data-tc-filter]").forEach((button) => button.classList.toggle("active", button.dataset.tcFilter === state.filter));

    if (!shown.length) {
      const copy = state.filter === "pending" ? "Ingen mangler innsjekk." : state.filter === "checked" ? "Ingen er sjekket inn ennå." : "Ingen aktive påmeldinger.";
      el.tcRegistrations.innerHTML = `<div class="empty tc-compact-empty">${copy}</div>`;
      return;
    }

    el.tcRegistrations.innerHTML = shown.map((r) => `
      <article class="list-row tc-registration ${String(r.status) === "checked_in" ? "is-checked" : ""}" data-status="${esc(r.status)}" data-player-id="${Number(r.player_id)}">
        <div class="tc-player-main">
          <strong>${esc(r.display_name)}</strong>
          <div class="row-meta"><span>${esc(statusLabel(r.status))}</span>${r.nickname ? `<span>${esc(r.nickname)}</span>` : ""}${r.seed ? `<span>Seed ${Number(r.seed)}</span>` : ""}</div>
        </div>
        ${registrationActions(r, locked)}
      </article>`).join("");
  }

  function render() {
    const tournament = state.tournament || {};
    const all = tournament.registrations || [];
    const active = activeRegistrations();
    const checked = checkedInRegistrations();
    const registered = active.filter((r) => String(r.status) === "registered");
    const waiting = active.filter((r) => String(r.status) === "waitlisted");
    const noShows = all.filter((r) => String(r.status) === "no_show");
    const started = String(tournament.status) === "in_progress";
    const completed = ["completed","archived"].includes(String(tournament.status));
    const locked = started || completed;
    const settings = state.tournaments.find((t) => Number(t.id) === Number(tournament.id)) || {};

    el.tcFlowStatus.innerHTML = tournament.id ? `
      <div><span class="badge ${started ? "good" : completed ? "neutral" : "warning"}">${esc(statusLabel(tournament.status))}</span><strong>${esc(formatDate(tournament.start_at))}</strong></div>
      <div class="tc-flow-metrics"><span><b>${active.length}</b> påmeldt</span><span><b>${checked.length}</b> sjekket inn</span>${waiting.length ? `<span><b>${waiting.length}</b> venteliste</span>` : ""}</div>
      <p class="muted">${settings.registration_state === "not_open" ? `Påmelding åpner ${esc(formatDate(settings.registration_opens_at))}` : settings.registration_state === "closed" ? "Påmelding stengt" : "Påmelding åpen fram til turneringen startes"}</p>`
      : `<p class="muted">Ingen turnering valgt.</p>`;

    el.tcCounts.textContent = `${active.length} påmeldte · ${checked.length} sjekket inn${waiting.length ? ` · ${waiting.length} på venteliste` : ""}`;
    el.tcRegistrationCount.textContent = String(checked.length);
    el.tcCheckinProgress.innerHTML = `<div><span style="width:${active.length ? Math.round((checked.length / Math.max(1, active.length - waiting.length)) * 100) : 0}%"></span></div><p class="muted">${registered.length ? `${registered.length} spiller${registered.length === 1 ? "" : "e"} mangler innsjekk` : checked.length ? "Alle med bekreftet plass er sjekket inn" : "Venter på innsjekk"}</p>`;
    renderRegistrations(active, locked);

    const recommendation = recommendedGroups(checked.length);
    if (!state.formatTouched && !state.groups.length && !started) el.tcGroupCount.value = String(recommendation);
    const sizes = checked.length ? Array.from({ length: recommendation }, (_, i) => Math.floor(checked.length / recommendation) + (i < checked.length % recommendation ? 1 : 0)).join(" + ") : "—";

    el.tcFormatBadge.textContent = checked.length ? `${checked.length} sjekket inn` : "Venter på innsjekk";
    el.tcRecommendation.innerHTML = checked.length >= 2
      ? `<div class="tc-recommendation-icon">✓</div><div><p class="eyebrow">Anbefalt</p><strong>${recommendation} ${recommendation === 1 ? "gruppe" : "grupper"} → sluttspill</strong><p class="muted">${checked.length} spillere gir ${sizes}. ELO-seedet trekning og Best of 3 brukes som standard.</p></div>`
      : `<div class="tc-recommendation-icon">…</div><div><strong>Check inn minst to spillere først</strong><p class="muted">Formatet foreslås automatisk når vi vet hvem som faktisk møter.</p></div>`;

    el.tcNextTitle.textContent = registered.length ? `${registered.length} mangler innsjekk` : checked.length >= 2 ? "Oppmøtet ser klart ut" : "Check inn spillerne";
    el.tcNextText.textContent = checked.length >= 2 ? `${checked.length} spillere er klare. Du kan gå videre og velge format når du vil.` : "Du trenger minst to innsjekkede spillere før turneringen kan startes.";
    el.tcToFormat.disabled = locked || checked.length < 2;

    el.tcStartWarning.innerHTML = started
      ? `<strong>Turneringen er i gang</strong><p class="muted">Deltakerfeltet er låst. ${noShows.length} påmeldte falt ut fordi de ikke var sjekket inn ved start.</p>`
      : `<strong>${checked.length} spillere blir med</strong><p class="muted">Ved start stenges påmeldingen. ${registered.length ? `${registered.length} påmeldte som ikke er sjekket inn blir markert som «ikke møtt».` : "Alle med bekreftet plass er sjekket inn."}</p>`;
    el.tcStart.textContent = started ? "Turneringen er startet" : completed ? "Turneringen er ferdig" : `Start turnering med ${checked.length} spillere`;
    el.tcStart.disabled = locked || checked.length < 2;

    el.tcGroups.innerHTML = state.groups.length
      ? state.groups.map((group) => `<article class="tc-group-card"><div class="subsection-head"><h3>${esc(group.name)}</h3><span class="pill">${group.players.length} spillere</span></div><ol>${group.players.map((p) => `<li><span>${esc(p.display_name)}</span><small>Seed ${p.seed_number ?? "—"} · ELO ${p.seed_rating !== null ? Number(p.seed_rating).toFixed(1) : "—"}</small></li>`).join("")}</ol></article>`).join("")
      : `<div class="empty">Gruppene trekkes når turneringen startes.</div>`;
    el.tcDrawMeta.textContent = state.groups[0] ? `${state.groups[0].draw_mode} · seed ${state.groups[0].draw_seed}` : "Ikke trukket";

    el.tcNavCheckinMeta.textContent = locked ? `${checked.length} deltakere` : `${checked.length}/${Math.max(0, active.length - waiting.length)} klare`;
    el.tcNavFormatMeta.textContent = started || completed ? "Låst" : checked.length >= 2 ? "Klar" : "Venter";
    el.tcNavLiveMeta.textContent = started ? "Pågår" : completed ? "Ferdig" : "Ikke startet";
    el.tcNavAfterMeta.textContent = completed ? "Klar" : started ? "Senere" : "Ikke ennå";

    [el.tcPlayer, el.tcAddPlayer].forEach((node) => { if (node) node.disabled = locked; });
    [el.tcGroupCount, el.tcDrawMode, el.tcBestOf, el.tcQualifiers, el.tcPlayoffBestOf].forEach((node) => { if (node) node.disabled = started || state.groups.length > 0 || completed; });
    document.querySelector('[data-tc-view="live"]')?.toggleAttribute("disabled", !started && !completed);
    document.querySelector('[data-tc-view="after"]')?.toggleAttribute("disabled", !started && !completed);

    document.querySelectorAll(".tc-remove").forEach((button) => button.addEventListener("click", () => removePlayer(button)));
    document.querySelectorAll(".tc-checkin").forEach((button) => button.addEventListener("click", () => adminCheckin(button)));
    setView(state.view);
  }

  async function adminCheckin(button) {
    const tournamentId = Number(state.tournament?.id || 0);
    const playerId = Number(button.dataset.playerId || 0);
    if (!tournamentId || !playerId) return;
    button.disabled = true;
    button.textContent = "Sjekker inn …";
    try {
      await api(`/tournaments/${tournamentId}/admin-check-in/${playerId}`, { method: "POST", auth: true, body: {} });
      show("Spilleren er sjekket inn.", "success");
      await loadSelectedTournament();
    } catch (error) {
      if (["checkin_not_open","checkin_closed"].includes(error.code) && window.confirm(`${error.message} Vil du sjekke inn spilleren manuelt likevel?`)) {
        try {
          await api(`/tournaments/${tournamentId}/admin-check-in/${playerId}`, { method: "POST", auth: true, body: { force: true } });
          show("Spilleren er sjekket inn manuelt.", "success");
          await loadSelectedTournament();
          return;
        } catch (forcedError) {
          show(forcedError.message, "error");
        }
      } else {
        show(error.message, "error");
      }
      button.disabled = false;
      button.textContent = "Sjekk inn";
    }
  }

  async function removePlayer(button) {
    const tournamentId = Number(state.tournament?.id || 0);
    const playerId = Number(button.dataset.playerId || 0);
    if (!tournamentId || !playerId) return;
    button.disabled = true;
    try {
      await api(`/tournaments/${tournamentId}/registrations/${playerId}`, { method: "DELETE", auth: true });
      show("Spilleren er fjernet fra turneringen.", "success");
      await loadSelectedTournament();
    } catch (error) {
      show(error.message, "error");
      button.disabled = false;
    }
  }

  async function startTournament() {
    const id = Number(state.tournament?.id || 0);
    const checked = checkedInRegistrations().length;
    if (!id || checked < 2) return;
    const groupCount = Number(el.tcGroupCount.value || 0);
    const groupBestOf = Number(el.tcBestOf.value || 0);
    const playoffBestOf = Number(el.tcPlayoffBestOf.value || 0);
    if (groupCount < 1 || groupCount > checked) return show("Antall grupper kan ikke være større enn antall innsjekkede spillere.", "error");
    if (!odd(groupBestOf) || !odd(playoffBestOf)) return show("Best of må være et oddetall mellom 1 og 21.", "error");
    if (!window.confirm(`Starte turneringen med ${checked} innsjekkede spillere? De som ikke er sjekket inn faller ut, og påmeldingen stenges.`)) return;

    el.tcStart.disabled = true;
    el.tcStart.textContent = "Starter …";
    try {
      await api(`/tournaments/${id}/wizard-plan`, { method: "PUT", auth: true, body: {
        group_count: groupCount,
        group_draw_mode: el.tcDrawMode.value,
        group_best_of_legs: groupBestOf,
        qualifiers_per_group: Number(el.tcQualifiers.value || 2),
        playoff_best_of_legs: playoffBestOf,
      }});
      const started = await api(`/tournaments/${id}/start`, { method: "POST", auth: true });
      await api(`/tournaments/${id}/groups/draw`, { method: "POST", auth: true, body: { group_count: groupCount, mode: el.tcDrawMode.value } });
      const generated = await api(`/tournaments/${id}/groups/round-robin`, { method: "POST", auth: true, body: { best_of_legs: groupBestOf } });
      const noShows = Number(started.start?.no_show_count || 0);
      show(`Turneringen er i gang med ${checked} spillere. ${noShows ? `${noShows} ikke-innsjekkede falt ut. ` : ""}${Number(generated.created_match_count || 0)} gruppekamper er opprettet.`, "success");
      await loadBase();
      state.view = "live";
      render();
    } catch (error) {
      show(`${error.message} Hvis start allerede ble registrert, kan du oppdatere turneringsrommet og fortsette derfra.`, "error");
      await loadBase().catch(() => undefined);
    }
  }

  el.tcBrowse.addEventListener("click", () => {
    const showing = host.classList.toggle("tc-show-overview");
    el.tcBrowse.textContent = showing ? "Skjul oversikten" : "Vis alle turneringer";
  });
  el.tcRefresh.addEventListener("click", () => loadBase().catch((e) => show(e.message, "error")));
  el.tcTournament.addEventListener("change", () => loadSelectedTournament().catch((e) => show(e.message, "error")));
  el.tcAddPlayer.addEventListener("click", async () => {
    const tournamentId = Number(state.tournament?.id || 0);
    const playerId = Number(el.tcPlayer.value || 0);
    if (!tournamentId || !playerId) return;
    el.tcAddPlayer.disabled = true;
    try {
      const data = await api(`/tournaments/${tournamentId}/registrations`, { method: "POST", auth: true, body: { player_id: playerId } });
      show(data.registration?.status === "waitlisted" ? "Spilleren er lagt på venteliste." : "Spilleren er meldt på.", "success");
      await loadSelectedTournament();
    } catch (error) { show(error.message, "error"); }
    finally { el.tcAddPlayer.disabled = false; }
  });
  document.querySelectorAll("[data-tc-filter]").forEach((button) => button.addEventListener("click", () => { state.filter = button.dataset.tcFilter || "pending"; render(); }));
  document.querySelectorAll("[data-tc-view]").forEach((button) => button.addEventListener("click", () => { if (!button.disabled) setView(button.dataset.tcView || "checkin", { focus: true }); }));
  el.tcToFormat.addEventListener("click", () => setView("format", { focus: true }));
  [el.tcGroupCount, el.tcDrawMode, el.tcBestOf, el.tcQualifiers, el.tcPlayoffBestOf].forEach((node) => node?.addEventListener("change", () => { state.formatTouched = true; }));
  el.tcStart.addEventListener("click", startTournament);
  document.getElementById("clubSelect")?.addEventListener("change", () => setTimeout(() => loadBase().catch((e) => show(e.message, "error")), 0));

  hideMessage();
  loadBase().catch((error) => show(error.message, "error"));
}