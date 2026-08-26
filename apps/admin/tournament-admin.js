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
      <div><p class="eyebrow">Turneringsrom</p><h3>Gjennomfør kvelden i riktig rekkefølge</h3><p class="muted">Påmelding → innsjekk → velg format → start. Først når turneringen startes blir deltakerfeltet låst.</p></div>
      <button id="tcRefresh" type="button" class="button secondary">Oppdater</button>
    </div>
    <div id="tcMessage" class="message hidden"></div>

    <div class="tournament-control-grid">
      <div class="create-card stack">
        <label><span>Turnering</span><select id="tcTournament"></select></label>
        <div id="tcFlowStatus" class="mini-card"></div>
      </div>
      <div class="create-card stack">
        <h3>Legg til spiller</h3>
        <p class="muted">Turneringsleder kan legge til en spiller manuelt fram til turneringen starter.</p>
        <label><span>Spiller</span><select id="tcPlayer"><option value="">Velg spiller …</option></select></label>
        <button id="tcAddPlayer" type="button" class="button">Legg til</button>
      </div>
    </div>

    <div class="tc-panel">
      <div class="subsection-head"><div><h3>Deltakere</h3><p id="tcCounts" class="muted"></p></div><span id="tcRegistrationCount" class="pill">0</span></div>
      <div id="tcRegistrations" class="list"></div>
    </div>

    <div id="tcFormatCard" class="create-card stack">
      <div class="subsection-head"><div><p class="eyebrow">Når oppmøtet er klart</p><h3>Velg format</h3><p class="muted">Forslaget justeres etter hvor mange som faktisk er sjekket inn.</p></div><span id="tcFormatBadge" class="pill">Venter på innsjekk</span></div>
      <div id="tcRecommendation" class="mini-card"></div>
      <div class="tournament-control-grid compact-grid">
        <label><span>Antall grupper</span><input id="tcGroupCount" type="number" min="1" max="32" value="1"></label>
        <label><span>Trekkemetode</span><select id="tcDrawMode"><option value="elo_snake">ELO-seedet snake</option><option value="elo_pots">ELO-potter + tilfeldig</option><option value="random">Helt tilfeldig</option></select></label>
        <label><span>Gruppespill · best of</span><input id="tcBestOf" type="number" min="1" max="21" step="2" value="3"></label>
        <label><span>Videre per gruppe</span><input id="tcQualifiers" type="number" min="1" max="16" value="2"></label>
        <label><span>Sluttspill · best of</span><input id="tcPlayoffBestOf" type="number" min="1" max="21" step="2" value="3"></label>
      </div>
      <div id="tcStartWarning" class="mini-card"></div>
      <button id="tcStart" type="button" class="button">Start turnering</button>
    </div>

    <div class="tc-panel">
      <div class="subsection-head"><h3>Grupper</h3><span id="tcDrawMeta" class="pill">Ikke trukket</span></div>
      <div id="tcGroups" class="tc-groups"></div>
    </div>`;
  host.appendChild(shell);

  const ids = ["tcRefresh","tcMessage","tcTournament","tcFlowStatus","tcPlayer","tcAddPlayer","tcCounts","tcRegistrationCount","tcRegistrations","tcFormatCard","tcFormatBadge","tcRecommendation","tcGroupCount","tcDrawMode","tcBestOf","tcQualifiers","tcPlayoffBestOf","tcStartWarning","tcStart","tcDrawMeta","tcGroups"];
  const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  const state = { tournaments: [], players: [], tournament: null, groups: [], plan: null, formatTouched: false };

  function token() { return localStorage.getItem("bd:token") || ""; }
  function clubId() { return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0); }
  function esc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
  function statusLabel(status) { return ({draft:"Planlagt",ready:"Klar",in_progress:"Pågår",completed:"Ferdig",registered:"Påmeldt",checked_in:"Sjekket inn",waitlisted:"Venteliste",no_show:"Ikke møtt",withdrawn:"Meldt av",paused:"Pause"})[status] || status || "—"; }
  function formatDate(value) { if (!value) return "—"; const d = new Date(String(value).replace(" ", "T")); return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat("nb-NO", { weekday:"short", day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" }).format(d); }
  function show(message, tone = "info") { el.tcMessage.textContent = message; el.tcMessage.className = `message ${tone}`; }
  function hideMessage() { el.tcMessage.textContent = ""; el.tcMessage.className = "message hidden"; }
  function odd(value) { const n = Number(value); return Number.isInteger(n) && n >= 1 && n <= 21 && n % 2 === 1; }
  async function api(path, { method = "GET", body, auth = false } = {}) {
    const headers = {};
    if (auth && token()) headers.Authorization = `Bearer ${token()}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${API_ROOT}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  }

  function checkedInRegistrations() { return (state.tournament?.registrations || []).filter((r) => String(r.status) === "checked_in"); }
  function activeRegistrations() { return (state.tournament?.registrations || []).filter((r) => ["registered","checked_in","waitlisted","paused"].includes(String(r.status))); }
  function recommendedGroups(count) { return Math.max(1, Math.ceil(Math.max(1, count) / 6)); }

  async function loadBase() {
    const id = clubId();
    if (!id) return;
    const [tournaments, players] = await Promise.all([api(`/clubs/${id}/registration-tournaments`), api(`/clubs/${id}/players`)]);
    state.tournaments = tournaments.items || [];
    state.players = players.items || [];
    const selected = Number(el.tcTournament.value || 0);
    el.tcTournament.innerHTML = state.tournaments.map((t) => `<option value="${Number(t.id)}">${esc(t.name)} · ${esc(statusLabel(t.status))}</option>`).join("");
    if (state.tournaments.some((t) => Number(t.id) === selected)) el.tcTournament.value = String(selected);
    await loadSelectedTournament();
  }

  async function loadSelectedTournament() {
    const tournamentId = Number(el.tcTournament.value || 0);
    state.formatTouched = false;
    if (!tournamentId) { state.tournament = null; state.groups = []; state.plan = null; render(); return; }
    const [detail, groups, plan] = await Promise.all([
      api(`/tournaments/${tournamentId}`),
      api(`/tournaments/${tournamentId}/groups`),
      api(`/tournaments/${tournamentId}/wizard-plan`, { auth: true }).catch(() => ({ plan: null })),
    ]);
    state.tournament = detail.tournament || null;
    state.groups = groups.groups || [];
    state.plan = plan.plan || null;
    const checked = checkedInRegistrations().length;
    el.tcGroupCount.value = String(state.groups.length || state.plan?.group_count || recommendedGroups(checked));
    el.tcDrawMode.value = state.groups[0]?.draw_mode || state.plan?.group_draw_mode || "elo_snake";
    el.tcBestOf.value = String(state.plan?.group_best_of_legs || 3);
    el.tcQualifiers.value = String(state.plan?.qualifiers_per_group || 2);
    el.tcPlayoffBestOf.value = String(state.plan?.playoff_best_of_legs || 3);
    renderPlayerOptions();
    render();
  }

  function renderPlayerOptions() {
    const used = new Set(activeRegistrations().map((r) => Number(r.player_id)));
    el.tcPlayer.innerHTML = `<option value="">Velg spiller …</option>` + state.players.filter((p) => !used.has(Number(p.id))).map((p) => `<option value="${Number(p.id)}">${esc(p.display_name)}</option>`).join("");
  }

  function render() {
    const tournament = state.tournament || {};
    const all = tournament.registrations || [];
    const active = activeRegistrations();
    const checked = checkedInRegistrations();
    const waiting = active.filter((r) => String(r.status) === "waitlisted");
    const noShows = all.filter((r) => String(r.status) === "no_show");
    const started = String(tournament.status) === "in_progress";
    const locked = started || ["completed","archived"].includes(String(tournament.status));
    const settings = state.tournaments.find((t) => Number(t.id) === Number(tournament.id)) || {};

    el.tcFlowStatus.innerHTML = tournament.id ? `<strong>${esc(statusLabel(tournament.status))}</strong><p class="muted">${esc(formatDate(tournament.start_at))}</p><p class="muted">${settings.registration_state === "not_open" ? `Påmelding åpner ${formatDate(settings.registration_opens_at)}` : settings.registration_state === "closed" ? "Påmelding stengt" : "Påmelding åpen fram til turneringen startes"}</p>` : `<p class="muted">Ingen turnering valgt.</p>`;
    el.tcCounts.textContent = `${active.length} aktive påmeldinger · ${checked.length} sjekket inn${waiting.length ? ` · ${waiting.length} på venteliste` : ""}${noShows.length ? ` · ${noShows.length} ikke møtt` : ""}`;
    el.tcRegistrationCount.textContent = `${checked.length} klare`;

    el.tcRegistrations.innerHTML = active.length ? active.map((r) => `
      <article class="list-row tc-registration" data-status="${esc(r.status)}">
        <div><strong>${esc(r.display_name)}</strong><div class="row-meta"><span>${esc(statusLabel(r.status))}</span><span class="hidden">${esc(r.status)}</span>${r.seed ? `<span>Seed ${Number(r.seed)}</span>` : ""}</div></div>
        ${locked ? "" : `<button type="button" class="button quiet tc-remove" data-player-id="${Number(r.player_id)}">Fjern</button>`}
      </article>`).join("") : `<div class="empty">Ingen aktive påmeldinger.</div>`;

    el.tcGroups.innerHTML = state.groups.length ? state.groups.map((group) => `<article class="tc-group-card"><div class="subsection-head"><h3>${esc(group.name)}</h3><span class="pill">${group.players.length} spillere</span></div><ol>${group.players.map((p) => `<li><span>${esc(p.display_name)}</span><small>Seed ${p.seed_number ?? "—"} · ELO ${p.seed_rating !== null ? Number(p.seed_rating).toFixed(1) : "—"}</small></li>`).join("")}</ol></article>`).join("") : `<div class="empty">Gruppene trekkes først når turneringen startes.</div>`;
    el.tcDrawMeta.textContent = state.groups[0] ? `${state.groups[0].draw_mode} · seed ${state.groups[0].draw_seed}` : "Ikke trukket";

    const recommendation = recommendedGroups(checked.length);
    if (!state.formatTouched && !state.groups.length && !started) el.tcGroupCount.value = String(recommendation);
    const sizes = checked.length ? Array.from({ length: recommendation }, (_, i) => Math.floor(checked.length / recommendation) + (i < checked.length % recommendation ? 1 : 0)).join(" + ") : "—";
    el.tcFormatBadge.textContent = checked.length ? `${checked.length} sjekket inn` : "Venter på innsjekk";
    el.tcRecommendation.innerHTML = checked.length >= 2 ? `<strong>Anbefalt: ${recommendation} ${recommendation === 1 ? "gruppe" : "grupper"} → sluttspill</strong><p class="muted">Med ${checked.length} spillere blir fordelingen ${sizes}. Standard er ELO-seedet trekning og Best of 3.</p>` : `<strong>Check inn spillerne først</strong><p class="muted">Når minst to er sjekket inn kan formatet ferdigstilles.</p>`;
    el.tcStartWarning.innerHTML = started
      ? `<strong>Turneringen er i gang</strong><p class="muted">Deltakerfeltet er låst. ${noShows.length} påmeldte falt ut fordi de ikke var sjekket inn ved start.</p>`
      : `<strong>${checked.length} spillere blir med</strong><p class="muted">Når du starter, blir alle påmeldte som ikke er sjekket inn markert som «ikke møtt» og faller ut. Påmeldingen stenger samtidig.</p>`;
    el.tcStart.textContent = started ? "Turneringen er startet" : "Start turnering";
    el.tcStart.disabled = locked || checked.length < 2;
    [el.tcPlayer, el.tcAddPlayer].forEach((node) => { if (node) node.disabled = locked; });
    [el.tcGroupCount, el.tcDrawMode, el.tcBestOf, el.tcQualifiers, el.tcPlayoffBestOf].forEach((node) => { if (node) node.disabled = started || state.groups.length > 0; });

    document.querySelectorAll(".tc-remove").forEach((button) => button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api(`/tournaments/${Number(tournament.id)}/registrations/${Number(button.dataset.playerId)}`, { method: "DELETE", auth: true });
        show("Spilleren er fjernet fra turneringen.", "success");
        await loadBase();
      } catch (error) { show(error.message, "error"); button.disabled = false; }
    }));
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
    } catch (error) {
      show(`${error.message} Hvis start allerede ble registrert, kan turneringsrommet oppdateres og oppsettet fullføres derfra.`, "error");
      await loadBase().catch(() => undefined);
    } finally {
      el.tcStart.textContent = "Start turnering";
    }
  }

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
      await loadBase();
    } catch (error) { show(error.message, "error"); }
    finally { el.tcAddPlayer.disabled = false; }
  });
  [el.tcGroupCount, el.tcDrawMode, el.tcBestOf, el.tcQualifiers, el.tcPlayoffBestOf].forEach((node) => node?.addEventListener("change", () => { state.formatTouched = true; }));
  el.tcStart.addEventListener("click", startTournament);
  document.getElementById("clubSelect")?.addEventListener("change", () => setTimeout(() => loadBase().catch((e) => show(e.message, "error")), 0));

  hideMessage();
  loadBase().catch((error) => show(error.message, "error"));
}
