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
  function tournamentId() { return Number(context?.id || document.getElementById("tcTournament")?.value || 0); }
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

  function selectionIsExplicit() {
    return Boolean(boardState?.selection_initialized);
  }

  function selectedIds(container) {
    return [...container.querySelectorAll('input[data-board-id]:checked')]
      .map((input) => Number(input.dataset.boardId))
      .filter(Boolean);
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
    if (meta) meta.textContent = count ? `${count} skive${count === 1 ? "" : "r"} valgt` : "Ingen valgt";
  }

  function boardLabel(board) {
    const mode = String(board.scoring_mode || "manual") === "scolia" ? "Scolia" : "Manuell";
    return `<span class="tc-board-number">Skive ${Number(board.board_number)}</span><span class="tc-board-name">${esc(board.name || "")}</span><span class="tc-board-mode">${mode}</span>`;
  }

  function boardStateLabel(board, { live = false } = {}) {
    if (!Boolean(board.is_active)) return "Deaktivert";
    if (live && Boolean(board.is_busy)) return "Kamp pågår";
    if (live && Boolean(board.is_reserved)) return "Reservert";
    return live ? "Ledig" : "";
  }

  function renderInto(container, { live = false } = {}) {
    if (!container || !boardState) return;
    const boards = Array.isArray(boardState.boards) ? boardState.boards : [];
    const explicit = selectionIsExplicit();
    container.innerHTML = `
      <div class="tc-board-select-head">
        <div>
          <strong>Skiver for denne turneringen</strong>
          <span>${live ? "Slå skiver av og på underveis. En skive med pågående eller reservert kamp må bli ledig først." : "Velg eksplisitt hvilke skiver som skal få kamper før turneringen starter."}</span>
        </div>
        <b data-board-count></b>
      </div>
      ${!explicit && !live ? `<div class="tc-board-warning"><strong>Skiver er ikke bekreftet ennå.</strong><span>Ingen skive blir lagret som turneringsskive før du velger og lagrer, eller starter turneringen.</span></div>` : ""}
      <div class="tc-board-quick-actions">
        <button type="button" class="button quiet" data-board-select-all>Velg alle aktive</button>
        <button type="button" class="button quiet" data-board-clear>Fjern valg</button>
      </div>
      <div class="tc-board-options">
        ${boards.length ? boards.map((board) => {
          // Backend used to expose every active board as selected before a tournament
          // had an explicit selection. Do not mirror that implicit default in admin UX.
          const selected = explicit && Boolean(board.selected);
          const unavailable = !Boolean(board.is_active);
          const removalLocked = live && selected && !Boolean(board.can_remove);
          const disabled = unavailable || removalLocked;
          const state = boardStateLabel(board, { live });
          return `<label class="tc-board-option ${selected ? "selected" : ""} ${disabled ? "disabled" : ""}">
            <input type="checkbox" data-board-id="${Number(board.id)}" ${selected ? "checked" : ""} ${disabled ? "disabled" : ""}>
            <span>${boardLabel(board)}</span>
            ${state ? `<small>${esc(state)}</small>` : ""}
          </label>`;
        }).join("") : `<div class="empty">Ingen skiver er satt opp for klubben.</div>`}
      </div>
      <div class="tc-board-actions">
        <button type="button" class="button secondary" data-board-save>${live ? "Lagre skiver" : "Bekreft skiver"}</button>
        ${live ? `<span>Endringen gjelder nye kampfordelinger. Kamper som allerede er ute på en skive flyttes ikke.</span>` : `<span>Turneringen kan ikke startes uten minst én valgt skive.</span>`}
      </div>
      <p class="tc-board-message" data-board-message></p>`;

    const syncInput = (input) => {
      input.closest(".tc-board-option")?.classList.toggle("selected", input.checked);
      updateCount(container);
      setMessage(container);
      window.dispatchEvent(new CustomEvent("bd:tournament-board-selection-change", {
        detail: { tournamentId: tournamentId(), selectedCount: selectedIds(container).length },
      }));
    };

    container.querySelectorAll('input[data-board-id]').forEach((input) => input.addEventListener("change", () => syncInput(input)));
    container.querySelector("[data-board-select-all]")?.addEventListener("click", () => {
      container.querySelectorAll('input[data-board-id]:not(:disabled)').forEach((input) => {
        input.checked = true;
        input.closest(".tc-board-option")?.classList.add("selected");
      });
      updateCount(container);
      setMessage(container);
      window.dispatchEvent(new CustomEvent("bd:tournament-board-selection-change", {
        detail: { tournamentId: tournamentId(), selectedCount: selectedIds(container).length },
      }));
    });
    container.querySelector("[data-board-clear]")?.addEventListener("click", () => {
      container.querySelectorAll('input[data-board-id]:not(:disabled)').forEach((input) => {
        input.checked = false;
        input.closest(".tc-board-option")?.classList.remove("selected");
      });
      updateCount(container);
      setMessage(container, live ? "Velg minst én skive før du lagrer." : "Velg skivene du faktisk vil bruke.");
      window.dispatchEvent(new CustomEvent("bd:tournament-board-selection-change", {
        detail: { tournamentId: tournamentId(), selectedCount: selectedIds(container).length },
      }));
    });
    container.querySelector("[data-board-save]")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await saveFrom(container);
      } catch (error) {
        setMessage(container, error.message, "error");
      } finally {
        button.disabled = false;
      }
    });
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
    const id = tournamentId();
    if (!id || !token()) return;
    const request = ++loadRequest;
    const data = await api(`/tournaments/${id}/operations/boards`);
    if (request !== loadRequest) return;
    boardState = data;
    ensureFormatMount();
    ensureOperationsMount();
  }

  async function saveFrom(container) {
    const id = tournamentId();
    if (!container || !id) return false;
    const ids = selectedIds(container);
    if (!ids.length) {
      setMessage(container, "Velg minst én skive før du går videre.", "error");
      return false;
    }
    setMessage(container, "Lagrer skiver …");
    boardState = await api(`/tournaments/${id}/operations/boards`, {
      method: "PUT",
      body: { kiosk_ids: ids },
    });
    ensureFormatMount();
    ensureOperationsMount();
    const fresh = container.id === "opsBoardSelection" ? document.getElementById("opsBoardSelection") : document.getElementById("tcBoardSelection");
    const count = Number(boardState?.selected_count || ids.length);
    setMessage(fresh, `${count} skive${count === 1 ? "" : "r"} er lagret. Nye kamper sendes bare til disse.`, "success");
    window.dispatchEvent(new CustomEvent("bd:tournament-boards-updated", {
      detail: { tournamentId: id, selectedCount: count, boardState },
    }));
    return true;
  }

  async function kickoffTournament(id) {
    if (!id || kickoffDone.has(id)) return;
    kickoffDone.add(id);
    try {
      await api(`/tournaments/${id}/operations/reconcile`, { method: "POST" });
    } catch (error) {
      kickoffDone.delete(id);
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
    .tc-board-select-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.tc-board-select-head>div{display:grid;gap:2px}.tc-board-select-head strong{font-size:14px}.tc-board-select-head span{font-size:12px;color:var(--muted);line-height:1.4}.tc-board-select-head b{font-size:12px;color:var(--accent);white-space:nowrap}
    .tc-board-warning{display:grid;gap:2px;padding:10px 11px;border:1px solid #e2c34f;border-radius:10px;background:#fff8d8;font-size:12px}.tc-board-warning span{color:var(--muted);line-height:1.4}
    .tc-board-quick-actions,.tc-board-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.tc-board-quick-actions .button{min-height:32px;padding:6px 9px;font-size:11px}.tc-board-actions span{font-size:11px;color:var(--muted)}
    .tc-board-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}.tc-board-option{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:9px;padding:10px 11px;border:1px solid var(--line);border-radius:11px;background:#fff;cursor:pointer}.tc-board-option.selected{border-color:#8db9dc;background:#eef7fd}.tc-board-option.disabled{opacity:.62;cursor:not-allowed}.tc-board-option>span{display:grid;gap:1px}.tc-board-number{font-weight:800;font-size:13px}.tc-board-name,.tc-board-mode{font-size:11px;color:var(--muted)}.tc-board-option small{font-size:10px;font-weight:800;color:var(--muted)}
    .tc-board-message{min-height:16px;margin:0;font-size:12px;color:var(--muted)}.tc-board-message.error{color:#a32626;font-weight:700}.tc-board-message.success{color:#27724b;font-weight:700}
    .ops-toolbar .tc-board-selection{grid-column:1/-1;width:100%;margin:6px 0 0}
    @media(max-width:700px){.tc-board-select-head{display:grid}.tc-board-options{grid-template-columns:1fr}.tc-board-actions{display:grid}.tc-board-actions .button{width:100%}}
  `;
  document.head.appendChild(style);

  window.addEventListener("bd:tournament-context", (event) => {
    const previousId = Number(context?.id || 0);
    const wasStatus = previousStatus;
    context = event.detail || context;
    previousStatus = String(context?.status || "");
    wireStartGuard();
    wireOperationsGuard();
    if (Number(context?.id || 0) !== previousId || previousStatus !== wasStatus || !boardState) {
      loadBoards().catch(() => undefined);
    }
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
