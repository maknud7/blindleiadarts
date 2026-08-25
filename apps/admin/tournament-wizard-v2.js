const API_ROOT = "../api/v1";
const host = document.getElementById("tournaments");

if (host) {
  const state = { step: 0, creating: false, seasons: [], checkinMethod: "admin_or_code" };

  function token() { return localStorage.getItem("bd:token") || ""; }
  function clubId() { return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0); }
  function esc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
  function localInput(date) { if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ""; const pad=(v)=>String(v).padStart(2,"0"); return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; }
  function parseLocal(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date; }
  function formatMoment(date) { return date ? new Intl.DateTimeFormat("nb-NO", { weekday:"short", day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" }).format(date) : "—"; }
  function methodLabel(value) { return ({admin_or_code:"Turneringsleder + kode",admin_only:"Kun turneringsleder",code:"Kun kode"})[value] || value; }

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
    const style = document.createElement("style");
    style.textContent = `
      .tw-backdrop{position:fixed;inset:0;background:rgba(9,34,51,.58);display:grid;place-items:center;padding:16px;z-index:1200}
      .tw-backdrop.hidden{display:none}.tw-dialog{width:min(780px,100%);max-height:min(92dvh,900px);overflow:auto;background:#fff;border:1px solid #cadce7;border-radius:22px;box-shadow:0 24px 80px rgba(9,34,51,.24);color:#102f43}
      .tw-head{padding:22px;border-bottom:1px solid #d7e5ed;display:flex;justify-content:space-between;gap:16px;align-items:start}.tw-head h2{margin:3px 0}.tw-close{border:0;background:transparent;color:#526d7e;font-size:30px;cursor:pointer}
      .tw-progress{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#d7e5ed}.tw-progress span{padding:10px;background:#f4f9fc;text-align:center;font-size:12px;color:#587184}.tw-progress span.active{color:#fff;font-weight:800;background:#11435d}
      .tw-body{padding:22px}.tw-step{display:none;gap:16px}.tw-step.active{display:grid}.tw-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.tw-grid .wide{grid-column:1/-1}.tw-dialog label{display:grid;gap:7px;color:#35556a;font-size:13px;font-weight:700}.tw-dialog input,.tw-dialog select{width:100%;box-sizing:border-box}
      .tw-rule{display:grid;grid-template-columns:auto 1fr;gap:12px;padding:14px;border:1px solid #c9dfeb;border-radius:14px;background:#eef7fc}.tw-rule strong{display:block;margin-bottom:3px}.tw-rule-icon{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:#11435d;color:#fff;font-weight:900}.tw-help{padding:13px;border:1px solid #d7e5ed;border-radius:13px;background:#f8fbfd}
      .tw-actions{padding:16px 22px;border-top:1px solid #d7e5ed;display:flex;justify-content:space-between;gap:10px}.tw-actions>div{display:flex;gap:8px}.tw-message{margin:0 22px 16px;padding:11px 13px;border-radius:10px;border:1px solid #d7e5ed}.tw-message.bad{border-color:#d98282;background:#fff5f5}.tw-message.good{border-color:#70ae92;background:#f2fbf6}.tw-summary{display:grid;gap:8px}.tw-summary div{display:flex;justify-content:space-between;gap:14px;padding:10px 0;border-bottom:1px solid #e2ebf0}
      @media(max-width:650px){.tw-backdrop{padding:0;align-items:end}.tw-dialog{width:100%;max-height:96dvh;border-radius:22px 22px 0 0}.tw-grid{grid-template-columns:1fr}.tw-grid .wide{grid-column:auto}.tw-actions{position:sticky;bottom:0;background:#fff}.tw-actions>div{display:flex}.tw-progress span{font-size:11px;padding:9px 4px}}
    `;
    document.head.appendChild(style);
  }

  function install() {
    if (document.getElementById("twOpen")) return;
    installStyles();
    const head = host.querySelector(":scope > .panel-head");
    const openButton = document.createElement("button");
    openButton.id = "twOpen";
    openButton.type = "button";
    openButton.className = "button";
    openButton.textContent = "+ Ny turnering";
    head?.appendChild(openButton);

    const root = document.createElement("div");
    root.id = "twBackdrop";
    root.className = "tw-backdrop hidden";
    root.innerHTML = `<section class="tw-dialog" role="dialog" aria-modal="true" aria-labelledby="twTitle">
      <div class="tw-head"><div><p class="eyebrow">Turneringsveiviser</p><h2 id="twTitle">Ny turnering</h2><p class="muted">Bare valg som faktisk varierer fra turnering til turnering.</p></div><button id="twClose" class="tw-close" type="button" aria-label="Lukk">×</button></div>
      <div id="twProgress" class="tw-progress"><span>1 · Grunnlag</span><span>2 · Deltakere</span><span>3 · Format</span></div>
      <form id="twForm"><div class="tw-body">
        <section class="tw-step" data-step="0">
          <div class="tw-grid">
            <label class="wide"><span>Navn</span><input id="twName" required maxlength="180" placeholder="Mandagsserien"></label>
            <label><span>Planlagt start</span><input id="twStart" type="datetime-local" required></label>
            <label><span>Planlagt slutt <small>(valgfritt)</small></span><input id="twEnd" type="datetime-local"></label>
            <label class="wide"><span>Serie / sesong</span><select id="twSeason"><option value="">Ikke del av en serie/sesong</option></select></label>
          </div>
          <div class="tw-help"><strong>Serie/sesong er valgfritt</strong><p class="muted">Velg f.eks. «Mandagsserien høst 2026» dersom resultatet skal telle i den sesongen. Ellers står turneringen alene.</p></div>
        </section>
        <section class="tw-step" data-step="1">
          <div id="twTimingRules" class="stack"></div>
          <div class="tw-grid">
            <label><span>Maks spillere</span><input id="twMax" type="number" min="2" placeholder="Ingen grense"></label>
            <label><span>Check-in-metode</span><select id="twCheckinMethod"><option value="admin_or_code">Turneringsleder + kode</option><option value="admin_only">Kun turneringsleder</option><option value="code">Kun kode</option></select></label>
          </div>
          <div class="tw-help"><strong>Ingen egne tidsfrister å administrere</strong><p class="muted">Påmelding og check-in stenger i det øyeblikket turneringsleder trykker <strong>Start turnering</strong>. Kode lages automatisk når metoden bruker kode.</p></div>
        </section>
        <section class="tw-step" data-step="2">
          <div class="tw-grid"><label><span>Planlagte grupper</span><input id="twGroups" type="number" min="1" max="32" value="4"></label><label><span>Trekkemetode</span><select id="twDrawMode"><option value="elo_snake">ELO-seedet snake</option><option value="elo_pots">ELO-potter + tilfeldig</option><option value="random">Helt tilfeldig</option></select></label><label><span>Gruppespill · best of</span><input id="twGroupBestOf" type="number" min="1" max="21" step="2" value="3"></label><label><span>Videre per gruppe</span><input id="twQualifiers" type="number" min="1" max="16" value="2"></label><label><span>Sluttspill · best of</span><input id="twPlayoffBestOf" type="number" min="1" max="21" step="2" value="3"></label></div>
          <div class="tw-help"><strong>Gruppene trekkes senere</strong><p class="muted">Formatplanen lagres nå. Trekningen gjøres når deltakerne og check-in er klare.</p></div><div id="twSummary" class="tw-summary"></div>
        </section>
      </div><div id="twMessage" class="tw-message hidden"></div><div class="tw-actions"><button id="twPrev" type="button" class="button secondary">Tilbake</button><div><button id="twCancel" type="button" class="button quiet">Avbryt</button><button id="twNext" type="button" class="button">Neste</button><button id="twCreate" type="submit" class="button hidden">Opprett turnering</button></div></div></form>
    </section>`;
    document.body.appendChild(root);

    openButton.addEventListener("click", open);
    document.getElementById("twClose").addEventListener("click", close);
    document.getElementById("twCancel").addEventListener("click", close);
    document.getElementById("twPrev").addEventListener("click", () => go(state.step - 1));
    document.getElementById("twNext").addEventListener("click", () => { if (validateStep()) go(state.step + 1); });
    document.getElementById("twForm").addEventListener("submit", createTournament);
    document.getElementById("twStart").addEventListener("change", renderTimingRules);
  }

  function show(text, tone = "bad") { const node = document.getElementById("twMessage"); node.textContent = text; node.className = `tw-message ${tone}`; }
  function hide() { const node = document.getElementById("twMessage"); node.textContent = ""; node.className = "tw-message hidden"; }

  async function open() {
    state.step = 0; state.creating = false;
    document.getElementById("twForm").reset();
    const next = new Date(); next.setSeconds(0,0); next.setDate(next.getDate() + ((8-next.getDay())%7 || 7)); next.setHours(18,30,0,0);
    document.getElementById("twStart").value = localInput(next);
    document.getElementById("twGroups").value = "4"; document.getElementById("twGroupBestOf").value = "3"; document.getElementById("twQualifiers").value = "2"; document.getElementById("twPlayoffBestOf").value = "3";
    try {
      const [seasons, checkin] = await Promise.all([api(`/clubs/${clubId()}/seasons`), api(`/clubs/${clubId()}/checkin-settings`)]);
      state.seasons = seasons.items || [];
      state.checkinMethod = checkin.settings?.default_method || "admin_or_code";
    } catch { state.seasons = []; state.checkinMethod = "admin_or_code"; }
    document.getElementById("twSeason").innerHTML = `<option value="">Ikke del av en serie/sesong</option>` + state.seasons.map((s) => `<option value="${Number(s.id)}">${esc(s.name)}${s.status ? ` · ${esc(s.status)}` : ""}</option>`).join("");
    document.getElementById("twCheckinMethod").value = state.checkinMethod;
    renderTimingRules(); go(0); document.getElementById("twBackdrop").classList.remove("hidden");
  }

  function close() { if (!state.creating) document.getElementById("twBackdrop").classList.add("hidden"); }
  function renderTimingRules() {
    const start = parseLocal(document.getElementById("twStart")?.value);
    const reg = start ? new Date(start.getTime() - 167 * 3600000) : null;
    const checkin = start ? new Date(start.getTime() - 2 * 3600000) : null;
    const node = document.getElementById("twTimingRules"); if (!node) return;
    node.innerHTML = `<div class="tw-rule"><span class="tw-rule-icon">1</span><div><strong>Påmelding åpner ${esc(formatMoment(reg))}</strong><span class="muted">6 dager og 23 timer før planlagt start. Stenger når du starter turneringen.</span></div></div><div class="tw-rule"><span class="tw-rule-icon">2</span><div><strong>Check-in åpner ${esc(formatMoment(checkin))}</strong><span class="muted">2 timer før planlagt start. Stenger når du starter turneringen.</span></div></div>`;
  }

  function go(step) {
    state.step = Math.max(0, Math.min(2, step));
    document.querySelectorAll(".tw-step").forEach((node) => node.classList.toggle("active", Number(node.dataset.step) === state.step));
    document.querySelectorAll("#twProgress span").forEach((node,i) => node.classList.toggle("active", i === state.step));
    document.getElementById("twPrev").disabled = state.step === 0;
    document.getElementById("twNext").classList.toggle("hidden", state.step === 2);
    document.getElementById("twCreate").classList.toggle("hidden", state.step !== 2);
    hide(); if (state.step === 1) renderTimingRules(); if (state.step === 2) renderSummary();
  }

  function odd(value) { const n=Number(value); return Number.isInteger(n)&&n>=1&&n<=21&&n%2===1; }
  function validateStep() {
    if (state.step === 0) {
      const start=parseLocal(document.getElementById("twStart").value), end=parseLocal(document.getElementById("twEnd").value);
      if (!document.getElementById("twName").value.trim()) { show("Gi turneringen et navn."); return false; }
      if (!start) { show("Sett planlagt start."); return false; }
      if (end && end<=start) { show("Planlagt slutt må være etter start."); return false; }
    }
    if (state.step === 2 && (!odd(document.getElementById("twGroupBestOf").value)||!odd(document.getElementById("twPlayoffBestOf").value))) { show("Best of må være oddetall mellom 1 og 21."); return false; }
    return true;
  }

  function renderSummary() {
    const season=document.getElementById("twSeason"); const seasonText=season.value ? season.options[season.selectedIndex]?.textContent : "Ingen serie/sesong";
    document.getElementById("twSummary").innerHTML = `<div><span>Turnering</span><strong>${esc(document.getElementById("twName").value.trim())}</strong></div><div><span>Serie/sesong</span><strong>${esc(seasonText)}</strong></div><div><span>Check-in</span><strong>${esc(methodLabel(document.getElementById("twCheckinMethod").value))}</strong></div><div><span>Gruppespill</span><strong>${Number(document.getElementById("twGroups").value)} grupper · Bo${Number(document.getElementById("twGroupBestOf").value)}</strong></div><div><span>Sluttspill</span><strong>Topp ${Number(document.getElementById("twQualifiers").value)} · Bo${Number(document.getElementById("twPlayoffBestOf").value)}</strong></div>`;
  }

  async function createTournament(event) {
    event.preventDefault(); if (!validateStep() || state.creating) return;
    state.creating=true; const button=document.getElementById("twCreate"); button.disabled=true; button.textContent="Oppretter …"; let id=0;
    try {
      const base=await api(`/clubs/${clubId()}/tournaments`,{method:"POST",body:{name:document.getElementById("twName").value.trim(),start_at:document.getElementById("twStart").value,end_at:document.getElementById("twEnd").value||null,season_id:document.getElementById("twSeason").value?Number(document.getElementById("twSeason").value):null,provider_system:"local"}});
      id=Number(base.tournament?.id||0); if(!id) throw new Error("Mangler turnerings-ID.");
      await api(`/tournaments/${id}/registration-settings`,{method:"PUT",body:{max_players:document.getElementById("twMax").value?Number(document.getElementById("twMax").value):null}});
      await api(`/tournaments/${id}/checkin-settings`,{method:"PUT",body:{checkin_method:document.getElementById("twCheckinMethod").value,rotate_checkin_code:true}});
      await api(`/tournaments/${id}/wizard-plan`,{method:"PUT",body:{group_count:Number(document.getElementById("twGroups").value||1),group_draw_mode:document.getElementById("twDrawMode").value,group_best_of_legs:Number(document.getElementById("twGroupBestOf").value||3),qualifiers_per_group:Number(document.getElementById("twQualifiers").value||2),playoff_best_of_legs:Number(document.getElementById("twPlayoffBestOf").value||3)}});
      show("Turneringen er opprettet. Påmelding og check-in følger de faste tidsreglene.","good");
      window.setTimeout(()=>{state.creating=false;document.getElementById("twBackdrop").classList.add("hidden");document.getElementById("refreshAllButton")?.click();document.getElementById("tcRefresh")?.click();window.dispatchEvent(new CustomEvent("bd:tournament-created",{detail:{tournamentId:id}}));},650);
    } catch(error) { show(error.message+(id?` Turnering ID ${id} ble opprettet og kan repareres i admin.`:"")); state.creating=false; }
    finally { button.disabled=false; button.textContent="Opprett turnering"; }
  }

  install();
}
