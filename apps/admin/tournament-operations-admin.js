const OPS_API_ROOT = "../api/v1";
const opsHost = document.getElementById("tournaments");

if (opsHost) {
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "./tournament-operations-admin.css";
  document.head.appendChild(css);

  const panel = document.createElement("section");
  panel.className = "ops-admin-panel";
  panel.innerHTML = `
    <div class="subsection-head">
      <div><h3>Turneringsdrift</h3><p class="muted">Kampkø, boards og automatisk videreflyt under turneringen.</p></div>
      <a id="opsLiveLink" class="button secondary" href="../live/" target="_blank" rel="noopener">Åpne live</a>
    </div>
    <div id="opsMessage" class="message hidden"></div>
    <div class="ops-toolbar">
      <label><span>Turnering</span><select id="opsTournament"></select></label>
      <label class="ops-toggle"><input id="opsAuto" type="checkbox"><span>Automatisk kampflyt</span></label>
      <button id="opsSave" type="button" class="button secondary">Lagre</button>
      <button id="opsReconcile" type="button" class="button">Fyll ledige boards</button>
      <button id="opsRefresh" type="button" class="button quiet">Oppdater</button>
    </div>
    <div id="opsProgress" class="ops-progress"></div>
    <div class="ops-columns">
      <div><div class="subsection-head"><h3>Boards</h3></div><div id="opsBoards" class="ops-board-grid"></div></div>
      <div><div class="subsection-head"><h3>Kampkø</h3></div><div id="opsQueue" class="list"></div></div>
    </div>`;
  opsHost.appendChild(panel);

  const el = Object.fromEntries(["opsLiveLink","opsMessage","opsTournament","opsAuto","opsSave","opsReconcile","opsRefresh","opsProgress","opsBoards","opsQueue"].map((id) => [id, document.getElementById(id)]));
  const state = { tournaments: [], snapshot: null };
  function token() { return localStorage.getItem("bd:token") || ""; }
  function clubId() { return Number(localStorage.getItem("bd:selectedClubId") || 0); }
  function esc(value) { return String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
  function show(message, tone = "info") { el.opsMessage.textContent = message; el.opsMessage.className = `message ${tone}`; }
  function hideMessage() { el.opsMessage.className = "message hidden"; el.opsMessage.textContent = ""; }
  async function api(path, { method = "GET", body } = {}) {
    const headers = {};
    if (token()) headers.Authorization = `Bearer ${token()}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${OPS_API_ROOT}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  }
  async function loadBase() {
    const id = clubId();
    if (!id || !token()) return;
    const data = await api(`/clubs/${id}/registration-tournaments`);
    state.tournaments = data.items || [];
    const previous = Number(el.opsTournament.value || 0);
    el.opsTournament.innerHTML = state.tournaments.map((t) => `<option value="${Number(t.id)}">${esc(t.name)} · ${esc(t.status)}</option>`).join("");
    if (state.tournaments.some((t) => Number(t.id) === previous)) el.opsTournament.value = String(previous);
    await loadSnapshot();
  }
  async function loadSnapshot() {
    const tournamentId = Number(el.opsTournament.value || 0);
    if (!tournamentId) { state.snapshot = null; render(); return; }
    state.snapshot = await api(`/tournaments/${tournamentId}/operations`);
    render();
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
      ["Pågår", Number(p.in_progress || 0)], ["Kalt opp", Number(p.assigned || 0)],
      ["I kø", Number(p.pending || 0)], ["Fremdrift", `${Number(p.percent || 0).toFixed(0)}%`],
    ].map(([label,value]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("");
    const boards = data.boards || [];
    el.opsBoards.innerHTML = boards.length ? boards.map((board) => `<article class="ops-board ${board.active_match_id ? "busy" : ""}"><div><strong>Board ${Number(board.board_number)}</strong><small>${esc(board.name || board.code)}</small></div>${board.active_match_id ? `<span>${esc(board.player_a_name)} – ${esc(board.player_b_name)}<small>${esc(board.active_match_status)}</small></span>` : `<span class="muted">Ledig</span>`}</article>`).join("") : `<div class="empty">Ingen boards er tilordnet turneringen.</div>`;
    const queue = (data.queue?.items || []).filter((m) => m.status === "pending");
    el.opsQueue.innerHTML = queue.length ? queue.map((m) => `<div class="list-row"><div><strong>${esc(m.player_a_name)} – ${esc(m.player_b_name)}</strong><div class="row-meta"><span>${esc(m.round_label || m.bracket_label || "Kamp")}</span><span>${m.players_checked_in ? "checket inn" : "mangler check-in"}</span><span>${m.players_available ? "ledig" : "opptatt"}</span></div></div></div>`).join("") : `<div class="empty">Ingen ventende kamper.</div>`;
  }
  el.opsTournament.addEventListener("change", () => loadSnapshot().catch((e) => show(e.message, "error")));
  el.opsRefresh.addEventListener("click", () => loadBase().catch((e) => show(e.message, "error")));
  el.opsSave.addEventListener("click", async () => {
    const id = Number(el.opsTournament.value || 0); if (!id) return;
    el.opsSave.disabled = true;
    try { state.snapshot = await api(`/tournaments/${id}/operations/settings`, { method: "PATCH", body: { auto_assign_enabled: el.opsAuto.checked } }); show("Driftsinnstillingen er lagret.", "success"); render(); }
    catch (e) { show(e.message, "error"); }
    finally { el.opsSave.disabled = false; }
  });
  el.opsReconcile.addEventListener("click", async () => {
    const id = Number(el.opsTournament.value || 0); if (!id) return;
    el.opsReconcile.disabled = true;
    try { state.snapshot = await api(`/tournaments/${id}/operations/reconcile`, { method: "POST" }); const n = Number(state.snapshot.assignment?.assigned_count || 0); show(n ? `${n} kamp${n === 1 ? "" : "er"} ble sendt til ledige boards.` : "Ingen nye kamper kunne sendes ut akkurat nå.", "success"); render(); }
    catch (e) { show(e.message, "error"); }
    finally { el.opsReconcile.disabled = false; }
  });
  document.getElementById("clubSelect")?.addEventListener("change", () => setTimeout(() => loadBase().catch((e) => show(e.message, "error")), 0));
  hideMessage();
  loadBase().catch((e) => show(e.message, "error"));
}
