const API_ROOT = "../api/v1";
const host = document.getElementById("tournaments");

if (host) {
  let creating = false;

  function token() { return localStorage.getItem("bd:token") || ""; }
  function clubId() { return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0); }
  function localInput(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function registrationOpen(start) { return new Date(start.getTime() - (6 * 24 + 23) * 60 * 60 * 1000); }
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
  style.textContent = `.tw-backdrop{position:fixed;inset:0;background:rgba(5,8,12,.62);backdrop-filter:blur(8px);display:grid;place-items:center;padding:16px;z-index:1200}.tw-backdrop.hidden{display:none}.tw-dialog{width:min(620px,100%);overflow:hidden;background:linear-gradient(180deg,var(--panel-2),var(--panel));color:#f4f7fb;border:1px solid var(--line);border-radius:22px;box-shadow:0 28px 90px rgba(0,0,0,.48),0 0 0 1px rgba(255,255,255,.02)}.tw-head,.tw-body,.tw-actions{padding:20px}.tw-head{border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:16px;background:rgba(255,255,255,.012)}.tw-head h2{margin:3px 0 7px;color:#f4f7fb}.tw-head .muted{max-width:510px}.tw-close{width:40px;height:40px;flex:0 0 40px;padding:0;border:1px solid transparent;border-radius:11px;background:transparent;color:var(--muted);font-size:25px;line-height:1;cursor:pointer}.tw-close:hover{transform:none;color:#f4f7fb;background:#202a38;border-color:var(--line)}.tw-body{background:var(--panel)}.tw-form{display:grid;gap:14px}.tw-form label{display:grid;gap:7px;color:#cbd5e1}.tw-form input{background:#0f151e;color:#fff;border-color:var(--line)}.tw-form input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(233,185,73,.12)}.tw-auto{padding:14px 15px;border:1px solid rgba(233,185,73,.25);background:rgba(233,185,73,.055);border-radius:14px}.tw-auto strong{display:block;margin-bottom:5px;color:#f4f7fb}.tw-actions{border-top:1px solid var(--line);display:flex;justify-content:flex-end;gap:9px;background:#111821}.tw-actions .button.quiet{color:#c7d0dc;border-color:var(--line);background:#161e29}.tw-actions .button.quiet:hover{background:#202a38;color:#f4f7fb}.tw-message{margin:0;padding:11px 20px;border-top:1px solid var(--line);border-radius:0;background:#111821}.tw-message.bad{border-top-color:rgba(255,107,107,.45);color:#ffc4c4;background:rgba(255,107,107,.07)}.tw-message.good{border-top-color:rgba(77,212,166,.4);color:#aaf1d9;background:rgba(77,212,166,.06)}@media(max-width:640px){.tw-backdrop{padding:10px;place-items:end center}.tw-dialog{width:100%;max-height:calc(100dvh - 20px);overflow:auto;border-radius:20px}.tw-head,.tw-body,.tw-actions{padding:17px}.tw-actions{position:sticky;bottom:0}}`;
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
    <div class="tw-head"><div><p class="eyebrow">Ny turnering</p><h2>Planlegg klubbkvelden</h2><p class="muted">Bare det vi faktisk vet nå. Deltakerantallet avgjør formatet senere.</p></div><button id="twClose" class="tw-close" type="button" aria-label="Lukk">×</button></div>
    <form id="twForm">
      <div class="tw-body tw-form">
        <label><span>Navn</span><input id="twName" required maxlength="180" placeholder="Mandagsserien #4"></label>
        <label><span>Planlagt start</span><input id="twStart" type="datetime-local" required></label>
        <div class="tw-auto"><strong>Påmelding ordnes automatisk</strong><p id="twAutoText" class="muted"></p></div>
        <div class="tw-auto"><strong>Format velges ved innsjekk</strong><p class="muted">Når du ser hvor mange som faktisk er til stede, foreslår turneringsrommet et format. Spillere som ikke er sjekket inn blir ikke med når turneringen startes.</p></div>
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
  function open() {
    document.getElementById("twForm").reset();
    hideMessage();
    const next = new Date();
    next.setSeconds(0, 0);
    next.setDate(next.getDate() + ((8 - next.getDay()) % 7 || 7));
    next.setHours(18, 30, 0, 0);
    document.getElementById("twStart").value = localInput(next);
    renderAutoText();
    root.classList.remove("hidden");
  }
  function close() { if (!creating) root.classList.add("hidden"); }

  async function createTournament(event) {
    event.preventDefault();
    if (creating) return;
    const name = document.getElementById("twName").value.trim();
    const startValue = document.getElementById("twStart").value;
    const start = new Date(startValue);
    if (!name) return show("Gi turneringen et navn.");
    if (Number.isNaN(start.getTime())) return show("Sett planlagt start.");

    creating = true;
    const button = document.getElementById("twCreate");
    button.disabled = true;
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
        checkin_method: "inherit",
        rotate_checkin_code: true,
      }});

      show("Turneringen er opprettet. Påmelding og check-in følger automatisk flyten.", "good");
      window.setTimeout(() => {
        creating = false;
        root.classList.add("hidden");
        document.getElementById("refreshAllButton")?.click();
        document.getElementById("tcRefresh")?.click();
      }, 500);
    } catch (error) {
      show(error.message + (id ? ` Turnering ID ${id} ble opprettet og kan åpnes i turneringsrommet.` : ""));
      creating = false;
    } finally {
      button.disabled = false;
      button.textContent = "Opprett turnering";
    }
  }

  openButton.addEventListener("click", open);
  document.getElementById("twClose").addEventListener("click", close);
  document.getElementById("twCancel").addEventListener("click", close);
  document.getElementById("twStart").addEventListener("change", renderAutoText);
  document.getElementById("twForm").addEventListener("submit", createTournament);
}
