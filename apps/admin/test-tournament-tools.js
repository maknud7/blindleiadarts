const isTestEnvironment = document.documentElement.dataset.appEnv === "test"
  || /(^|[.-])test([.-]|$)/i.test(window.location.hostname)
  || /\/test(?:\/|$)/i.test(window.location.pathname)
  || new URLSearchParams(window.location.search).get("pwa") === "test";

if (isTestEnvironment) {
  const API_ROOT = "../api/v1";
  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const state = { players: [], registrations: [], busy: false };

  function token() { return localStorage.getItem("bd:token") || ""; }
  function clubId() { return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0); }
  function tournamentId() { return Number(document.getElementById("tcTournament")?.value || window.__bdTournamentContext?.id || 0); }
  function esc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }

  async function api(path, { method = "GET", body, retry429 = true } = {}) {
    const headers = {};
    if (token()) headers.Authorization = `Bearer ${token()}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${API_ROOT}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    if (response.status === 429 && retry429) {
      const retryAfter = Number(response.headers.get("Retry-After") || 1);
      await sleep(Math.max(900, Math.min(5000, retryAfter * 1000)));
      return api(path, { method, body, retry429: false });
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      const error = new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
      error.code = payload?.error?.code || "request_failed";
      throw error;
    }
    return payload.data;
  }

  function activeRegistrations() {
    return (state.registrations || []).filter((registration) => ["registered", "checked_in", "waitlisted", "paused"].includes(String(registration.status || "")));
  }

  function activePlayerIds() {
    return new Set(activeRegistrations().map((registration) => Number(registration.player_id || 0)));
  }

  function availablePlayers() {
    const used = activePlayerIds();
    return state.players.filter((player) => Number(player.id) > 0 && !used.has(Number(player.id)));
  }

  function ensureStyles() {
    if (document.getElementById("testTournamentToolsStyles")) return;
    const style = document.createElement("style");
    style.id = "testTournamentToolsStyles";
    style.textContent = `
      .tc-test-tools{margin-top:11px;border:1px solid #e2c34f;border-radius:13px;background:#fffdf2;overflow:hidden}
      .tc-test-tools>summary{cursor:pointer;padding:11px 13px;color:#725900;font-size:12px;font-weight:900;list-style:none;background:#fff8d8}
      .tc-test-tools>summary::-webkit-details-marker{display:none}.tc-test-tools>summary::after{content:"+";float:right;font-size:17px}.tc-test-tools[open]>summary::after{content:"−"}
      .tc-test-body{padding:13px;display:grid;gap:12px}.tc-test-note{margin:0;color:var(--muted);font-size:12px;line-height:1.45}
      .tc-test-toolbar{display:grid;grid-template-columns:minmax(180px,1fr) auto;gap:8px;align-items:end}.tc-test-toolbar input{width:100%}
      .tc-test-player-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;max-height:260px;overflow:auto;padding:4px}
      .tc-test-player{display:flex!important;flex-direction:row!important;align-items:center!important;gap:8px!important;padding:8px 9px;border:1px solid var(--line);border-radius:10px;background:#fff;font-size:12px;cursor:pointer}.tc-test-player input{width:auto!important;margin:0}.tc-test-player.is-hidden{display:none!important}
      .tc-test-actions{display:flex;gap:8px;flex-wrap:wrap}.tc-test-actions .button{min-height:38px}.tc-test-status{font-size:12px;color:var(--muted)}
      @media(max-width:700px){.tc-test-toolbar{grid-template-columns:1fr}.tc-test-player-list{grid-template-columns:1fr}.tc-test-actions{display:grid;grid-template-columns:1fr}.tc-test-actions .button{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function ensurePanel() {
    if (document.getElementById("tcTestTools")) return true;
    const anchor = document.getElementById("tcCheckinSettingsHost") || document.getElementById("tcAddPlayer")?.closest("details");
    if (!anchor) return false;
    ensureStyles();
    const panel = document.createElement("details");
    panel.id = "tcTestTools";
    panel.className = "tc-test-tools";
    panel.innerHTML = `
      <summary>TEST · legg til ekte spillere</summary>
      <div class="tc-test-body">
        <p class="tc-test-note">Legger ekte spillerprofiler inn som <strong>påmeldt</strong>. Innsjekk skjer senere gjennom den ordinære innsjekkflyten når innsjekkvinduet åpner. Kampdata, statistikk og ELO forblir i TEST-databasen.</p>
        <div class="tc-test-toolbar">
          <label><span>Søk spiller</span><input id="tcTestSearch" type="search" placeholder="Søk etter navn …" autocomplete="off"></label>
          <button id="tcTestReload" class="button quiet" type="button">Oppdater liste</button>
        </div>
        <div id="tcTestPlayerList" class="tc-test-player-list"><span class="muted">Henter spillere …</span></div>
        <div class="tc-test-actions">
          <button id="tcTestAddSelected" class="button" type="button">Legg til valgte</button>
          <button id="tcTestAdd8" class="button secondary" type="button">Legg til 8 tilfeldige</button>
          <button id="tcTestAdd16" class="button secondary" type="button">Legg til 16 tilfeldige</button>
        </div>
        <div id="tcTestStatus" class="tc-test-status"></div>
      </div>`;
    if (anchor.id === "tcCheckinSettingsHost") anchor.before(panel);
    else anchor.after(panel);
    bindPanel();
    return true;
  }

  function selectedPlayerIds() {
    return [...document.querySelectorAll("#tcTestPlayerList input[data-test-player]:checked")].map((input) => Number(input.value)).filter(Boolean);
  }

  function renderPlayers() {
    const root = document.getElementById("tcTestPlayerList");
    if (!root) return;
    const players = availablePlayers().sort((a, b) => String(a.display_name || "").localeCompare(String(b.display_name || ""), "nb"));
    root.innerHTML = players.length ? players.map((player) => `
      <label class="tc-test-player" data-search-name="${esc(String(player.display_name || "").toLowerCase())}">
        <input type="checkbox" data-test-player value="${Number(player.id)}">
        <span>${esc(player.display_name || `Spiller ${Number(player.id)}`)}</span>
      </label>`).join("") : `<span class="muted">Alle tilgjengelige spillere er allerede lagt til.</span>`;
    applySearch();
  }

  function applySearch() {
    const query = String(document.getElementById("tcTestSearch")?.value || "").trim().toLowerCase();
    document.querySelectorAll("#tcTestPlayerList .tc-test-player").forEach((row) => {
      row.classList.toggle("is-hidden", query !== "" && !String(row.dataset.searchName || "").includes(query));
    });
  }

  async function loadData() {
    if (!clubId() || !tournamentId() || !token()) return;
    const [players, detail] = await Promise.all([
      api(`/clubs/${clubId()}/players`),
      api(`/tournaments/${tournamentId()}`),
    ]);
    state.players = players.items || [];
    state.registrations = detail.tournament?.registrations || [];
    renderPlayers();
  }

  function setBusy(busy, text = "") {
    state.busy = busy;
    ["tcTestReload", "tcTestAddSelected", "tcTestAdd8", "tcTestAdd16"].forEach((id) => {
      const button = document.getElementById(id);
      if (button) button.disabled = busy;
    });
    const status = document.getElementById("tcTestStatus");
    if (status && text !== undefined) status.textContent = text;
  }

  async function addOne(playerId) {
    const tid = tournamentId();
    if (!tid || !playerId) return false;
    await api(`/tournaments/${tid}/registrations`, { method: "POST", body: { player_id: playerId } });
    return true;
  }

  async function syncTournamentRoom() {
    const expected = activeRegistrations().length;
    document.getElementById("tcRefresh")?.click();

    let synced = false;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await sleep(150);
      const shownTotal = Number(document.getElementById("tcAllCount")?.textContent || -1);
      if (shownTotal === expected) {
        synced = true;
        break;
      }
    }

    document.querySelector('[data-tc-filter="pending"]')?.click();
    return synced;
  }

  async function runBatch(ids) {
    const unique = [...new Set(ids.map(Number).filter(Boolean))];
    if (!unique.length || state.busy) return;
    setBusy(true, `Starter · 0/${unique.length}`);
    let ok = 0;
    const failures = [];
    try {
      for (let index = 0; index < unique.length; index += 1) {
        const playerId = unique[index];
        const player = state.players.find((item) => Number(item.id) === playerId);
        setBusy(true, `Legger til ${player?.display_name || `spiller ${playerId}`} · ${index + 1}/${unique.length}`);
        try {
          await addOne(playerId);
          ok += 1;
        } catch (error) {
          failures.push(`${player?.display_name || playerId}: ${error.message}`);
        }
        await sleep(180);
      }

      await loadData();
      const synced = await syncTournamentRoom();
      const baseMessage = failures.length
        ? `${ok}/${unique.length} lagt til. Feil: ${failures.join(" · ")}`
        : `${ok} spiller${ok === 1 ? "" : "e"} lagt til som påmeldt.`;
      setBusy(false, synced
        ? `${baseMessage} De vises nå under «Mangler innsjekk».`
        : `${baseMessage} Registreringene er lagret, men deltakerlisten rakk ikke å synkronisere automatisk. Trykk Oppdater.`);
    } catch (error) {
      setBusy(false, error.message);
    }
  }

  function randomPlayerIds(count) {
    const pool = availablePlayers().map((player) => Number(player.id));
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, Math.min(count, pool.length));
  }

  function bindPanel() {
    document.getElementById("tcTestSearch")?.addEventListener("input", applySearch);
    document.getElementById("tcTestReload")?.addEventListener("click", () => loadData().catch((error) => setBusy(false, error.message)));
    document.getElementById("tcTestAddSelected")?.addEventListener("click", () => runBatch(selectedPlayerIds()));
    document.getElementById("tcTestAdd8")?.addEventListener("click", () => runBatch(randomPlayerIds(8)));
    document.getElementById("tcTestAdd16")?.addEventListener("click", () => runBatch(randomPlayerIds(16)));
    document.getElementById("tcTournament")?.addEventListener("change", () => window.setTimeout(() => loadData().catch(() => undefined), 250));
    document.getElementById("clubSelect")?.addEventListener("change", () => window.setTimeout(() => loadData().catch(() => undefined), 250));
    loadData().catch((error) => setBusy(false, error.message));
  }

  if (!ensurePanel()) {
    const observer = new MutationObserver(() => {
      if (ensurePanel()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
}
