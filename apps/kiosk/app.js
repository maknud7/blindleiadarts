const API_ROOT = "../api/v1";

const state = {
  kioskCode: localStorage.getItem("bd:kioskCode") || "",
  pairingToken: localStorage.getItem("bd:kioskPairingToken") || "",
  snapshot: null,
  pollHandle: null,
  inputMode: localStorage.getItem("bd:kioskInputMode") || "sum",
  sumValue: "",
  darts: [],
  multiplier: "S",
  toastHandle: null,
};

const elements = {
  kioskSetupForm: document.getElementById("kioskSetupForm"),
  kioskCodeInput: document.getElementById("kioskCodeInput"),
  brandLogo: document.getElementById("brandLogo"),
  brandFallback: document.getElementById("brandFallback"),
  brandTitle: document.getElementById("brandTitle"),
  previewBadge: document.getElementById("previewBadge"),
  settingsButton: document.getElementById("settingsButton"),
  settingsDialog: document.getElementById("settingsDialog"),
  settingsCloseButton: document.getElementById("settingsCloseButton"),
  pairingSummary: document.getElementById("pairingSummary"),
  laneTitle: document.getElementById("laneTitle"),
  idleState: document.getElementById("idleState"),
  idleLane: document.getElementById("idleLane"),
  idleSponsor: document.getElementById("idleSponsor"),
  idleClubLogo: document.getElementById("idleClubLogo"),
  idleSponsorLogo: document.getElementById("idleSponsorLogo"),
  matchState: document.getElementById("matchState"),
  kioskMeta: document.getElementById("kioskMeta"),
  refreshButton: document.getElementById("refreshButton"),
  unpairButton: document.getElementById("unpairButton"),
  startMatchButton: document.getElementById("startMatchButton"),
  undoButton: document.getElementById("undoButton"),
  playerABox: document.getElementById("playerABox"),
  playerBBox: document.getElementById("playerBBox"),
  playerAName: document.getElementById("playerAName"),
  playerBName: document.getElementById("playerBName"),
  playerARemaining: document.getElementById("playerARemaining"),
  playerBRemaining: document.getElementById("playerBRemaining"),
  playerALegs: document.getElementById("playerALegs"),
  playerBLegs: document.getElementById("playerBLegs"),
  legInfo: document.getElementById("legInfo"),
  kioskModeHint: document.getElementById("kioskModeHint"),
  modeSumButton: document.getElementById("modeSumButton"),
  modeDartButton: document.getElementById("modeDartButton"),
  manualPanel: document.getElementById("manualPanel"),
  scoliaPanel: document.getElementById("scoliaPanel"),
  sumPanel: document.getElementById("sumPanel"),
  dartPanel: document.getElementById("dartPanel"),
  sumDisplay: document.getElementById("sumDisplay"),
  sumAfter: document.getElementById("sumAfter"),
  recentVisits: document.getElementById("recentVisits"),
  dartChip1: document.getElementById("dartChip1"),
  dartChip2: document.getElementById("dartChip2"),
  dartChip3: document.getElementById("dartChip3"),
  dartSumChip: document.getElementById("dartSumChip"),
  dartAfterChip: document.getElementById("dartAfterChip"),
  numberGrid: document.getElementById("numberGrid"),
  dartUndoButton: document.getElementById("dartUndoButton"),
  dartSubmitButton: document.getElementById("dartSubmitButton"),
  checkoutDialog: document.getElementById("checkoutDialog"),
  toast: document.getElementById("toast"),
};

async function api(path, { method = "GET", body } = {}) {
  const headers = {};

  if (body) {
    headers["Content-Type"] = "application/json";
  }

  if (state.pairingToken) {
    headers["X-Kiosk-Pairing-Token"] = state.pairingToken;
  }

  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    throw new Error(payload?.error?.message || `Request failed with ${response.status}`);
  }

  return payload.data;
}

function enablePreviewModeIfNeeded() {
  const params = new URLSearchParams(window.location.search);
  const explicitPreview = params.get("preview");
  const isDesktop = Math.min(window.innerWidth, window.innerHeight) >= 900;
  const isTestHost = window.location.hostname.startsWith("test.");

  if (explicitPreview === "ipad" || (isTestHost && isDesktop)) {
    document.body.classList.add("preview-ipad");
    elements.previewBadge.classList.remove("hidden");
  }
}

function showToast(message) {
  window.clearTimeout(state.toastHandle);
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  state.toastHandle = window.setTimeout(() => {
    elements.toast.classList.add("hidden");
  }, 2400);
}

function persistPairing(code, token) {
  state.kioskCode = code;
  state.pairingToken = token;
  localStorage.setItem("bd:kioskCode", code);
  localStorage.setItem("bd:kioskPairingToken", token);
}

function clearPairing() {
  state.kioskCode = "";
  state.pairingToken = "";
  localStorage.removeItem("bd:kioskCode");
  localStorage.removeItem("bd:kioskPairingToken");
}

function ensurePairingToken() {
  if (!state.pairingToken) {
    state.pairingToken = window.crypto?.randomUUID
      ? window.crypto.randomUUID()
      : `kiosk-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  localStorage.setItem("bd:kioskPairingToken", state.pairingToken);
  return state.pairingToken;
}

function deviceName() {
  const host = window.location.hostname || "tablet";
  return `Nettbrett ${host}`;
}

function updatePairingSummary(snapshot = state.snapshot) {
  if (!state.kioskCode) {
    elements.pairingSummary.textContent = "Nettbrettet er ikke paret ennå.";
    return;
  }

  const kiosk = snapshot?.kiosk;
  if (!kiosk) {
    elements.pairingSummary.textContent = `Paret mot ${state.kioskCode}. Åpne eller oppdater kiosk for å hente boardstatus.`;
    return;
  }

  elements.pairingSummary.textContent = kiosk.paired_device_name
    ? `Paret mot ${kiosk.code} på ${kiosk.paired_device_name}.`
    : `Paret mot ${kiosk.code}.`;
}

function openSettings() {
  updatePairingSummary();
  elements.kioskCodeInput.value = state.kioskCode;
  elements.settingsDialog.showModal();
}

function closeSettings() {
  elements.settingsDialog.close();
}

function resetInputBuffers() {
  state.sumValue = "";
  state.darts = [];
  state.multiplier = "S";
}

function persistInputMode(mode) {
  state.inputMode = mode;
  localStorage.setItem("bd:kioskInputMode", mode);
}

function isManualMode() {
  return (state.snapshot?.kiosk?.scoring_mode || "manual") === "manual";
}

function currentMatch() {
  return state.snapshot?.match || null;
}

function currentRemaining() {
  const match = currentMatch();

  if (!match) {
    return 0;
  }

  return match.current_player_id === match.player_a.id
    ? Number(match.player_a.remaining || 0)
    : Number(match.player_b.remaining || 0);
}

function currentPlayerName() {
  const match = currentMatch();

  if (!match) {
    return "Spiller";
  }

  return match.current_player_id === match.player_a.id
    ? match.player_a.display_name
    : match.player_b.display_name;
}

function applyClubBranding(club) {
  const initials = (club?.name || "Klubb")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  elements.brandTitle.textContent = club?.name ? `${club.name} kiosk` : "Board kiosk";
  elements.brandFallback.textContent = initials || "KL";

  if (club?.logo_url) {
    elements.brandLogo.src = club.logo_url;
    elements.brandLogo.alt = `${club.name} logo`;
    elements.brandLogo.classList.remove("hidden");
    elements.brandFallback.classList.add("hidden");
  } else {
    elements.brandLogo.removeAttribute("src");
    elements.brandLogo.classList.add("hidden");
    elements.brandFallback.classList.remove("hidden");
  }
}

function renderIdle(snapshot) {
  const kiosk = snapshot?.kiosk;
  const boardTitle = kiosk ? `Board ${kiosk.board_number}` : "Board -";

  elements.idleState.classList.remove("hidden");
  elements.matchState.classList.add("hidden");
  elements.laneTitle.textContent = kiosk?.sponsor_label ? `${boardTitle} · ${kiosk.sponsor_label}` : boardTitle;
  elements.idleLane.textContent = boardTitle;
  elements.idleSponsor.textContent = kiosk?.sponsor_label || "Venter på neste tildelte kamp";
  elements.unpairButton.classList.toggle("hidden", !state.kioskCode);

  if (kiosk?.club?.logo_url) {
    elements.idleClubLogo.src = kiosk.club.logo_url;
    elements.idleClubLogo.hidden = false;
  } else {
    elements.idleClubLogo.removeAttribute("src");
    elements.idleClubLogo.hidden = true;
  }

  if (kiosk?.sponsor_logo_url) {
    elements.idleSponsorLogo.src = kiosk.sponsor_logo_url;
    elements.idleSponsorLogo.hidden = false;
  } else {
    elements.idleSponsorLogo.removeAttribute("src");
    elements.idleSponsorLogo.hidden = true;
  }
}

function renderDisconnected() {
  applyClubBranding(null);
  elements.idleState.classList.remove("hidden");
  elements.matchState.classList.add("hidden");
  elements.laneTitle.textContent = "Board -";
  elements.idleLane.textContent = state.kioskCode ? "Kiosk frakoblet" : "Par nettbrett";
  elements.idleSponsor.textContent = state.kioskCode
    ? "Denne enheten trenger ny paring eller har mistet tilgang."
    : "Åpne tannhjulet og legg inn kiosk-koden for å pare dette nettbrettet.";
  elements.idleClubLogo.hidden = true;
  elements.idleSponsorLogo.hidden = true;
  elements.unpairButton.classList.toggle("hidden", !state.kioskCode);
  updatePairingSummary(null);
}

function renderRecentVisits(match) {
  const visits = match.recent_visits || [];

  elements.recentVisits.innerHTML = visits.length
    ? visits.map((visit) => `
        <div class="pill">
          ${visit.player_name} · Visit ${visit.visit_number} · ${visit.score}${Number(visit.is_bust) === 1 ? " · Bust" : ""}
        </div>
      `).join("")
    : `<div class="pill">Ingen visits registrert ennå.</div>`;
}

function renderSumPanel() {
  const rawValue = state.sumValue;
  const score = Number(rawValue || 0);
  const remainingBefore = currentRemaining();
  const remainingAfter = remainingBefore - score;
  const isCheckout = remainingAfter === 0 && isCheckoutNumber(remainingBefore);
  const isBust = score > 180 || remainingAfter < 0 || remainingAfter === 1 || (remainingAfter === 0 && !isCheckout);

  elements.sumDisplay.textContent = rawValue || "-";
  elements.sumDisplay.classList.toggle("error", score > 180);

  if (!rawValue) {
    elements.sumAfter.textContent = "Gjenstår: -";
    elements.sumAfter.className = "after-pill";
    return;
  }

  if (isCheckout) {
    elements.sumAfter.textContent = "Checkout";
    elements.sumAfter.className = "after-pill ok";
    return;
  }

  if (isBust) {
    elements.sumAfter.textContent = "Bust";
    elements.sumAfter.className = "after-pill bad";
    return;
  }

  elements.sumAfter.textContent = `Gjenstår: ${remainingAfter}`;
  elements.sumAfter.className = "after-pill ok";
}

function renderDartPanel() {
  const labels = state.darts.map(formatDartLabel);
  const score = calculateDartScore(state.darts);
  const remainingBefore = currentRemaining();
  const remainingAfter = remainingBefore - score;
  const checkout = remainingAfter === 0 && isDoubleOutSequence(state.darts);
  const bust = score > 180 || remainingAfter < 0 || remainingAfter === 1 || (remainingAfter === 0 && !checkout);

  elements.dartChip1.textContent = `Pil 1: ${labels[0] || "-"}`;
  elements.dartChip2.textContent = `Pil 2: ${labels[1] || "-"}`;
  elements.dartChip3.textContent = `Pil 3: ${labels[2] || "-"}`;
  elements.dartSumChip.textContent = `Sum: ${score}`;

  if (!state.darts.length) {
    elements.dartAfterChip.textContent = "Gjenstår: -";
    elements.dartAfterChip.className = "chip";
  } else if (checkout) {
    elements.dartAfterChip.textContent = "Checkout";
    elements.dartAfterChip.className = "chip ok";
  } else if (bust) {
    elements.dartAfterChip.textContent = "Bust";
    elements.dartAfterChip.className = "chip bad";
  } else {
    elements.dartAfterChip.textContent = `Gjenstår: ${remainingAfter}`;
    elements.dartAfterChip.className = "chip";
  }

  document.querySelectorAll("[data-multiplier]").forEach((button) => {
    button.classList.toggle("active", button.dataset.multiplier === state.multiplier);
  });
}

function renderInputMode() {
  const manualMode = isManualMode();

  elements.manualPanel.classList.toggle("hidden", !manualMode);
  elements.scoliaPanel.classList.toggle("hidden", manualMode);
  elements.modeSumButton.disabled = !manualMode;
  elements.modeDartButton.disabled = !manualMode;

  if (!manualMode) {
    elements.kioskModeHint.textContent = "Scolia-modus er aktiv. Manuell scoring er skjult.";
    return;
  }

  elements.kioskModeHint.textContent = `Aktiv spiller: ${currentPlayerName()}`;
  elements.modeSumButton.classList.toggle("active", state.inputMode === "sum");
  elements.modeDartButton.classList.toggle("active", state.inputMode === "per_dart");
  elements.sumPanel.classList.toggle("hidden", state.inputMode !== "sum");
  elements.dartPanel.classList.toggle("hidden", state.inputMode !== "per_dart");
}

function renderMatch(snapshot) {
  const kiosk = snapshot.kiosk;
  const match = snapshot.match;
  const currentPlayerId = match.current_player_id;
  const currentIsA = currentPlayerId === match.player_a.id;
  const currentIsB = currentPlayerId === match.player_b.id;

  applyClubBranding(kiosk.club);
  updatePairingSummary(snapshot);

  elements.idleState.classList.add("hidden");
  elements.matchState.classList.remove("hidden");
  elements.kioskCodeInput.value = kiosk.code;
  elements.laneTitle.textContent = kiosk.sponsor_label ? `Board ${kiosk.board_number} · ${kiosk.sponsor_label}` : `Board ${kiosk.board_number}`;
  elements.kioskMeta.innerHTML = `
    <span class="pill">${kiosk.name}</span>
    <span class="pill">${kiosk.code}</span>
    <span class="pill">${kiosk.scoring_mode === "scolia" ? "Scolia" : "Manuell"}</span>
  `;

  elements.unpairButton.classList.remove("hidden");
  elements.startMatchButton.classList.toggle("hidden", snapshot.state !== "assigned");
  elements.undoButton.classList.toggle("hidden", snapshot.state === "assigned");
  elements.playerABox.classList.toggle("active", currentIsA);
  elements.playerBBox.classList.toggle("active", currentIsB);
  elements.playerAName.textContent = match.player_a.display_name;
  elements.playerBName.textContent = match.player_b.display_name;
  elements.playerARemaining.textContent = match.player_a.remaining;
  elements.playerBRemaining.textContent = match.player_b.remaining;
  elements.playerALegs.textContent = `${match.player_a.legs_won} legs`;
  elements.playerBLegs.textContent = `${match.player_b.legs_won} legs`;
  elements.legInfo.textContent = `Leg ${match.current_leg.leg_number} · ${match.status}`;

  renderInputMode();
  renderSumPanel();
  renderDartPanel();
  renderRecentVisits(match);
}

function renderState() {
  const snapshot = state.snapshot;

  if (!snapshot) {
    renderDisconnected();
    return;
  }

  if (snapshot.kiosk?.club) {
    applyClubBranding(snapshot.kiosk.club);
  }

  updatePairingSummary(snapshot);

  if (snapshot.state === "idle" || !snapshot.match) {
    renderIdle(snapshot);
    return;
  }

  renderMatch(snapshot);
}

async function loadState() {
  if (!state.kioskCode) {
    state.snapshot = null;
    renderDisconnected();
    return;
  }

  state.snapshot = await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/state`);
  renderState();
}

async function pairKiosk() {
  const kioskCode = elements.kioskCodeInput.value.trim().toUpperCase();

  if (!kioskCode) {
    showToast("Legg inn kiosk-koden først.");
    return;
  }

  const pairingToken = ensurePairingToken();
  state.snapshot = await api("/kiosks/pair", {
    method: "POST",
    body: {
      code: kioskCode,
      pairing_token: pairingToken,
      device_name: deviceName(),
    },
  });

  persistPairing(kioskCode, pairingToken);
  renderState();
  closeSettings();
}

async function unpairKiosk() {
  if (state.kioskCode && state.pairingToken) {
    await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/unpair`, { method: "POST" });
  }

  window.clearInterval(state.pollHandle);
  clearPairing();
  state.snapshot = null;
  closeSettings();
  renderDisconnected();
}

async function startMatch() {
  state.snapshot = await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/start-match`, { method: "POST" });
  resetInputBuffers();
  renderState();
}

async function undoVisit() {
  state.snapshot = await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/undo`, { method: "POST" });
  resetInputBuffers();
  renderState();
}

async function requestCheckoutDartsUsed() {
  return new Promise((resolve) => {
    elements.checkoutDialog.showModal();

    const onClick = (event) => {
      const button = event.target.closest("[data-darts-used]");

      if (!button) {
        return;
      }

      elements.checkoutDialog.close();
      elements.checkoutDialog.removeEventListener("click", onClick);
      resolve(Number(button.dataset.dartsUsed));
    };

    elements.checkoutDialog.addEventListener("click", onClick);
  });
}

async function submitSumVisit(forcedScore = null) {
  if (!isManualMode()) {
    showToast("Kiosken er satt til Scolia-modus.");
    return;
  }

  const rawScore = forcedScore ?? (state.sumValue === "" ? 0 : state.sumValue);
  const score = Number(rawScore);

  if (!Number.isFinite(score) || score < 0) {
    return;
  }

  const remainingBefore = currentRemaining();
  const isCheckout = remainingBefore - score === 0 && isCheckoutNumber(remainingBefore);
  const dartsUsed = isCheckout ? await requestCheckoutDartsUsed() : 3;

  state.snapshot = await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/visit`, {
    method: "POST",
    body: {
      score,
      darts_used: dartsUsed,
      input_mode: "sum",
    },
  });

  resetInputBuffers();
  renderState();
}

async function submitDartVisit() {
  if (!isManualMode()) {
    showToast("Kiosken er satt til Scolia-modus.");
    return;
  }

  if (!state.darts.length) {
    return;
  }

  const remainingBefore = currentRemaining();
  const score = calculateDartScore(state.darts);
  const isCheckout = remainingBefore - score === 0 && isDoubleOutSequence(state.darts);
  const darts = isCheckout ? state.darts.slice() : padDartsToThree(state.darts);

  state.snapshot = await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/visit`, {
    method: "POST",
    body: {
      input_mode: "per_dart",
      darts_used: isCheckout ? state.darts.length : 3,
      darts: darts.map((dart) => ({
        multiplier: dart.multiplier,
        value: dart.value,
      })),
    },
  });

  resetInputBuffers();
  renderState();
}

function setInputMode(mode) {
  persistInputMode(mode);
  renderInputMode();
}

function handleSumKey(key) {
  if (key === "del") {
    state.sumValue = state.sumValue.slice(0, -1);
  } else if (key === "ok") {
    submitSumVisit().catch((error) => showToast(error.message));
    return;
  } else if (state.sumValue.length < 3) {
    state.sumValue += key;
  }

  renderSumPanel();
}

function addDart(entry) {
  if (state.darts.length >= 3) {
    return;
  }

  state.darts.push(entry);
  state.multiplier = "S";
  renderDartPanel();
}

function formatDartLabel(dart) {
  if (dart.value === 0) {
    return "MISS";
  }

  if (dart.value === "BULL") {
    return dart.multiplier === "D" ? "DBull" : "Bull";
  }

  return dart.multiplier === "S" ? `${dart.value}` : `${dart.multiplier}${dart.value}`;
}

function calculateDartScore(darts) {
  return darts.reduce((sum, dart) => {
    if (dart.value === "BULL") {
      return sum + (dart.multiplier === "D" ? 50 : 25);
    }

    if (dart.value === 0) {
      return sum;
    }

    return sum + (dart.multiplier === "D" ? dart.value * 2 : dart.multiplier === "T" ? dart.value * 3 : dart.value);
  }, 0);
}

function isCheckoutNumber(remainingBefore) {
  if (remainingBefore <= 1 || remainingBefore > 170) {
    return false;
  }

  return ![159, 162, 163, 165, 166, 168, 169].includes(remainingBefore);
}

function isDoubleOutSequence(darts) {
  for (let index = darts.length - 1; index >= 0; index -= 1) {
    const dart = darts[index];

    if (dart.value === 0) {
      continue;
    }

    if (dart.value === "BULL") {
      return dart.multiplier === "D";
    }

    return dart.multiplier === "D";
  }

  return false;
}

function padDartsToThree(darts) {
  const padded = darts.slice();

  while (padded.length < 3) {
    padded.push({ multiplier: "S", value: 0 });
  }

  return padded;
}

function renderNumberGrid() {
  elements.numberGrid.innerHTML = Array.from({ length: 20 }, (_, offset) => 20 - offset)
    .map((value) => `<button type="button" class="quick" data-number="${value}">${value}</button>`)
    .join("");
}

function startPolling() {
  window.clearInterval(state.pollHandle);
  state.pollHandle = window.setInterval(() => {
    loadState().catch(() => undefined);
  }, 5000);
}

function bindEvents() {
  elements.settingsButton.addEventListener("click", openSettings);
  elements.settingsCloseButton.addEventListener("click", closeSettings);
  elements.settingsDialog.addEventListener("click", (event) => {
    if (event.target === elements.settingsDialog) {
      closeSettings();
    }
  });

  elements.kioskSetupForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      await pairKiosk();
      startPolling();
      showToast("Nettbrettet er paret med kiosken.");
    } catch (error) {
      showToast(error.message);
    }
  });

  elements.unpairButton.addEventListener("click", () => {
    unpairKiosk()
      .then(() => showToast("Paringen er fjernet fra nettbrettet."))
      .catch((error) => showToast(error.message));
  });

  elements.refreshButton.addEventListener("click", () => {
    loadState()
      .then(() => {
        closeSettings();
        showToast("Kiosk oppdatert.");
      })
      .catch((error) => showToast(error.message));
  });

  elements.startMatchButton.addEventListener("click", () => {
    startMatch().catch((error) => showToast(error.message));
  });

  elements.undoButton.addEventListener("click", () => {
    undoVisit().catch((error) => showToast(error.message));
  });

  elements.modeSumButton.addEventListener("click", () => setInputMode("sum"));
  elements.modeDartButton.addEventListener("click", () => setInputMode("per_dart"));

  document.querySelectorAll("[data-key]").forEach((button) => {
    button.addEventListener("click", () => handleSumKey(button.dataset.key));
  });

  document.querySelectorAll("[data-score]").forEach((button) => {
    button.addEventListener("click", () => {
      submitSumVisit(Number(button.dataset.score)).catch((error) => showToast(error.message));
    });
  });

  document.querySelectorAll("[data-multiplier]").forEach((button) => {
    button.addEventListener("click", () => {
      state.multiplier = button.dataset.multiplier;
      renderDartPanel();
    });
  });

  elements.numberGrid.addEventListener("click", (event) => {
    const button = event.target.closest("[data-number]");

    if (!button) {
      return;
    }

    addDart({
      multiplier: state.multiplier,
      value: Number(button.dataset.number),
    });
  });

  document.querySelectorAll("[data-special]").forEach((button) => {
    button.addEventListener("click", () => {
      const special = button.dataset.special;

      if (special === "miss") {
        addDart({ multiplier: "S", value: 0 });
        return;
      }

      addDart({
        multiplier: special === "dbull" ? "D" : "S",
        value: "BULL",
      });
    });
  });

  elements.dartUndoButton.addEventListener("click", () => {
    state.darts.pop();
    renderDartPanel();
  });

  elements.dartSubmitButton.addEventListener("click", () => {
    submitDartVisit().catch((error) => showToast(error.message));
  });
}

async function bootstrap() {
  enablePreviewModeIfNeeded();
  renderNumberGrid();
  bindEvents();
  elements.kioskCodeInput.value = state.kioskCode;

  if (!state.kioskCode) {
    renderDisconnected();
    return;
  }

  try {
    await loadState();
    startPolling();
  } catch (error) {
    renderDisconnected();
    showToast(error.message);
  }
}

bootstrap();
