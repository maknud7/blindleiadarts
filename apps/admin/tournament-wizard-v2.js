const API_ROOT = "../api/v1";
const host = document.getElementById("tournaments");

if (host) {
  let creating = false;
  let checkinLeadMinutes = 60;

  function token() { return localStorage.getItem("bd:token") || ""; }
  function clubId() { return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0); }
  function localInput(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function registrationOpen(start) { return new Date(start.getTime() - (6 * 24 + 23) * 60 * 60 * 1000); }
  function defaultCheckinOpen(start) { return new Date(start.getTime() - checkinLeadMinutes * 60 * 1000); }
  function formatDate(date) {
    return new Intl.DateTimeFormat("nb-NO", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(date);
  }
  async function api(path, { method = "GET", body } = {}) {
    const headers = { Authorization: `Bearer ${token()}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${API_ROOT}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  }

  const style = document.createElement("style");
  style.textContent = `.tw-backdrop{position:fixed;inset:0;background:rgba(5,8,12,.62);backdrop-filter:blur(8px);display:grid;place-items:center;padding:16px;z-index:1200}.tw-backdrop.hidden{display:none}.tw-dialog{width:min(680px,100%);overflow:hidden;background:linear-gradient(180deg,var(--panel-2),var(--panel));color:#f4f7fb;border:1px solid var(--line);border-radius:22px;box-shadow:0 28px 90px rgba(0,0,0,.48),0 0 0 1px rgba(255,255,255,.02);transition:transform .18s ease,box-shadow .18s ease}.tw-dialog.is-success{transform:scale(.99);box-shadow:0 18px 60px rgba(0,0,0,.35),0 0 0 2px rgba(77,212,166,.18)}.tw-head,.tw-body,.tw-actions{padding:20px}.tw-head{border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:16px;background:rgba(255,255,255,.012)}.tw-head h2{margin:3px 0 7px;color:#f4f7fb}.tw-head .muted{max-width:540px}.tw-close{width:40px;height:40px;flex:0 0 40px;padding:0;border:1px solid transparent;border-radius:11px;background:transparent;color:var(--muted);font-size:25px;line-height:1;cursor:pointer}.tw-close:hover{transform:none;color:#f4f7fb;background:#202a38;border-color:var(--line)}.tw-body{background:var(--panel)}.tw-form{display:grid;gap:14px}.tw-form label{display:grid;gap:7px;color:#cbd5e1}.tw-form input,.tw-form select{background:#0f151e;color:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 11px}.tw-form input:focus,.tw-form select:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(233,185,73,.12);outline:none}.tw-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.tw-auto{padding:14px 15px;border:1px solid rgba(233,185,73,.25);background:rgba(233,185,73,.055);border-radius:14px}.tw-auto strong{display:block;margin-bottom:5px;color:#f4f7fb}.tw-format{padding:14px 15px;border:1px solid rgba(94,168,255,.25);background:rgba(94,168,255,.055);border-radius:14px}.tw-format>strong{display:block;margin-bottom:9px;color:#f4f7fb}.tw-check{grid-column:1/-1!important;display:grid!important;grid-template-columns:auto 1fr!important;align-items:start;gap:10px!important;padding:11px 12px;border:1px solid rgba(77,212,166,.25);background:rgba(77,212,166,.055);border-radius:11px}.tw-check input{width:18px;height:18px;margin:2px 0 0;padding:0;accent-color:var(--accent)}.tw-check span{display:grid;gap:3px}.tw-check strong{color:#f4f7fb}.tw-check small{color:var(--muted);line-height:1.3}.tw-actions{border-top:1px solid var(--line);display:flex;justify-content:flex-end;gap:9px;background:#111821}.tw-actions .button.quiet{color:#c7d0dc;border-color:var(--line);background:#161e29}.tw-actions .button.quiet:hover{background:#202a38;color:#f4f7fb}.tw-message{margin:0;padding:11px 20px;border-top:1px solid var(--line);border-radius:0;background:#111821}.tw-message.bad{border-top-color:rgba(255,107,107,.45);color:#ffc4c4;background:rgba(255,107,107,.07)}.tw-message.good{border-top-color:rgba(77,212,166,.4);color:#aaf1d9;background:rgba(77,212,166,.09);font-weight:800}.tw-create-busy{position:relative;padding-left:42px!important}.tw-create-busy::before{content:"";position:absolute;left:17px;top:50%;width:15px;height:15px;margin-top:-8px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:twspin .7s linear infinite}@keyframes twspin{to{transform:rotate(360deg)}}@media(max-width:640px){.tw-backdrop{padding:10px;place-items:end center}.tw-dialog{width:100%;max-height:calc(100dvh - 20px);overflow:auto;border-radius:20px}.tw-head,.tw-body,.tw-actions{padding:17px}.tw-actions{position:sticky;bottom:0}.tw-grid{grid-template-columns:1fr}}`;
  document.head.appendChild(style);

  const openButton = document.createElement("button");
  openButton.id = "twOpen";
  openButton.type = "button";
  openButton.className = "button";
  openButton.textContent = "+ Ny turnering";
  host.querySelector(":scope > .panel-head")?.appendChild(openButton);

  const root = document.createElement("div");
  root.id = "twBackdrop";
  root.className = "tw-backdrop hidden";
  root.innerHTML = `<section class="tw-dialog" role="dialog" aria-modal="true">
    <div class="tw-head"><div><p class="eyebrow">Ny turnering</p><h2>Planlegg klubbkvelden</h2><p class="muted">Sett det spillerne skal vite allerede ved påmelding. Antall grupper bestemmes senere ut fra de som faktisk sjekker inn.</p></div><button id="twClose" class="tw-close" type="button" aria-label="Lukk">×</button></div>
    <form id="twForm">
      <div class="tw-body tw-form">
        <label><span>Navn</span><input id="twName" required maxlength="180" placeholder="Mandagsserien #4"></label>
        <div class="tw-grid">
          <label><span>Planlagt start</span><input id="twStart" type="datetime-local" required></label>
          <label><span>Innsjekk åpner</span><input id="twCheckinOpen" type="datetime-local" required></label>
        </div>
        <div class="tw-format"><strong>Turneringsformat</strong><div class="tw-grid">
          <label><span>Format</span><select id="twStructure"><option value="groups_playoff">Gruppespill + sluttspill</option><option value="groups_only">Kun gruppespill</option><option value="single_elimination">Cup</option><option value="swiss">Swiss</option></select></label>
          <label><span>Spill</span><select id="twGame"><option value="501">501</option><option value="301">301</option></select></label>
          <label id="twGroupBestOfWrap"><span>Gruppespill · best av</span><select id="twGroupBestOf"><option value="1" selected>1</option><option value="3">3</option><option value="5">5</option></select></label>
          <label id="twQualifiersWrap"><span>Videre per gruppe</span><select id="twQualifiers"><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option><option value="4">4</option></select></label>
          <label id="twPlayoffBestOfWrap"><span>Sluttspill / cup · best av</span><select id="twPlayoffBestOf"><option value="1">1</option><option value="3" selected>3</option><option value="5">5</option><option value="7">7</option></select></label>
          <label id="twAutoPlayoffWrap" class="tw-check"><input id="twAutoPlayoff" type="checkbox" checked><span><strong>Opprett sluttspill automatisk</strong><small>Bruker «Videre per gruppe» og «Best av» over når siste gruppekamp er ferdig.</small></span></label>
        </div></div>
        <div class="tw-auto"><strong>Påmelding ordnes automatisk</strong><p id="twAutoText" class="muted"></p></div>
      </div>
      <div id="twMessage" class="tw-message hidden"></div>
      <div class="tw-actions"><button id="twCancel" type="button" class="button quiet">Avbryt</button><button id="twCreate" type="submit" class="button">Opprett turnering</button></div>
    </form>
  </section>`;
  document.body.appendChild(root);

  function show(text, tone = "bad") { const el = document.getElementById("twMessage"); el.textContent = text; el.className = `tw-message ${tone}`; }
  function hideMessage() { const el = document.getElementById("twMessage"); el.textContent = ""; el.className = "tw-message hidden"; }
  function renderAutoText() {
    const start = new Date(document.getElementById("twStart").value);
    const text = document.getElementById("twAutoText");
    if (Number.isNaN(start.getTime())) { text.textContent = "Påmelding åpner 6 dager og 23 timer før start og stenger først når du starter turneringen."; return; }
    text.textContent = `Påmelding åpner ${formatDate(registrationOpen(start))} og stenger først når du trykker «Start turnering».`;
  }
  function syncCheckinDefault(force = false) {
    const start = new Date(document.getElementById("twStart").value);
    const input = document.getElementById("twCheckinOpen");
    if (Number.isNaN(start.getTime()) || (!force && input.dataset.userEdited === "1")) return;
    input.value = localInput(defaultCheckinOpen(start));
  }
  function renderFormatFields() {
    const structure = document.getElementById("twStructure").value;
    document.getElementById("twGroupBestOfWrap").style.display = ["groups_playoff", "groups_only", "swiss"].includes(structure) ? "grid" : "none";
    document.getElementById("twQualifiersWrap").style.display = structure === "groups_playoff" ? "grid" : "none";
    document.getElementById("twPlayoffBestOfWrap").style.display = ["groups_playoff", "single_elimination"].includes(structure) ? "grid" : "none";
    document.getElementById("twAutoPlayoffWrap").style.display = structure === "groups_playoff" ? "grid" : "none";
  }
  async function loadCheckinDefault() {
    checkinLeadMinutes = 60;
    try {
      const data = await api(`/clubs/${clubId()}/checkin-settings`);
      const mins = Number(data?.settings?.opens_minutes_before_start);
      if (Number.isFinite(mins) && mins >= 0) checkinLeadMinutes = mins;
    } catch {}
    syncCheckinDefault(true);
  }
  async function open() {
    document.getElementById("twForm").reset();
    document.querySelector(".tw-dialog")?.classList.remove("is-success");
    hideMessage();
    const next = new Date();
    next.setSeconds(0, 0);
    next.setDate(next.getDate() + ((8 - next.getDay()) % 7 || 7));
    next.setHours(18, 30, 0, 0);
    document.getElementById("twStart").value = localInput(next);
    document.getElementById("twCheckinOpen").dataset.userEdited = "0";
    document.getElementById("twStructure").value = "groups_playoff";
    document.getElementById("twGame").value = "501";
    document.getElementById("twGroupBestOf").value = "1";
    document.getElementById("twQualifiers").value = "2";
    document.getElementById("twPlayoffBestOf").value = "3";
    document.getElementById("twAutoPlayoff").checked = true;
    renderFormatFields();
    renderAutoText();
    await loadCheckinDefault();
    root.classList.remove("hidden");
    window.setTimeout(() => document.getElementById("twName")?.focus(), 80);
  }
  function close() { if (!creating) root.classList.add("hidden"); }

  async function selectCreatedTournament(id) {
    document.getElementById("tcRefresh")?.click();
    document.getElementById("refreshAllButton")?.click();
    document.getElementById("tcRefresh")?.click();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      const select = document.getElementById("tcTournament");
      if (select?.querySelector(`option[value="${id}"]`)) {
        select.value = String(id);
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  async function createTournament(event) {
    event.preventDefault();
    if (creating) return;
    const name = document.getElementById("twName").value.trim();
    const startValue = document.getElementById("twStart").value;
    const checkinValue = document.getElementById("twCheckinOpen").value;
    const start = new Date(startValue);
    const checkinOpen = new Date(checkinValue);
    if (!name) return show("Gi turneringen et navn.");
    if (Number.isNaN(start.getTime())) return show("Sett planlagt start.");
    if (Number.isNaN(checkinOpen.getTime())) return show("Sett når innsjekken åpner.");
    if (checkinOpen >= start) return show("Innsjekk må åpne før turneringen starter.");

    const tournamentFormat = document.getElementById("twStructure").value;
    const startingScore = Number(document.getElementById("twGame").value || 501);
    const groupBestOf = Number(document.getElementById("twGroupBestOf").value || 1);
    const qualifiers = Number(document.getElementById("twQualifiers").value || 2);
    const playoffBestOf = Number(document.getElementById("twPlayoffBestOf").value || 3);
    const autoCreatePlayoff = tournamentFormat === "groups_playoff" && document.getElementById("twAutoPlayoff").checked;

    creating = true;
    hideMessage();
    const button = document.getElementById("twCreate");
    const cancel = document.getElementById("twCancel");
    const closeButton = document.getElementById("twClose");
    button.disabled = true;
    cancel.disabled = true;
    closeButton.disabled = true;
    button.classList.add("tw-create-busy");
    button.textContent = "Oppretter …";
    let id = 0;
    try {
      const base = await api(`/clubs/${clubId()}/tournaments`, { method: "POST", body: {
        name,
        start_at: startValue,
        end_at: null,
        provider_system: "local",
        status: "draft",
      }});
      id = Number(base.tournament?.id || 0);
      if (!id) throw new Error("Mangler turnerings-ID.");

      await api(`/tournaments/${id}/registration-settings`, { method: "PUT", body: {
        registration_opens_at: localInput(registrationOpen(start)),
        registration_closes_at: null,
        max_players: null,
      }});
      await api(`/tournaments/${id}/checkin-settings`, { method: "PUT", body: {
        checkin_opens_at: checkinValue,
        checkin_method: "inherit",
        rotate_checkin_code: true,
      }});
      await api(`/tournaments/${id}/wizard-plan`, { method: "PUT", body: {
        tournament_format: tournamentFormat,
        starting_score: startingScore,
        group_count: 1,
        group_draw_mode: "elo_snake",
        group_best_of_legs: groupBestOf,
        qualifiers_per_group: qualifiers,
        playoff_best_of_legs: playoffBestOf,
        auto_create_playoff: autoCreatePlayoff,
      }});

      button.classList.remove("tw-create-busy");
      button.textContent = "✓ Opprettet";
      document.querySelector(".tw-dialog")?.classList.add("is-success");
      show("Turneringen er opprettet og åpnes nå.", "good");
      await selectCreatedTournament(id);
      await new Promise((resolve) => window.setTimeout(resolve, 650));
      root.classList.add("hidden");
    } catch (error) {
      show(error.message + (id ? ` Turnering ID ${id} ble opprettet og kan åpnes i turneringsrommet.` : ""));
    } finally {
      creating = false;
      button.disabled = false;
      cancel.disabled = false;
      closeButton.disabled = false;
      button.classList.remove("tw-create-busy");
      button.textContent = "Opprett turnering";
    }
  }

  openButton.addEventListener("click", open);
  document.getElementById("twClose").addEventListener("click", close);
  document.getElementById("twCancel").addEventListener("click", close);
  document.getElementById("twStart").addEventListener("change", () => { renderAutoText(); syncCheckinDefault(false); });
  document.getElementById("twCheckinOpen").addEventListener("input", (event) => { event.currentTarget.dataset.userEdited = "1"; });
  document.getElementById("twStructure").addEventListener("change", renderFormatFields);
  document.getElementById("twForm").addEventListener("submit", createTournament);
}
