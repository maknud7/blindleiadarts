(() => {
  const originalCard = document.getElementById("scoliaScoring");
  const manualCard = document.getElementById("manualScoring");
  const activity = document.querySelector("#matchState .activity-card");
  if (!originalCard || !activity || !originalCard.parentNode) return;

  const API_URL = "../api/kiosk-scolia-ui.php";
  const API_ROOT = "../api/v1";
  const OFFLINE_FALLBACK_GRACE_MS = 5000;
  const OFFLINE_FALLBACK_RETRY_MS = 5000;

  const surface = document.createElement("section");
  surface.id = "scoliaLiveSurface";
  surface.className = "scoring-card scolia-live-surface hidden";
  surface.setAttribute("aria-live", "polite");
  originalCard.parentNode.insertBefore(surface, activity);

  const fallbackNotice = document.createElement("div");
  fallbackNotice.id = "scoliaFallbackNotice";
  fallbackNotice.className = "hidden";
  fallbackNotice.setAttribute("aria-live", "assertive");
  if (manualCard) manualCard.insertAdjacentElement("afterbegin", fallbackNotice);

  let current = null;
  let polling = false;
  let mutating = false;
  let consecutiveErrors = 0;
  let lastFingerprint = "";
  let offlineSince = 0;
  let autoFallbackBusy = false;
  let autoFallbackRetryAt = 0;
  let fallbackError = "";

  function kioskCode() {
    return localStorage.getItem("bd:kioskCode") || "";
  }

  function pairingToken() {
    return localStorage.getItem("bd:kioskPairingToken") || "";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function dartLabel(dart) {
    if (!dart) return "—";
    const multiplier = String(dart.multiplier || dart.m || "S").toUpperCase();
    const raw = dart.value ?? dart.v ?? 0;
    if (String(raw).toUpperCase() === "BULL") return multiplier === "D" ? "BULL" : "25";
    const value = Number(raw || 0);
    if (!Number.isFinite(value) || value <= 0) return "MISS";
    return `${multiplier === "S" ? "" : multiplier}${value}`;
  }

  function dartScore(dart) {
    if (!dart) return 0;
    const multiplier = String(dart.multiplier || dart.m || "S").toUpperCase();
    const raw = dart.value ?? dart.v ?? 0;
    if (String(raw).toUpperCase() === "BULL") return multiplier === "D" ? 50 : 25;
    const value = Number(raw || 0);
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (multiplier === "T") return value * 3;
    if (multiplier === "D") return value * 2;
    return value;
  }

  function isBoardOffline(board) {
    return String(board?.board_status || "").trim().toLowerCase() === "offline";
  }

  function isBoardAvailable(board) {
    return board?.connection_state === "connected" && !isBoardOffline(board);
  }

  function fallbackActive(board) {
    return Number(board?.fallback_active || 0) === 1 || Number(board?.needs_reconciliation || 0) === 1;
  }

  function shouldAutoFallback(board) {
    if (!board || board.mode !== "live") return false;
    if (board.effective_scoring_mode !== "scolia") return false;
    if (fallbackActive(board)) return false;
    if (Number(board.auto_fallback_to_manual ?? 1) !== 1) return false;
    return isBoardOffline(board)
      || board.connection_state === "disconnected"
      || board.connection_state === "error";
  }

  function isLiveAutomatic(board) {
    return board?.mode === "live"
      && board?.effective_scoring_mode === "scolia"
      && !fallbackActive(board)
      && isBoardAvailable(board);
  }

  function activePlayerName() {
    return document.querySelector(".player-card.active h2")?.textContent?.trim() || "";
  }

  async function request(action, { method = "GET", body } = {}) {
    const code = kioskCode();
    const token = pairingToken();
    if (!code || !token) throw new Error("Skiveterminalen mangler pairinginformasjon.");
    const url = new URL(API_URL, window.location.href);
    url.searchParams.set("action", action);
    if (method === "GET") url.searchParams.set("kiosk_code", code);
    const headers = { "X-Kiosk-Pairing-Token": token };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify({ kiosk_code: code, ...body }),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error?.message || `Scolia-feil (${response.status})`);
    }
    return payload.data;
  }

  async function runtimeAction(action, body) {
    const code = kioskCode();
    const token = pairingToken();
    if (!code || !token) throw new Error("Skiveterminalen mangler pairinginformasjon.");
    const headers = { "X-Kiosk-Pairing-Token": token };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${API_ROOT}/kiosks/${encodeURIComponent(code)}/scolia/${encodeURIComponent(action)}`, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error?.message || `Scolia-feil (${response.status})`);
    }
    return payload.data;
  }

  function clearManualFallbackUi() {
    if (manualCard) manualCard.style.removeProperty("display");
    originalCard.style.removeProperty("display");
    fallbackNotice.classList.add("hidden");
    fallbackNotice.innerHTML = "";
  }

  function hideLiveSurface() {
    document.body.classList.remove("scolia-live-active");
    surface.classList.add("hidden");
    lastFingerprint = "";
  }

  function renderOfflineTransition(board) {
    clearManualFallbackUi();
    document.body.classList.add("scolia-live-active");
    surface.classList.remove("hidden");

    const elapsed = offlineSince ? Math.max(0, Date.now() - offlineSince) : 0;
    const remaining = Math.max(0, Math.ceil((OFFLINE_FALLBACK_GRACE_MS - elapsed) / 1000));
    const state = isBoardOffline(board) ? "Skiva er offline" : "Scolia-forbindelsen er brutt";
    const detail = autoFallbackBusy
      ? "Aktiverer manuell scoring …"
      : `Bytter automatisk til manuell scoring${remaining > 0 ? ` om ${remaining} sek` : ""}.`;

    const fingerprint = JSON.stringify({ transition: true, state, detail, fallbackError });
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;

    surface.innerHTML = `
      <div class="scolia-live-header">
        <div class="scolia-live-state"><span class="scolia-live-dot" style="background:#c98016;box-shadow:0 0 0 4px rgba(201,128,22,.14)"></span><strong>Scolia</strong><span>Offline</span></div>
        <span class="scolia-live-auto">Fallback</span>
      </div>
      <div class="scolia-live-content" style="display:grid;place-items:center;text-align:center">
        <div style="display:grid;gap:10px;max-width:520px">
          <strong style="font-size:clamp(28px,5vw,44px)">${escapeHtml(state)}</strong>
          <span class="muted" style="font-size:clamp(15px,2.5vw,19px)">${escapeHtml(detail)}</span>
          ${fallbackError ? `<span style="font-weight:800">${escapeHtml(fallbackError)}</span>` : ""}
        </div>
      </div>
      <div class="scolia-live-footer"><span class="scolia-live-hint">Ikke registrer kast manuelt før fallback er aktiv.</span></div>`;
  }

  function renderManualFallback(board) {
    hideLiveSurface();
    if (manualCard) manualCard.style.setProperty("display", "block", "important");
    originalCard.style.setProperty("display", "none", "important");
    fallbackNotice.classList.remove("hidden");

    const available = isBoardAvailable(board);
    const title = available ? "Scolia er online igjen" : "Scolia offline · manuell fallback";
    const text = available
      ? "Fortsett manuelt til scoren er kontrollert. Scolia overtar ikke igjen før du bekrefter avstemmingen."
      : "Kampen kan fortsette manuelt. Vi sjekker automatisk om Scolia kommer tilbake.";
    const buttonText = available ? "Score er avstemt · bruk Scolia igjen" : "Venter på Scolia";
    const fingerprint = JSON.stringify({ fallback: true, title, text, available, fallbackError, mutating });
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;

    fallbackNotice.style.cssText = "margin:0 0 12px;padding:11px 12px;border:1px solid var(--line);border-radius:14px;background:var(--panel-2);display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center";
    fallbackNotice.innerHTML = `
      <div style="display:grid;gap:3px;min-width:0">
        <span class="eyebrow" style="margin:0">Scolia fallback</span>
        <strong style="font-size:16px">${escapeHtml(title)}</strong>
        <span class="muted" style="font-size:12px">${escapeHtml(text)}</span>
        ${fallbackError ? `<span style="font-size:12px;font-weight:800">${escapeHtml(fallbackError)}</span>` : ""}
      </div>
      <button type="button" class="confirm-button" data-scolia-resume ${available && !mutating ? "" : "disabled"}>${escapeHtml(buttonText)}</button>`;

    const resume = fallbackNotice.querySelector("[data-scolia-resume]");
    if (resume) resume.addEventListener("click", () => resumeScolia().catch((error) => {
      fallbackError = error.message;
      lastFingerprint = "";
      render(current);
    }));
  }

  async function maybeAutoFallback(board) {
    if (!shouldAutoFallback(board)) {
      offlineSince = 0;
      autoFallbackRetryAt = 0;
      return board;
    }

    const now = Date.now();
    if (!offlineSince) {
      offlineSince = now;
      return board;
    }
    if ((now - offlineSince) < OFFLINE_FALLBACK_GRACE_MS || now < autoFallbackRetryAt || autoFallbackBusy) return board;

    autoFallbackBusy = true;
    lastFingerprint = "";
    try {
      const data = await runtimeAction("fallback");
      const nextBoard = data?.board || board;
      if (fallbackActive(nextBoard)) {
        offlineSince = 0;
        autoFallbackRetryAt = 0;
        fallbackError = "";
      } else {
        autoFallbackRetryAt = Date.now() + 30000;
      }
      return nextBoard;
    } catch (error) {
      fallbackError = `Automatisk fallback feilet: ${error.message}`;
      autoFallbackRetryAt = Date.now() + OFFLINE_FALLBACK_RETRY_MS;
      return board;
    } finally {
      autoFallbackBusy = false;
      lastFingerprint = "";
    }
  }

  function queueWarning(board) {
    const dead = Number(board?.queue?.dead_letter || 0);
    const failed = Number(board?.queue?.failed || 0);
    if (dead > 0) return `${dead} Scolia-event må følges opp av admin.`;
    if (failed > 0) return `${failed} Scolia-event venter på automatisk retry.`;
    return "";
  }

  function render(data) {
    current = data;
    const board = data?.board || null;

    if (fallbackActive(board)) {
      renderManualFallback(board);
      return;
    }

    if (shouldAutoFallback(board)) {
      renderOfflineTransition(board);
      return;
    }

    clearManualFallbackUi();
    if (!isLiveAutomatic(board)) {
      hideLiveSurface();
      return;
    }

    document.body.classList.add("scolia-live-active");
    surface.classList.remove("hidden");

    const bufferDarts = Array.isArray(board?.buffer?.darts) ? board.buffer.darts : [];
    const lastVisit = data?.last_visit || null;
    const showingBuffer = bufferDarts.length > 0;
    const darts = showingBuffer
      ? bufferDarts
      : (Array.isArray(lastVisit?.darts) ? lastVisit.darts : []);
    const total = showingBuffer
      ? darts.reduce((sum, dart) => sum + dartScore(dart), 0)
      : (lastVisit ? Number(lastVisit.score || 0) : null);
    const title = showingBuffer ? "Kaster nå" : (lastVisit ? "Siste kast" : "Klar for kast");
    const playerName = showingBuffer ? activePlayerName() : String(lastVisit?.player_name || "");
    const statusParts = [board?.board_status, board?.board_phase].filter(Boolean);
    const phaseText = statusParts.length ? statusParts.join(" · ") : "Klar";
    const warning = queueWarning(board);
    const canUndo = showingBuffer || Boolean(lastVisit);
    const undoText = showingBuffer ? "↶ Angre siste pil" : "↶ Angre siste Scolia-kast";
    const bust = !showingBuffer && Boolean(lastVisit?.is_bust);
    const metaText = showingBuffer
      ? `${darts.length}/3 piler registrert${playerName ? ` · ${playerName}` : ""}`
      : (lastVisit ? `${playerName || "Scolia"}${bust ? " · BUST" : ""}` : "Kast når du er klar");

    const fingerprint = JSON.stringify({
      phaseText,
      darts: darts.map(dartLabel),
      total,
      title,
      metaText,
      canUndo,
      warning,
      mutating,
    });
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;

    const slots = [0, 1, 2].map((index) => {
      const dart = darts[index] || null;
      return `<div class="scolia-dart-slot${dart ? " has-dart" : ""}"><span>Pil ${index + 1}</span><strong>${escapeHtml(dartLabel(dart))}</strong></div>`;
    }).join("");

    surface.innerHTML = `
      <div class="scolia-live-header">
        <div class="scolia-live-state"><span class="scolia-live-dot"></span><strong>Scolia live</strong><span>${escapeHtml(phaseText)}</span></div>
        <span class="scolia-live-auto">Automatisk scoring</span>
      </div>
      <div class="scolia-live-content">
        <div class="scolia-live-title"><span>${escapeHtml(title)}</span><small>${escapeHtml(metaText)}</small></div>
        <div class="scolia-darts-grid">${slots}</div>
        <div class="scolia-total${bust ? " is-bust" : ""}">
          <span>${bust ? "Bust" : "Sum"}</span>
          <strong>${total === null ? "—" : escapeHtml(total)}</strong>
        </div>
      </div>
      <div class="scolia-live-footer">
        <span class="scolia-live-hint">${warning ? `⚠ ${escapeHtml(warning)}` : (showingBuffer ? "Registreres automatisk fra skiva" : "Siste registrerte Scolia-kast blir stående her")}</span>
        ${canUndo ? `<button type="button" class="ghost-button scolia-undo-button" data-scolia-live-undo ${mutating ? "disabled" : ""}>${undoText}</button>` : ""}
      </div>`;

    const undo = surface.querySelector("[data-scolia-live-undo]");
    if (undo) undo.addEventListener("click", () => undoLast().catch((error) => showError(error.message)));
  }

  function showError(message) {
    mutating = false;
    const existing = surface.querySelector(".scolia-live-error");
    if (existing) existing.remove();
    const error = document.createElement("div");
    error.className = "scolia-live-error";
    error.textContent = message;
    surface.appendChild(error);
    setTimeout(() => error.remove(), 3500);
    lastFingerprint = "";
  }

  async function resumeScolia() {
    if (mutating || !current?.board || !fallbackActive(current.board)) return;
    if (!isBoardAvailable(current.board)) {
      fallbackError = "Scolia er fortsatt offline.";
      lastFingerprint = "";
      render(current);
      return;
    }
    if (!window.confirm("Har du kontrollert at scoren på skjermen er riktig? Scolia vil overta automatisk scoring igjen.")) return;

    mutating = true;
    fallbackError = "";
    lastFingerprint = "";
    render(current);
    try {
      const data = await runtimeAction("resume", { reconciled: true });
      if (data?.board) current = { ...current, board: data.board };
      await poll({ force: true });
    } finally {
      mutating = false;
      lastFingerprint = "";
      if (current) render(current);
    }
  }

  async function undoLast() {
    if (mutating || !current) return;
    const bufferDarts = Array.isArray(current.board?.buffer?.darts) ? current.board.buffer.darts : [];
    if (bufferDarts.length === 0) {
      const confirmed = window.confirm("Ta pilene ut av skiva først. Angre siste Scolia-kast?");
      if (!confirmed) return;
    }

    mutating = true;
    lastFingerprint = "";
    render(current);
    try {
      await request("undo", { method: "POST", body: {} });
      await poll({ force: true });
    } finally {
      mutating = false;
      lastFingerprint = "";
      if (current) render(current);
    }
  }

  async function poll({ force = false } = {}) {
    if (polling && !force) return;
    polling = true;
    try {
      const data = await request("status");
      consecutiveErrors = 0;
      data.board = await maybeAutoFallback(data.board);
      render(data);
    } catch (error) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) {
        clearManualFallbackUi();
        hideLiveSurface();
      }
      if (force) throw error;
    } finally {
      polling = false;
    }
  }

  window.addEventListener("pagehide", () => {
    document.body.classList.remove("scolia-live-active");
    clearManualFallbackUi();
  });
  window.setInterval(() => poll().catch(() => undefined), 350);
  poll().catch(() => undefined);
})();