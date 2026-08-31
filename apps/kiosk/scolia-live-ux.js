(() => {
  const originalCard = document.getElementById("scoliaScoring");
  const activity = document.querySelector("#matchState .activity-card");
  if (!originalCard || !activity || !originalCard.parentNode) return;

  const API_URL = "../api/kiosk-scolia-ui.php";
  const surface = document.createElement("section");
  surface.id = "scoliaLiveSurface";
  surface.className = "scoring-card scolia-live-surface hidden";
  surface.setAttribute("aria-live", "polite");
  originalCard.parentNode.insertBefore(surface, activity);

  let current = null;
  let polling = false;
  let mutating = false;
  let consecutiveErrors = 0;
  let lastFingerprint = "";

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

  function isLiveAutomatic(board) {
    return board?.mode === "live"
      && board?.effective_scoring_mode === "scolia"
      && Number(board?.fallback_active || 0) !== 1
      && Number(board?.needs_reconciliation || 0) !== 1
      && board?.connection_state === "connected";
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

  function hideLiveSurface() {
    document.body.classList.remove("scolia-live-active");
    surface.classList.add("hidden");
    lastFingerprint = "";
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
      render(data);
    } catch (error) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) hideLiveSurface();
      if (force) throw error;
    } finally {
      polling = false;
    }
  }

  window.addEventListener("pagehide", () => document.body.classList.remove("scolia-live-active"));
  window.setInterval(() => poll().catch(() => undefined), 350);
  poll().catch(() => undefined);
})();
