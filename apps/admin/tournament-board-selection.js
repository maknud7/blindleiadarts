const API_ROOT = "../api/v1";
const host = document.getElementById("tournaments");

if (host) {
  let context = window.__bdTournamentContext || null;
  let boardState = null;
  let loadRequest = 0;
  let startBypass = false;
  let opsSaveBypass = false;
  let previousStatus = String(context?.status || "");
  const kickoffDone = new Set();

  function token() { return localStorage.getItem("bd:token") || ""; }
  function esc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }

  async function api(path, { method = "GET", body } = {}) {
    const headers = {};
    if (token()) headers.Authorization = `Bearer ${token()}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${API_ROOT}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  }

  function selectedIds(container) {
    return [...container.querySelectorAll('input[data-board-id]:checked')].map((input) => Number(input.dataset.boardId)).filter(Boolean);
  }

  function setMessage(container, text = "", tone = "") {
    const message = container?.querySelector("[data-board-message]");
    if (!message) return;
    message.textContent = text;
    message.className = `tc-board-message ${tone}`.trim();
  }

  function updateCount(container) {
    const count = selectedIds(container).length;
    const meta = container.querySelector("[data-board-count]");
    if (meta) meta.textContent = `${count} skive${count === 1 ? "" : "r"} valgt`;
  }

  function boardLabel(board) {
    const mode = String(board.scoring_mode || "manual") === "scolia" ? "Scolia" : "Manuell";
    return `<span class="tc-board-number">Board ${Number(board.board_number)}</span><span class="tc-board-name">${esc(board.name || "")}</span><span class="tc-board-mode">${mode}</span>`;
  }

  function renderInto(container, { live = false } = {}) {
    if (!container || !boardState) return;
    const boards = Array.isArray(boardState.boards) ? boardState.boards : [];
    container.innerHTML = `
      <div class="tc-board-select-head">
        <div><strong>Skiver</strong><span>${live ? "Skiver kampmotoren kan bruke nå." : "Velg skivene kampmotoren skal disponere."}</span></div>
        <b data-board-count></b>
      </div>
      <div class="tc-board-options">
        ${boards.length ? boards.map((board) => {
          const selected = Boolean(board.selected);
          const unavailable = !Boolean(board.is_active);
          const removalLocked = live && selected && !Boolean(board.can_remove);
          const disabled = unavailable || removalLocked;
          const state = removalLocked ? "I bruk" : unavailable ? "Deaktivert" : "";
          return `<label class="tc-board-option ${selected ? "selected" : ""} ${disabled ? "disabled" : ""}">
            <input type="checkbox" data-board-id="${Number(board.id)}" ${selected ? "checked" : ""} ${disabled ? "disabled" : ""}>
            <span>${boardLabel(board)}</span>
            ${state ? `<small>${esc(state)}</small>` : ""}
          </label>`;
        }).join("") : `<div class="empty">Ingen aktive skiver er satt opp for klubben.</div>`}
      </div>
      <p class="tc-board-message" data-board-message></p>`;
    container.querySelectorAll('input[data-board-id]').forEach((input) => input.addEventListener("change", () => {
      input.closest(".tc-board-option")?.classList.toggle("selected", input.checked);
      updateCount(container);
      setMessage(container);
    }));
    updateCount(container);
  }

  function ensureFormatMount() {
    const stage = document.getElementById("tcStageFormat");
    if (!stage) return null;
    let node = document.getElementById("tcBoardSelection");
    if (!node) {
      node = document.createElement("section");
      node.id = "tcBoardSelection";
      node.className = "tc-board-selection";
      const warning = document.getElementById("tcStartWarning");
      if (warning) warning.before(node); else stage.appendChild(node);
    }
    renderInto(node, { live: false });
    return node;
  }

  function ensureOperationsMount() {
    const panel = host.querySelector(".ops-admin-panel");
    if (!panel) return null;
    let node = document.getElementById("opsBoardSelection");
    if (!node) {
      node = document.createElement("div");
      node.id = "opsBoardSelection";
      node.className = "tc-board-selection tc-board-selection-live";
      const toolbar = panel.querySelector(".ops-toolbar");
      if (toolbar) toolbar.appendChild(node); else panel.prepend(node);
    }
    renderInto(node, { live: true });
    return node;
  }

  async function loadBoards() {
    const tournamentId = Number(context?.id || document.getElementById("tcTournament")?.value || 0);
    if (!tournamentId || !token()) return;
    const request = ++loadRequest;
    const data = await api(`/tournaments/${tournamentId}/operations/boards`);
    if (request !== loadRequest) return;
    boardState = data;
    ensureFormatMount();
    ensureOperationsMount();
  }

  async function saveFrom(container) {
    if (!container || !context?.id) return false;
    const ids = selectedIds(container);
    if (!ids.length) {
      setMessage(container, "Velg minst én skive før du går videre.", "error");
      return false;
    }
    setMessage(container, "Lagrer skiver …");
    boardState = await api(`/tournaments/${Number(context.id)}/operations/boards`, {
      method: "PUT",
      body: { kiosk_ids: ids },
    });
    ensureFormatMount();
    ensureOperationsMount();
    const fresh = container.id === "opsBoardSelection" ? document.getElementById("opsBoardSelection") : document.getElementById("tcBoardSelection");
    setMessage(fresh, "Skiveoppsettet er lagret.", "success");
    return true;
  }

  async function kickoffTournament(tournamentId) {
    if (!tournamentId || kickoffDone.has(tournamentId)) return;
    kickoffDone.add(tournamentId);
    try {
      await api(`/tournaments/${tournamentId}/operations/reconcile`, { method: "POST" });
    } catch (error) {
      kickoffDone.delete(tournamentId);
      const mount = document.getElementById("opsBoardSelection") || document.getElementById("tcBoardSelection");
      setMessage(mount, `Turneringen er startet, men første kampfordeling feilet: ${error.message}`, "error");
    }
  }

  function wireStartGuard() {
    const button = document.getElementById("tcStart");
    if (!button || button.dataset.boardGuard === "1") return;
    button.dataset.boardGuard = "1";
    button.addEventListener("click", async (event) => {
      if (startBypass) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const mount = ensureFormatMount();
      button.disabled = true;
      try {
        if (!await saveFrom(mount)) return;
        startBypass = true;
        button.disabled = false;
        button.click();
      } catch (error) {
        setMessage(mount, error.message, "error");
      } finally {
        startBypass = false;
        button.disabled = false;
      }
    }, true);
  }

  function wireOperationsGuard() {
    const button = document.getElementById("opsSave");
    if (!button || button.dataset.boardGuard === "1") return;
    button.dataset.boardGuard = "1";
    button.addEventListener("click", async (event) => {
      if (opsSaveBypass) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const mount = ensureOperationsMount();
      button.disabled = true;
      try {
        if (!await saveFrom(mount)) return;
        opsSaveBypass = true;
        button.disabled = false;
        button.click();
      } catch (error) {
        setMessage(mount, error.message, "error");
      } finally {
        opsSaveBypass = false;
        button.disabled = false;
      }
    }, true);
  }

  const style = document.createElement("style");
  style.textContent = `
    .tc-board-selection{display:grid;gap:10px;margin:14px 0;padding:14px;border:1px solid var(--line);border-radius:14px;background:#f8fbfd}
    .tc-board-select-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.tc-board-select-head>div{display:grid;gap:2px}.tc-board-select-head strong{font-size:14px}.tc-board-select-head span{font-size:12px;color:var(--muted)}.tc-board-select-head b{font-size:12px;color:var(--accent);white-space:nowrap}
    .tc-board-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}.tc-board-option{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:9px;padding:10px 11px;border:1px solid var(--line);border-radius:11px;background:#fff;cursor:pointer}.tc-board-option.selected{border-color:#8db9dc;background:#eef7fd}.tc-board-option.disabled{opacity:.62;cursor:not-allowed}.tc-board-option>span{display:grid;gap:1px}.tc-board-number{font-weight:800;font-size:13px}.tc-board-name,.tc-board-mode{font-size:11px;color:var(--muted)}.tc-board-option small{font-size:10px;font-weight:800;color:var(--muted)}
    .tc-board-message{min-height:16px;margin:0;font-size:12px;color:var(--muted)}.tc-board-message.error{color:#a32626;font-weight:700}.tc-board-message.success{color:#27724b;font-weight:700}
    .ops-toolbar .tc-board-selection{grid-column:1/-1;width:100%;margin:6px 0 0}
  `;
  document.head.appendChild(style);

  window.addEventListener("bd:tournament-context", (event) => {
    const previousId = Number(context?.id || 0);
    const wasStatus = previousStatus;
    context = event.detail || context;
    previousStatus = String(context?.status || "");
    wireStartGuard();
    wireOperationsGuard();
    if (Number(context?.id || 0) !== previousId || !boardState) loadBoards().catch(() => undefined);
    if (previousStatus === "in_progress" && wasStatus !== "in_progress") {
      window.setTimeout(() => kickoffTournament(Number(context?.id || 0)), 120);
    }
  });
  window.addEventListener("bd:tournament-tools-ready", () => {
    wireOperationsGuard();
    ensureOperationsMount();
  });

  wireStartGuard();
  wireOperationsGuard();
  loadBoards().catch(() => undefined);
}
