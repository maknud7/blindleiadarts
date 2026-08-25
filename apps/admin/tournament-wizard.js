const API_ROOT = "../api/v1";
const host = document.getElementById("tournaments");

if (host) {
  const state = { step: 0, checkinDefaults: null, creating: false };

  function token() { return localStorage.getItem("bd:token") || ""; }
  function clubId() { return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0); }
  function esc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
  function localInput(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    const pad = (v) => String(v).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function parseLocal(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date; }

  async function api(path, { method = "GET", body, auth = true } = {}) {
    const headers = {};
    if (auth && token()) headers.Authorization = `Bearer ${token()}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${API_ROOT}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  }

  function installStyles() {
    if (document.getElementById("tournamentWizardStyles")) return;
    const style = document.createElement("style");
    style.id = "tournamentWizardStyles";
    style.textContent = `
      .tw-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.76);display:grid;place-items:center;padding:16px;z-index:1200}.tw-backdrop.hidden{display:none}.tw-dialog{width:min(780px,100%);max-height:94vh;overflow:auto;background:#0e151e;border:1px solid var(--line);border-radius:20px;box-shadow:0 24px 90px rgba(0,0,0,.55)}.tw-head{padding:20px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:16px;align-items:start}.tw-head h2{margin:3px 0}.tw-close{border:0;background:transparent;color:var(--muted);font-size:26px;cursor:pointer}.tw-progress{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line)}.tw-progress span{padding:9px 8px;background:#111821;text-align:center;font-size:12px;color:var(--muted)}.tw-progress span.active{color:var(--text);font-weight:800;background:rgba(77,212,166,.1)}.tw-body{padding:20px}.tw-step{display:none;gap:14px}.tw-step.active{display:grid}.tw-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.tw-grid .wide{grid-column:1/-1}.tw-dialog label{display:grid;gap:6px;color:var(--muted);font-size:13px}.tw-dialog input,.tw-dialog select{width:100%;box-sizing:border-box}.tw-check{display:flex!important;align-items:center;gap:9px!important}.tw-check input{width:auto!important}.tw-help{padding:12px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.025)}.tw-actions{padding:16px 20px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:10px}.tw-actions>div{display:flex;gap:8px}.tw-message{margin:0 20px 16px;padding:10px 12px;border-radius:10px;border:1px solid var(--line)}.tw-message.bad{border-color:rgba(255,107,107,.5)}.tw-message.good{border-color:rgba(77,212,166,.45)}.tw-summary{display:grid;gap:9px}.tw-summary div{display:flex;justify-content:space-between;gap:14px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.06)}@media(max-width:650px){.tw-grid{grid-template-columns:1fr}.tw-grid .wide{grid-column:auto}.tw-progress span{font-size:10px}.tw-actions{align-items:stretch}.tw-actions>div{display:grid}}`;
    document.head.appendChild(style);
  }

  function installButton() {
    const head = host.querySelector(":scope > .panel-head");
    if (!head || document.getElementById("twOpen")) return;
    const button = document.createElement("button");
    button.id = "twOpen";
    button.type = "button";
    button.className = "button";
    button.textContent = "+ Ny turnering – veiviser";
    head.appendChild(button);
    button.addEventListener("click", open);
  }

  function installDialog() {
    if (document.getElementById("twBackdrop")) return;
    const root = document.createElement("div");
    root.id = "twBackdrop";
    root.className = "tw-backdrop hidden";
    root.innerHTML = `
      <section class="tw-dialog" role="dialog" aria-modal="true" aria-labelledby="twTitle">
        <div class="tw-head"><div><p class="eyebrow">Turneringsveiviser</p><h2 id="twTitle">Ny turnering</h2><p class="muted">Fire steg. Du kan finjustere alt i de vanlige adminverktøyene etterpå.</p></div><button id="twClose" class="tw-close" type="button">×</button></div>
        <div id="twProgress" class="tw-progress"><span>1 · Grunnlag</span><span>2 · Påmelding</span><span>3 · Check-in</span><span>4 · Format</span></div>
        <form id="twForm">
          <div class="tw-body">
            <section class="tw-step" data-step="0">
              <div class="tw-grid">
                <label class="wide"><span>Navn</span><input id="twName" required maxlength="180" placeholder="Mandagsserien 31. august"></label>
                <label><span>Start</span><input id="twStart" type="datetime-local" required></label>
                <label><span>Planlagt slutt (valgfritt)</span><input id="twEnd" type="datetime-local"></label>
              </div>
              <div class="tw-help"><strong>Canonical fra første sekund</strong><p class="muted">Veiviseren lager en lokal Blindleia-turnering. Ingen ekstern plattform eier kampene.</p></div>
            </section>

            <section class="tw-step" data-step="1">
              <div class="tw-grid">
                <label><span>Påmelding åpner</span><input id="twRegOpen" type="datetime-local"></label>
                <label><span>Påmelding stenger</span><input id="twRegClose" type="datetime-local"></label>
                <label><span>Maks spillere</span><input id="twMax" type="number" min="2" placeholder="Ingen grense"></label>
              </div>
              <div class="tw-help"><strong>Venteliste er automatisk</strong><p class="muted">Når maks antall er nådd, går nye påmeldinger på venteliste. Ved avmelding flyttes neste spiller opp.</p></div>
            </section>

            <section class="tw-step" data-step="2">
              <div class="tw-grid">
                <label class="check-row wide"><input id="twUseCheckinDefaults" type="checkbox" checked><span>Bruk klubbens standard for arena-checkin</span></label>
                <label><span>Check-in åpner</span><input id="twCheckinOpen" type="datetime-local"></label>
                <label><span>Check-in stenger</span><input id="twCheckinClose" type="datetime-local"></label>
                <label class="tw-check wide"><input id="twOnsite" type="checkbox" checked><span>Krev at spillerens telefon er fysisk ved arenaen</span></label>
                <label><span>Radius (meter)</span><input id="twRadius" type="number" min="20" max="5000" value="150"></label>
              </div>
              <div id="twCheckinInfo" class="tw-help"></div>
            </section>

            <section class="tw-step" data-step="3">
              <div class="tw-grid">
                <label><span>Planlagte grupper</span><input id="twGroups" type="number" min="1" max="32" value="4"></label>
                <label><span>Trekkemetode</span><select id="twDrawMode"><option value="elo_snake">ELO-seedet snake</option><option value="elo_pots">ELO-potter + tilfeldig</option><option value="random">Helt tilfeldig</option></select></label>
                <label><span>Gruppespill · best of</span><input id="twGroupBestOf" type="number" min="1" max="21" step="2" value="3"></label>
                <label><span>Videre per gruppe</span><input id="twQualifiers" type="number" min="1" max="16" value="2"></label>
                <label><span>Sluttspill · best of</span><input id="twPlayoffBestOf" type="number" min="1" max="21" step="2" value="3"></label>
              </div>
              <div class="tw-help"><strong>Vi trekker ikke gruppene nå</strong><p class="muted">Formatplanen lagres, men selve gruppetrekningen gjøres først når deltakerne er klare/checket inn. Det hindrer at en tidlig trekning låser feil spillere.</p></div>
              <div id="twSummary" class="tw-summary"></div>
            </section>
          </div>
          <div id="twMessage" class="tw-message hidden"></div>
          <div class="tw-actions"><button id="twPrev" type="button" class="button secondary">Tilbake</button><div><button id="twCancel" type="button" class="button quiet">Avbryt</button><button id="twNext" type="button" class="button">Neste</button><button id="twCreate" type="submit" class="button hidden">Opprett turnering</button></div></div>
        </form>
      </section>`;
    document.body.appendChild(root);
    root.addEventListener("click", (event) => { if (event.target === root) close(); });
    document.getElementById("twClose").addEventListener("click", close);
    document.getElementById("twCancel").addEventListener("click", close);
    document.getElementById("twPrev").addEventListener("click", () => go(state.step - 1));
    document.getElementById("twNext").addEventListener("click", () => { if (validateStep()) go(state.step + 1); });
    document.getElementById("twForm").addEventListener("submit", createTournament);
    document.getElementById("twStart").addEventListener("change", seedWindowsFromStart);
    document.getElementById("twUseCheckinDefaults").addEventListener("change", applyCheckinDefaultVisibility);
    ["twName","twStart","twMax","twGroups","twDrawMode","twGroupBestOf","twQualifiers","twPlayoffBestOf"].forEach((id) => document.getElementById(id)?.addEventListener("input", renderSummary));
  }

  function show(message, tone = "bad") {
    const el = document.getElementById("twMessage");
    el.textContent = message;
    el.className = `tw-message ${tone}`;
  }
  function hideMessage() { const el = document.getElementById("twMessage"); el.textContent = ""; el.className = "tw-message hidden"; }

  async function open() {
    state.step = 0;
    state.creating = false;
    document.getElementById("twForm").reset();
    document.getElementById("twUseCheckinDefaults").checked = true;
    document.getElementById("twOnsite").checked = true;
    document.getElementById("twGroups").value = "4";
    document.getElementById("twGroupBestOf").value = "3";
    document.getElementById("twQualifiers").value = "2";
    document.getElementById("twPlayoffBestOf").value = "3";
    document.getElementById("twDrawMode").value = "elo_snake";
    const nextMonday = new Date();
    nextMonday.setSeconds(0, 0);
    nextMonday.setDate(nextMonday.getDate() + ((8 - nextMonday.getDay()) % 7 || 7));
    nextMonday.setHours(18, 30, 0, 0);
    document.getElementById("twStart").value = localInput(nextMonday);
    seedWindowsFromStart();
    hideMessage();
    try {
      const data = await api(`/clubs/${clubId()}/checkin-settings`);
      state.checkinDefaults = data.settings || null;
    } catch {
      state.checkinDefaults = null;
    }
    applyCheckinDefaultsToForm();
    go(0);
    document.getElementById("twBackdrop").classList.remove("hidden");
    document.getElementById("twName").focus();
  }

  function close() { if (!state.creating) document.getElementById("twBackdrop")?.classList.add("hidden"); }

  function seedWindowsFromStart() {
    const start = parseLocal(document.getElementById("twStart").value);
    if (!start) return;
    const regOpen = new Date(Math.min(Date.now(), start.getTime() - 14 * 24 * 3600 * 1000));
    const regClose = new Date(start.getTime() - 30 * 60 * 1000);
    const before = Number(state.checkinDefaults?.opens_minutes_before_start ?? 60);
    const after = Number(state.checkinDefaults?.closes_minutes_after_start ?? 10);
    document.getElementById("twRegOpen").value = localInput(regOpen);
    document.getElementById("twRegClose").value = localInput(regClose);
    document.getElementById("twCheckinOpen").value = localInput(new Date(start.getTime() - before * 60000));
    document.getElementById("twCheckinClose").value = localInput(new Date(start.getTime() + after * 60000));
    renderSummary();
  }

  function applyCheckinDefaultsToForm() {
    const s = state.checkinDefaults;
    if (s) {
      document.getElementById("twRadius").value = Number(s.onsite_radius_meters || 150);
      document.getElementById("twOnsite").checked = Number(s.require_geolocation ?? 1) === 1;
    }
    seedWindowsFromStart();
    applyCheckinDefaultVisibility();
  }

  function applyCheckinDefaultVisibility() {
    const inherited = document.getElementById("twUseCheckinDefaults").checked;
    ["twCheckinOpen","twCheckinClose","twOnsite","twRadius"].forEach((id) => { document.getElementById(id).disabled = inherited; });
    const s = state.checkinDefaults;
    document.getElementById("twCheckinInfo").innerHTML = inherited
      ? `<strong>Klubbstandard</strong><p class="muted">${s ? `Åpner ${Number(s.opens_minutes_before_start)} min før start, stenger ${Number(s.closes_minutes_after_start)} min etter. ${Number(s.require_geolocation) === 1 ? `On-site innen ${Number(s.onsite_radius_meters)} m.` : "Geolokasjon er ikke påkrevd."}` : "Klubbstandard lastes fra admin. Hvis arena-posisjonen mangler, vil spillerne bli bedt om å kontakte arrangør."}</p>`
      : `<strong>Egen regel for denne turneringen</strong><p class="muted">Disse verdiene overstyrer klubbstandarden bare for denne turneringen.</p>`;
  }

  function go(step) {
    state.step = Math.min(3, Math.max(0, step));
    document.querySelectorAll(".tw-step").forEach((node) => node.classList.toggle("active", Number(node.dataset.step) === state.step));
    document.querySelectorAll("#twProgress span").forEach((node, i) => node.classList.toggle("active", i === state.step));
    document.getElementById("twPrev").disabled = state.step === 0;
    document.getElementById("twNext").classList.toggle("hidden", state.step === 3);
    document.getElementById("twCreate").classList.toggle("hidden", state.step !== 3);
    hideMessage();
    if (state.step === 3) renderSummary();
  }

  function odd(value) { const n = Number(value); return Number.isInteger(n) && n >= 1 && n <= 21 && n % 2 === 1; }

  function validateStep() {
    if (state.step === 0) {
      if (!document.getElementById("twName").value.trim()) { show("Gi turneringen et navn."); return false; }
      const start = parseLocal(document.getElementById("twStart").value);
      if (!start) { show("Sett gyldig starttid."); return false; }
      const end = parseLocal(document.getElementById("twEnd").value);
      if (end && end <= start) { show("Planlagt slutt må være etter start."); return false; }
    }
    if (state.step === 1) {
      const start = parseLocal(document.getElementById("twStart").value);
      const open = parseLocal(document.getElementById("twRegOpen").value);
      const closeTime = parseLocal(document.getElementById("twRegClose").value);
      if (open && closeTime && open >= closeTime) { show("Påmelding må stenge etter at den åpner."); return false; }
      if (start && closeTime && closeTime > start) { show("Påmelding bør stenge senest ved turneringsstart."); return false; }
    }
    if (state.step === 2 && !document.getElementById("twUseCheckinDefaults").checked) {
      const open = parseLocal(document.getElementById("twCheckinOpen").value);
      const closeTime = parseLocal(document.getElementById("twCheckinClose").value);
      if (!open || !closeTime || open >= closeTime) { show("Sett et gyldig check-in-vindu."); return false; }
    }
    if (state.step === 3) {
      if (Number(document.getElementById("twGroups").value) < 1) { show("Sett minst én gruppe."); return false; }
      if (!odd(document.getElementById("twGroupBestOf").value) || !odd(document.getElementById("twPlayoffBestOf").value)) { show("Best of må være oddetall mellom 1 og 21."); return false; }
      if (Number(document.getElementById("twQualifiers").value) < 1) { show("Minst én spiller må gå videre fra hver gruppe."); return false; }
    }
    return true;
  }

  function renderSummary() {
    const root = document.getElementById("twSummary");
    if (!root) return;
    const name = document.getElementById("twName")?.value.trim() || "Ny turnering";
    const groups = Number(document.getElementById("twGroups")?.value || 1);
    const qualifiers = Number(document.getElementById("twQualifiers")?.value || 2);
    const draw = document.getElementById("twDrawMode")?.selectedOptions?.[0]?.textContent || "ELO-seedet";
    root.innerHTML = `<div><span>Turnering</span><strong>${esc(name)}</strong></div><div><span>Gruppespill</span><strong>${groups} grupper · Bo${Number(document.getElementById("twGroupBestOf")?.value || 3)}</strong></div><div><span>Trekk</span><strong>${esc(draw)}</strong></div><div><span>Sluttspillplan</span><strong>Topp ${qualifiers} per gruppe · Bo${Number(document.getElementById("twPlayoffBestOf")?.value || 3)}</strong></div>`;
  }

  async function createTournament(event) {
    event.preventDefault();
    if (!validateStep() || state.creating) return;
    state.creating = true;
    const createButton = document.getElementById("twCreate");
    createButton.disabled = true;
    createButton.textContent = "Oppretter …";
    hideMessage();
    let tournamentId = 0;
    try {
      const base = await api(`/clubs/${clubId()}/tournaments`, {
        method: "POST",
        body: {
          name: document.getElementById("twName").value.trim(),
          start_at: document.getElementById("twStart").value || null,
          end_at: document.getElementById("twEnd").value || null,
          provider_system: "local",
          status: "draft",
        },
      });
      tournamentId = Number(base.tournament?.id || 0);
      if (!tournamentId) throw new Error("Turneringen ble opprettet uten gyldig ID.");

      await api(`/tournaments/${tournamentId}/registration-settings`, {
        method: "PUT",
        body: {
          registration_opens_at: document.getElementById("twRegOpen").value || null,
          registration_closes_at: document.getElementById("twRegClose").value || null,
          max_players: document.getElementById("twMax").value ? Number(document.getElementById("twMax").value) : null,
        },
      });

      if (!document.getElementById("twUseCheckinDefaults").checked) {
        await api(`/tournaments/${tournamentId}/checkin-settings`, {
          method: "PUT",
          body: {
            checkin_opens_at: document.getElementById("twCheckinOpen").value || null,
            checkin_closes_at: document.getElementById("twCheckinClose").value || null,
            checkin_require_onsite: document.getElementById("twOnsite").checked,
            checkin_radius_meters: Number(document.getElementById("twRadius").value || 150),
          },
        });
      }

      await api(`/tournaments/${tournamentId}/wizard-plan`, {
        method: "PUT",
        body: {
          group_count: Number(document.getElementById("twGroups").value || 1),
          group_draw_mode: document.getElementById("twDrawMode").value,
          group_best_of_legs: Number(document.getElementById("twGroupBestOf").value || 3),
          qualifiers_per_group: Number(document.getElementById("twQualifiers").value || 2),
          playoff_best_of_legs: Number(document.getElementById("twPlayoffBestOf").value || 3),
        },
      });

      show("Turneringen er opprettet. Formatplanen er lagret, men gruppene trekkes først når deltakerne er klare.", "good");
      window.setTimeout(() => {
        state.creating = false;
        document.getElementById("twBackdrop").classList.add("hidden");
        document.getElementById("refreshAllButton")?.click();
        document.getElementById("tcRefresh")?.click();
        document.getElementById("poRefresh")?.click();
      }, 900);
    } catch (error) {
      const suffix = tournamentId ? ` Turneringen fikk ID ${tournamentId}, men et senere veivisersteg feilet; den kan repareres i admin.` : "";
      show(error.message + suffix, "bad");
      state.creating = false;
    } finally {
      createButton.disabled = false;
      createButton.textContent = "Opprett turnering";
    }
  }

  async function applyPlanToExistingControls(tournamentId) {
    if (!tournamentId || !token()) return;
    try {
      const data = await api(`/tournaments/${tournamentId}/wizard-plan`);
      const plan = data.plan || {};
      const tcGroups = document.getElementById("tcGroupCount");
      const tcMode = document.getElementById("tcDrawMode");
      const tcBest = document.getElementById("tcBestOf");
      if (tcGroups && !plan.groups_already_drawn) tcGroups.value = String(plan.group_count || 1);
      if (tcMode && !plan.groups_already_drawn) tcMode.value = plan.group_draw_mode || "elo_snake";
      if (tcBest) tcBest.value = String(plan.group_best_of_legs || 3);
      const poQ = document.getElementById("poQualifiers");
      const poBest = document.getElementById("poBestOf");
      if (poQ) poQ.value = String(plan.qualifiers_per_group || 2);
      if (poBest) poBest.value = String(plan.playoff_best_of_legs || 3);
    } catch {
      // Existing/legacy tournaments can be administered without a wizard plan.
    }
  }

  installStyles();
  installButton();
  installDialog();
  document.getElementById("tcTournament")?.addEventListener("change", (event) => window.setTimeout(() => applyPlanToExistingControls(Number(event.target.value || 0)), 80));
  document.getElementById("poTournament")?.addEventListener("change", (event) => window.setTimeout(() => applyPlanToExistingControls(Number(event.target.value || 0)), 80));
  window.setTimeout(() => {
    const selected = Number(document.getElementById("tcTournament")?.value || document.getElementById("poTournament")?.value || 0);
    if (selected) applyPlanToExistingControls(selected);
  }, 800);
}
