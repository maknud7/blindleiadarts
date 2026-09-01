const OPS_API_ROOT = "../api/v1";
const opsHost = document.getElementById("tournaments");

if (opsHost) {
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "./tournament-operations-admin.css";
  document.head.appendChild(css);

  const style = document.createElement("style");
  style.textContent = `
    .ops-match-row{display:grid;gap:9px}
    .ops-match-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
    .ops-match-status{font-size:11px;font-weight:800;white-space:nowrap}
    .ops-match-move{display:grid;grid-template-columns:minmax(150px,1fr) auto;gap:8px;align-items:end}
    .ops-match-move label{display:grid;gap:4px;font-size:11px;color:var(--muted)}
    .ops-match-move select{width:100%}
    .ops-match-move .button{min-height:38px}
    @media(max-width:700px){.ops-match-move{grid-template-columns:1fr}.ops-match-move .button{width:100%}}
  `;
  document.head.appendChild(style);

  const panel = document.createElement("section");
  panel.className = "ops-admin-panel";
  panel.innerHTML = `
    <div class="subsection-head">
      <div><h3>Turneringsdrift</h3><p class="muted">Kampmotor, skiver og kø under turneringen.</p></div>
      <a id="opsLiveLink" class="button secondary" href="../live/" target="_blank" rel="noopener">Åpne live</a>
    </div>
    <div id="opsMessage" class="message hidden"></div>
    <div class="ops-toolbar">
      <label><span>Turnering</span><select id="opsTournament"></select></label>
      <label class="ops-toggle"><input id="opsAuto" type="checkbox"><span>Automatisk kampfordeling</span></label>
      <button id="opsSave" type="button" class="button secondary">Lagre</button>
      <button id="opsRefresh" type="button" class="button quiet">Oppdater</button>
    </div>
    <div id="opsProgress" class="ops-progress"></div>
    <div class="ops-columns">
      <div><div class="subsection-head"><h3>Skiver</h3></div><div id="opsBoards" class="ops-board-grid"></div></div>
      <div><div class="subsection-head"><h3>Åpne kamper</h3></div><div id="opsQueue" class="list"></div></div>
    </div>`;
  opsHost.appendChild(panel);

  const el = Object.fromEntries(
    ["opsLiveLink","opsMessage","opsTournament","opsAuto","opsSave","opsRefresh","opsProgress","opsBoards","opsQueue"]
      .map((id) => [id, document.getElementById(id)])
  );
  const state = { tournaments: [], snapshot: null, boardSelection: null };

  function token() { return localStorage.getItem("bd:token") || ""; }
  function clubId() { return Number(localStorage.getItem("bd:selectedClubId") || 0); }
  function esc(value) {
    return String(value ?? "")
      .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
      .replaceAll('"',"&quot;").replaceAll("'","&#039;");
  }
  function show(message, tone = "info") {
    el.opsMessage.textContent = message;
    el.opsMessage.className = `message ${tone}`;
  }
  function hideMessage() {
    el.opsMessage.className = "message hidden";
    el.opsMessage.textContent = "";
  }
  async function api(path, { method = "GET", body } = {}) {
    const headers = {};
    if (token()) headers.Authorization = `Bearer ${token()}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${OPS_API_ROOT}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    }
    return payload.data;
  }

  async function loadBase() {
    const id = clubId();
    if (!id || !token()) return;
    const data = await api(`/clubs/${id}/registration-tournaments`);
    state.tournaments = data.items || [];
    const previous = Number(el.opsTournament.value || 0);
    el.opsTournament.innerHTML = state.tournaments
      .map((t) => `<option value="${Number(t.id)}">${esc(t.name)} · ${esc(t.status)}</option>`)
      .join("");
    if (state.tournaments.some((t) => Number(t.id) === previous)) {
      el.opsTournament.value = String(previous);
    }
    await loadSnapshot();
  }

  async function loadSnapshot() {
    const tournamentId = Number(el.opsTournament.value || 0);
    if (!tournamentId) {
      state.snapshot = null;
      state.boardSelection = null;
      render();
      return;
    }
    const [snapshot, boardSelection] = await Promise.all([
      api(`/tournaments/${tournamentId}/operations`),
      api(`/tournaments/${tournamentId}/operations/boards`),
    ]);
    state.snapshot = snapshot;
    state.boardSelection = boardSelection;
    render();
    window.setTimeout(updateBoardHelpText, 0);
  }

  function updateBoardHelpText() {
    const help = document.querySelector("#opsBoardSelection .tc-board-select-head span");
    if (help) {
      help.textContent = "Slå skiver av og på underveis. Reservasjoner frigjøres automatisk; en skive med aktiv kamp må flyttes først.";
    }
  }

  function statusLabel(status) {
    return ({
      pending: "Venter",
      assigned: "Kalt opp",
      in_progress: "Pågår",
    })[status] || status || "Ukjent";
  }

  function movableBoards(match) {
    const current = Number(match.kiosk_id || 0);
    return (state.boardSelection?.boards || []).filter((board) => {
      if (!board.selected || !board.is_active) return false;
      const boardId = Number(board.id || 0);
      if (!boardId || boardId === current) return false;
      return !board.is_busy && !board.is_reserved;
    });
  }

  function renderMove(match) {
    const boards = movableBoards(match);
    if (!boards.length) {
      return `<div class="row-meta"><span>Ingen annen valgt og ledig skive akkurat nå.</span></div>`;
    }
    const options = boards
      .map((board) => `<option value="${Number(board.id)}">Skive ${Number(board.board_number)} · ${esc(board.name || board.code || "")}</option>`)
      .join("");
    const verb = match.status === "pending" ? "Plasser kamp" : "Flytt kamp";
    return `
      <div class="ops-match-move">
        <label><span>Ny skive</span><select data-move-target="${Number(match.id)}">${options}</select></label>
        <button type="button" class="button quiet" data-move-match="${Number(match.id)}">${verb}</button>
      </div>`;
  }

  function render() {
    const data = state.snapshot;
    if (!data) {
      el.opsProgress.innerHTML = "";
      el.opsBoards.innerHTML = `<div class="empty">Ingen turnering valgt.</div>`;
      el.opsQueue.innerHTML = "";
      return;
    }

    const t = data.tournament || {};
    const p = data.progress || {};
    el.opsAuto.checked = Number(t.auto_assign_enabled || 0) === 1;
    el.opsLiveLink.href = `../live/?club=${encodeURIComponent(t.club_slug || "blindleia-dartklubb")}`;
    el.opsProgress.innerHTML = [
      ["Ferdige", `${Number(p.completed || 0)}/${Number(p.total || 0)}`],
      ["Pågår", Number(p.in_progress || 0)],
      ["Kalt opp", Number(p.assigned || 0)],
      ["I kø", Number(p.pending || 0)],
      ["Fremdrift", `${Number(p.percent || 0).toFixed(0)}%`],
    ].map(([label,value]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("");

    const boards = data.boards || [];
    el.opsBoards.innerHTML = boards.length ? boards.map((board) => {
      const reservation = board.reservation || null;
      const busy = Boolean(board.active_match_id);
      const cls = busy ? "busy" : reservation ? "reserved" : "";
      const stateHtml = busy
        ? `<span>${esc(board.player_a_name)} – ${esc(board.player_b_name)}<small>${esc(statusLabel(board.active_match_status))}</small></span>`
        : reservation
          ? `<span>${esc(reservation.player_a_name)} – ${esc(reservation.player_b_name)}<small>Neste · ${Number(reservation.remaining_seconds || 0)} sek</small></span>`
          : `<span class="muted">Ledig</span>`;
      return `<article class="ops-board ${cls}"><div><strong>Skive ${Number(board.board_number)}</strong><small>${esc(board.name || board.code)}</small></div>${stateHtml}</article>`;
    }).join("") : `<div class="empty">Ingen skiver er tilordnet turneringen.</div>`;

    const openMatches = (data.queue?.items || []).filter((match) =>
      ["pending", "assigned", "in_progress"].includes(match.status)
    );
    el.opsQueue.innerHTML = openMatches.length ? openMatches.map((match) => {
      const reservation = match.reservation || null;
      const location = match.status === "pending"
        ? reservation
          ? `reservert skive ${Number(reservation.board_number || 0)}`
          : match.players_available ? "klar for skive" : "venter på spillere"
        : match.board_number
          ? `skive ${Number(match.board_number)}`
          : "uten skive";
      return `
        <div class="list-row ops-match-row">
          <div class="ops-match-head">
            <div>
              <strong>${esc(match.player_a_name)} – ${esc(match.player_b_name)}</strong>
              <div class="row-meta">
                <span>${esc(match.round_label || match.bracket_label || "Kamp")}</span>
                <span>${esc(location)}</span>
              </div>
            </div>
            <span class="ops-match-status">${esc(statusLabel(match.status))}</span>
          </div>
          ${renderMove(match)}
        </div>`;
    }).join("") : `<div class="empty">Ingen åpne kamper.</div>`;

    el.opsQueue.querySelectorAll("[data-move-match]").forEach((button) => {
      button.addEventListener("click", () => moveMatch(Number(button.dataset.moveMatch || 0), button));
    });
  }

  async function moveMatch(matchId, button) {
    const tournamentId = Number(el.opsTournament.value || 0);
    const match = (state.snapshot?.queue?.items || []).find((item) => Number(item.id) === matchId);
    const target = el.opsQueue.querySelector(`[data-move-target="${matchId}"]`);
    const kioskId = Number(target?.value || 0);
    if (!tournamentId || !match || !kioskId) return;

    let confirmInProgress = false;
    if (match.status === "in_progress") {
      const players = `${match.player_a_name || "Spiller A"} – ${match.player_b_name || "Spiller B"}`;
      if (!window.confirm(
        `${players} pågår allerede.\n\nFlytte kampen til den valgte skiven likevel?\n\nEksisterende legs og scoring beholdes. Ny skive blir canonical umiddelbart.`
      )) return;
      confirmInProgress = true;
    }

    button.disabled = true;
    const original = button.textContent;
    button.textContent = "Flytter …";
    try {
      await api(`/tournaments/${tournamentId}/operations/matches/${matchId}/move`, {
        method: "POST",
        body: { kiosk_id: kioskId, confirm_in_progress: confirmInProgress },
      });
      show(`Kampen er flyttet til skive ${target.options[target.selectedIndex]?.textContent?.match(/\d+/)?.[0] || ""}.`, "success");
      await loadSnapshot();
      window.dispatchEvent(new CustomEvent("bd:tournament-operations-changed", {
        detail: { tournamentId, matchId, kioskId },
      }));
    } catch (error) {
      show(error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  el.opsTournament.addEventListener("change", () => loadSnapshot().catch((e) => show(e.message, "error")));
  el.opsRefresh.addEventListener("click", () => loadBase().catch((e) => show(e.message, "error")));
  el.opsSave.addEventListener("click", async () => {
    const id = Number(el.opsTournament.value || 0);
    if (!id) return;
    el.opsSave.disabled = true;
    try {
      state.snapshot = await api(`/tournaments/${id}/operations/settings`, {
        method: "PATCH",
        body: { auto_assign_enabled: el.opsAuto.checked },
      });
      show("Driftsinnstillingene er lagret.", "success");
      await loadSnapshot();
    } catch (e) {
      show(e.message, "error");
    } finally {
      el.opsSave.disabled = false;
    }
  });

  document.getElementById("clubSelect")?.addEventListener("change", () =>
    setTimeout(() => loadBase().catch((e) => show(e.message, "error")), 0)
  );
  window.addEventListener("bd:tournament-boards-updated", (event) => {
    const selectedId = Number(el.opsTournament.value || 0);
    if (!selectedId || Number(event.detail?.tournamentId || 0) !== selectedId) return;
    loadSnapshot().catch((e) => show(e.message, "error"));
  });

  hideMessage();
  loadBase().catch((e) => show(e.message, "error"));
}
