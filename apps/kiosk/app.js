const API_ROOT = "../api/v1";

const state = {
  kioskCode: localStorage.getItem("bd:kioskCode") || "",
  pairingToken: localStorage.getItem("bd:kioskPairingToken") || "",
  pairingRequestCode: localStorage.getItem("bd:kioskPairingRequestCode") || "",
  snapshot: null,
  pollHandle: null,
  inputMode: localStorage.getItem("bd:kioskInputMode") || "sum",
  sumValue: "",
  darts: [],
  multiplier: "S",
  toastHandle: null,
  isMutating: false,
  interactionVersion: 0,
  pendingAction: "",
};

const elements = {
  brandLogo: document.getElementById("brandLogo"),
  brandFallback: document.getElementById("brandFallback"),
  brandEyebrow: document.getElementById("brandEyebrow"),
  brandTitle: document.getElementById("brandTitle"),
  previewBadge: document.getElementById("previewBadge"),
  settingsButton: document.getElementById("settingsButton"),
  settingsOverlay: document.getElementById("settingsOverlay"),
  settingsDialog: document.getElementById("settingsDialog"),
  settingsCloseButton: document.getElementById("settingsCloseButton"),
  pairingSummary: document.getElementById("pairingSummary"),
  settingsMeta: document.getElementById("settingsMeta"),
  pairingRequestPanel: document.getElementById("pairingRequestPanel"),
  startPairingRequestButton: document.getElementById("startPairingRequestButton"),
  pairingRequestCard: document.getElementById("pairingRequestCard"),
  pairingRequestCode: document.getElementById("pairingRequestCode"),
  pairingQrImage: document.getElementById("pairingQrImage"),
  pairingAdminUrl: document.getElementById("pairingAdminUrl"),
  copyPairingLinkButton: document.getElementById("copyPairingLinkButton"),
  checkPairingStatusButton: document.getElementById("checkPairingStatusButton"),
  idleState: document.getElementById("idleState"),
  idleLane: document.getElementById("idleLane"),
  idleSponsor: document.getElementById("idleSponsor"),
  idleClubLogo: document.getElementById("idleClubLogo"),
  idleSponsorLogo: document.getElementById("idleSponsorLogo"),
  assignedState: document.getElementById("assignedState"),
  assignedLane: document.getElementById("assignedLane"),
  assignedSponsor: document.getElementById("assignedSponsor"),
  assignedSponsorLogo: document.getElementById("assignedSponsorLogo"),
  assignedPlayerAName: document.getElementById("assignedPlayerAName"),
  assignedPlayerBName: document.getElementById("assignedPlayerBName"),
  assignedLegInfo: document.getElementById("assignedLegInfo"),
  assignedStartButton: document.getElementById("assignedStartButton"),
  matchState: document.getElementById("matchState"),
  refreshButton: document.getElementById("refreshButton"),
  unpairButton: document.getElementById("unpairButton"),
  undoButton: document.getElementById("undoButton"),
  playerABox: document.getElementById("playerABox"),
  playerBBox: document.getElementById("playerBBox"),
  playerAName: document.getElementById("playerAName"),
  playerBName: document.getElementById("playerBName"),
  playerARemaining: document.getElementById("playerARemaining"),
  playerBRemaining: document.getElementById("playerBRemaining"),
  playerALegs: document.getElementById("playerALegs"),
  playerBLegs: document.getElementById("playerBLegs"),
  modeSumButton: document.getElementById("modeSumButton"),
  modeDartButton: document.getElementById("modeDartButton"),
  manualPanel: document.getElementById("manualPanel"),
  scoliaPanel: document.getElementById("scoliaPanel"),
  sumPanel: document.getElementById("sumPanel"),
  dartPanel: document.getElementById("dartPanel"),
  sumDisplay: document.getElementById("sumDisplay"),
  sumAfter: document.getElementById("sumAfter"),
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

function supportsModalDialog(dialog) {
  return dialog && typeof dialog.showModal === "function" && typeof dialog.close === "function";
}

function showDialog(dialog) {
  if (!dialog) {
    return;
  }

  dialog.classList.remove("hidden");

  if (supportsModalDialog(dialog)) {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "open");
    dialog.classList.add("is-open");
    document.body.classList.add("dialog-lock");
  }
}

function hideDialog(dialog) {
  if (!dialog) {
    return;
  }

  if (supportsModalDialog(dialog)) {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
    dialog.classList.remove("is-open");
    document.body.classList.remove("dialog-lock");
  }

  dialog.classList.add("hidden");
}

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

function createPossibleVisitScoreSet() {
  const singleDartScores = new Set([0, 25, 50]);

  for (let value = 1; value <= 20; value += 1) {
    singleDartScores.add(value);
    singleDartScores.add(value * 2);
    singleDartScores.add(value * 3);
  }

  const values = Array.from(singleDartScores);
  const totals = new Set();

  values.forEach((first) => {
    values.forEach((second) => {
      values.forEach((third) => {
        totals.add(first + second + third);
      });
    });
  });

  return totals;
}

const POSSIBLE_VISIT_SCORES = createPossibleVisitScoreSet();

function isPossibleVisitScore(score) {
  return POSSIBLE_VISIT_SCORES.has(score);
}

async function withMutation(task, pendingAction = "") {
  state.isMutating = true;
  state.interactionVersion += 1;
  state.pendingAction = pendingAction;

  try {
    return await task();
  } finally {
    state.isMutating = false;
    state.pendingAction = "";
  }
}

function persistPairing(code, token) {
  state.kioskCode = code;
  state.pairingToken = token;
  localStorage.setItem("bd:kioskCode", code);
  localStorage.setItem("bd:kioskPairingToken", token);
  persistPairingRequest("");
}

function persistPairingRequest(code) {
  state.pairingRequestCode = code;

  if (code) {
    localStorage.setItem("bd:kioskPairingRequestCode", code);
  } else {
    localStorage.removeItem("bd:kioskPairingRequestCode");
  }
}

function clearPairing() {
  state.kioskCode = "";
  state.pairingToken = "";
  localStorage.removeItem("bd:kioskCode");
  localStorage.removeItem("bd:kioskPairingToken");
  persistPairingRequest("");
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

function buildAdminPairingUrl(requestCode) {
  const adminUrl = new URL("../admin/", window.location.href);
  adminUrl.searchParams.set("pairing", requestCode);
  return adminUrl.toString();
}

function buildPairingQrUrl(requestCode) {
  return `https://quickchart.io/qr?size=240&text=${encodeURIComponent(buildAdminPairingUrl(requestCode))}`;
}

function resolveAssetUrl(url) {
  if (!url) {
    return "";
  }

  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  try {
    return new URL(url, `${window.location.origin}/`).toString();
  } catch {
    return url;
  }
}

function applyImageSource(image, url, altText, onError) {
  if (!image) {
    return;
  }

  const resolvedUrl = resolveAssetUrl(url);

  if (!resolvedUrl) {
    image.removeAttribute("src");
    image.hidden = true;
    return;
  }

  image.alt = altText;
  image.hidden = true;
  image.onload = () => {
    image.hidden = false;
  };
  image.onerror = () => {
    image.hidden = true;
    image.removeAttribute("src");
    if (typeof onError === "function") {
      onError();
    }
  };
  image.src = resolvedUrl;
}

function updatePairingSummary(snapshot = state.snapshot) {
  if (!state.kioskCode) {
    elements.pairingSummary.textContent = state.pairingRequestCode
      ? `Venter på godkjenning for ${state.pairingRequestCode}.`
      : "Nettbrettet er ikke paret ennå.";
    return;
  }

  const kiosk = snapshot?.kiosk;
  if (!kiosk) {
    elements.pairingSummary.textContent = `Paret mot ${state.kioskCode}. Oppdater kiosk for å hente boardstatus.`;
    return;
  }

  elements.pairingSummary.textContent = kiosk.paired_device_name
    ? `Paret mot ${kiosk.code} på ${kiosk.paired_device_name}.`
    : `Paret mot ${kiosk.code}.`;
}

function renderPairingRequestCard() {
  elements.pairingRequestPanel.classList.toggle("hidden", Boolean(state.kioskCode));

  if (!state.pairingRequestCode || state.kioskCode) {
    elements.pairingRequestCard.classList.add("hidden");
    elements.pairingQrImage.hidden = true;
    elements.pairingAdminUrl.value = "";
    return;
  }

  const adminUrl = buildAdminPairingUrl(state.pairingRequestCode);
  elements.pairingRequestCard.classList.remove("hidden");
  elements.pairingRequestCode.textContent = state.pairingRequestCode;
  elements.pairingAdminUrl.value = adminUrl;
  elements.pairingQrImage.src = buildPairingQrUrl(state.pairingRequestCode);
  elements.pairingQrImage.hidden = false;
}

function renderSettingsMeta(snapshot = state.snapshot) {
  const kiosk = snapshot?.kiosk;

  if (!kiosk) {
    elements.settingsMeta.innerHTML = "";
    return;
  }

  elements.settingsMeta.innerHTML = `
    ${kiosk.name ? `<span class="pill">${kiosk.name}</span>` : ""}
    <span class="pill">${kiosk.code}</span>
    <span class="pill">${kiosk.scoring_mode === "scolia" ? "Scolia" : "Manuell"}</span>
    ${kiosk.paired_device_name ? `<span class="pill">${kiosk.paired_device_name}</span>` : ""}
    ${kiosk.sponsor_label ? `<span class="pill">${kiosk.sponsor_label}</span>` : ""}
  `;
}

function openSettings() {
  updatePairingSummary();
  renderSettingsMeta();
  renderPairingRequestCard();
  elements.settingsOverlay?.classList.remove("hidden");
  showDialog(elements.settingsDialog);
}

function closeSettings() {
  elements.settingsOverlay?.classList.add("hidden");
  hideDialog(elements.settingsDialog);
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

function buildKioskHeading(kiosk, club) {
  if (kiosk?.sponsor_label) {
    return `${kiosk.sponsor_label}-skiva`;
  }

  if (kiosk?.name) {
    return kiosk.name;
  }

  if (kiosk?.board_number) {
    return `Board ${kiosk.board_number}`;
  }

  return club?.name ? `${club.name} kiosk` : "Board kiosk";
}

function buildKioskEyebrow(kiosk, club) {
  if (club?.name) {
    return club.name;
  }

  return kiosk?.board_number ? `Board ${kiosk.board_number}` : "Board Kiosk";
}

function applyClubBranding(club, kiosk = null) {
  const initials = (club?.name || "Klubb")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  elements.brandEyebrow.textContent = buildKioskEyebrow(kiosk, club);
  elements.brandTitle.textContent = buildKioskHeading(kiosk, club);
  elements.brandFallback.textContent = initials || "KL";

  if (club?.logo_url) {
    applyImageSource(elements.brandLogo, club.logo_url, `${club.name} logo`, () => {
      elements.brandLogo.classList.add("hidden");
      elements.brandFallback.classList.remove("hidden");
    });
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
  const boardTitle = kiosk ? (kiosk.name || `Board ${kiosk.board_number}`) : "Board -";

  elements.idleState.classList.remove("hidden");
  elements.assignedState.classList.add("hidden");
  elements.matchState.classList.add("hidden");
  elements.idleLane.textContent = boardTitle;
  elements.idleSponsor.textContent = kiosk?.sponsor_label || "Venter på neste tildelte kamp";
  elements.unpairButton.classList.toggle("hidden", !state.kioskCode);
  updatePairingSummary(snapshot);
  renderSettingsMeta(snapshot);

  applyClubBranding(kiosk?.club ?? null, kiosk ?? null);

  if (kiosk?.club?.logo_url) {
    applyImageSource(elements.idleClubLogo, kiosk.club.logo_url, "Klubblogo");
  } else {
    elements.idleClubLogo.removeAttribute("src");
    elements.idleClubLogo.hidden = true;
  }

  if (kiosk?.sponsor_logo_url) {
    applyImageSource(elements.idleSponsorLogo, kiosk.sponsor_logo_url, "Sponsorlogo");
  } else {
    elements.idleSponsorLogo.removeAttribute("src");
    elements.idleSponsorLogo.hidden = true;
  }
}

function renderDisconnected() {
  applyClubBranding(null);
  elements.idleState.classList.remove("hidden");
  elements.assignedState.classList.add("hidden");
  elements.matchState.classList.add("hidden");
  elements.idleLane.textContent = state.kioskCode ? "Kiosk frakoblet" : "Par nettbrett";
  elements.idleSponsor.textContent = state.kioskCode
    ? "Denne enheten trenger ny paring eller har mistet tilgang."
    : "Åpne tannhjulet og start pairing for å pare dette nettbrettet.";
  elements.idleClubLogo.hidden = true;
  elements.idleSponsorLogo.hidden = true;
  elements.unpairButton.classList.toggle("hidden", !state.kioskCode);
  updatePairingSummary(null);
  renderSettingsMeta(null);
  renderPairingRequestCard();
}

function renderAssigned(snapshot) {
  const kiosk = snapshot.kiosk;
  const match = snapshot.match;

  applyClubBranding(kiosk.club, kiosk);
  elements.idleState.classList.add("hidden");
  elements.assignedState.classList.remove("hidden");
  elements.matchState.classList.add("hidden");
  elements.assignedLane.textContent = kiosk.name || `Board ${kiosk.board_number}`;
  elements.assignedSponsor.textContent = kiosk.sponsor_label || `Board ${kiosk.board_number}`;
  elements.assignedPlayerAName.textContent = match.player_a.display_name;
  elements.assignedPlayerBName.textContent = match.player_b.display_name;
  elements.assignedLegInfo.textContent = `Best of ${match.best_of_legs}`;
  elements.assignedStartButton.textContent = snapshot.state === "in_progress" ? "Åpne scoring" : "Start kamp";
  elements.assignedStartButton.disabled = state.isMutating && state.pendingAction === "start_match";
  elements.unpairButton.classList.remove("hidden");
  updatePairingSummary(snapshot);
  renderSettingsMeta(snapshot);

  if (kiosk.sponsor_logo_url) {
    applyImageSource(elements.assignedSponsorLogo, kiosk.sponsor_logo_url, "Sponsorlogo");
  } else {
    elements.assignedSponsorLogo.removeAttribute("src");
    elements.assignedSponsorLogo.hidden = true;
  }
}

function renderSumPanel() {
  const rawValue = state.sumValue;
  const score = Number(rawValue || 0);
  const remainingBefore = currentRemaining();
  const remainingAfter = remainingBefore - score;
  const impossibleVisitScore = rawValue !== "" && !isPossibleVisitScore(score);
  const isCheckout = remainingAfter === 0 && isCheckoutNumber(remainingBefore);
  const isBust = score > 180 || remainingAfter < 0 || remainingAfter === 1 || (remainingAfter === 0 && !isCheckout);

  elements.sumDisplay.textContent = rawValue || "-";
  elements.sumDisplay.classList.toggle("error", score > 180 || impossibleVisitScore);

  if (!rawValue) {
    if (state.isMutating && state.pendingAction === "submit_sum") {
      elements.sumAfter.textContent = "Sender...";
      elements.sumAfter.className = "after-pill";
      return;
    }

    elements.sumAfter.textContent = "Gjenstår: -";
    elements.sumAfter.className = "after-pill";
    return;
  }

  if (state.isMutating && state.pendingAction === "submit_sum") {
    elements.sumAfter.textContent = "Sender...";
    elements.sumAfter.className = "after-pill";
    return;
  }

  if (impossibleVisitScore) {
    elements.sumAfter.textContent = "Ugyldig sum med 3 piler";
    elements.sumAfter.className = "after-pill bad";
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
    if (state.isMutating && state.pendingAction === "submit_dart") {
      elements.dartAfterChip.textContent = "Sender...";
      elements.dartAfterChip.className = "chip";
      return;
    }

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

  if (state.isMutating && state.pendingAction === "submit_dart") {
    elements.dartAfterChip.textContent = "Sender...";
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
  elements.modeSumButton.classList.toggle("active", state.inputMode === "sum");
  elements.modeDartButton.classList.toggle("active", state.inputMode === "per_dart");
  elements.sumPanel.classList.toggle("hidden", state.inputMode !== "sum");
  elements.dartPanel.classList.toggle("hidden", state.inputMode !== "per_dart");
}

function renderMatch(snapshot) {
  const kiosk = snapshot.kiosk;
  const match = snapshot.match;
  const currentPlayerId = match.current_player_id;

  applyClubBranding(kiosk.club, kiosk);
  updatePairingSummary(snapshot);
  renderSettingsMeta(snapshot);

  elements.idleState.classList.add("hidden");
  elements.assignedState.classList.add("hidden");
  elements.matchState.classList.remove("hidden");
  elements.unpairButton.classList.remove("hidden");
  elements.undoButton.classList.toggle("hidden", snapshot.state === "assigned");
  elements.undoButton.disabled = state.isMutating;
  elements.modeSumButton.disabled = !isManualMode() || state.isMutating;
  elements.modeDartButton.disabled = !isManualMode() || state.isMutating;
  elements.playerABox.classList.toggle("active", currentPlayerId === match.player_a.id);
  elements.playerBBox.classList.toggle("active", currentPlayerId === match.player_b.id);
  elements.playerAName.textContent = match.player_a.display_name;
  elements.playerBName.textContent = match.player_b.display_name;
  elements.playerARemaining.textContent = match.player_a.remaining;
  elements.playerBRemaining.textContent = match.player_b.remaining;
  elements.playerALegs.textContent = `${match.player_a.legs_won} legs`;
  elements.playerBLegs.textContent = `${match.player_b.legs_won} legs`;
  renderInputMode();
  renderSumPanel();
  renderDartPanel();
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
  renderSettingsMeta(snapshot);
  renderPairingRequestCard();

  if (snapshot.state === "idle" || !snapshot.match) {
    renderIdle(snapshot);
    return;
  }

  if (snapshot.state === "assigned") {
    renderAssigned(snapshot);
    return;
  }

  renderMatch(snapshot);
}

async function loadState() {
  if (!state.kioskCode) {
    state.snapshot = null;
    return;
  }

  const versionAtStart = state.interactionVersion;
  const snapshot = await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/state`);

  if (versionAtStart !== state.interactionVersion) {
    return;
  }

  state.snapshot = snapshot;
  renderState();
}

async function createPairingRequest() {
  ensurePairingToken();

  const data = await api("/kiosk-pairing-requests", {
    method: "POST",
    body: {
      device_name: deviceName(),
    },
  });

  persistPairingRequest(data.request.request_code);
  updatePairingSummary();
  renderPairingRequestCard();
}

async function loadPairingRequestStatus() {
  if (!state.pairingRequestCode) {
    return;
  }

  ensurePairingToken();
  const data = await api(`/kiosk-pairing-requests/${encodeURIComponent(state.pairingRequestCode)}`);

  if (data.status === "approved" && data.kiosk?.code) {
    persistPairing(data.kiosk.code, state.pairingToken);
    state.snapshot = data.snapshot ?? null;
    renderState();
    closeSettings();
    showToast("Nettbrettet er paret og klart.");
    return;
  }

  updatePairingSummary();
  renderPairingRequestCard();
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
  await withMutation(async () => {
    state.snapshot = await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/start-match`, { method: "POST" });
    resetInputBuffers();
    renderState();
  }, "start_match");
}

async function undoVisit() {
  await withMutation(async () => {
    state.snapshot = await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/undo`, { method: "POST" });
    resetInputBuffers();
    renderState();
  }, "undo_visit");
}

async function requestCheckoutDartsUsed() {
  return new Promise((resolve) => {
    showDialog(elements.checkoutDialog);

    const onClick = (event) => {
      const button = event.target.closest("[data-darts-used]");

      if (!button) {
        return;
      }

      hideDialog(elements.checkoutDialog);
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

  if (!isPossibleVisitScore(score)) {
    showToast("Den summen kan ikke oppnås med tre piler.");
    return;
  }

  const remainingBefore = currentRemaining();
  const isCheckout = remainingBefore - score === 0 && isCheckoutNumber(remainingBefore);
  const dartsUsed = isCheckout ? await requestCheckoutDartsUsed() : 3;

  await withMutation(async () => {
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
  }, "submit_sum");
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

  await withMutation(async () => {
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
  }, "submit_dart");
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
    if (state.isMutating) {
      return;
    }

    if (state.kioskCode) {
      loadState().catch(() => undefined);
      return;
    }

    if (state.pairingRequestCode) {
      loadPairingRequestStatus().catch(() => undefined);
    }
  }, 5000);
}

function bindEvents() {
  elements.settingsButton.addEventListener("click", openSettings);
  elements.settingsCloseButton.addEventListener("click", closeSettings);
  elements.settingsOverlay?.addEventListener("click", closeSettings);
  elements.settingsDialog.addEventListener("click", (event) => {
    if (event.target === elements.settingsDialog) {
      closeSettings();
    }
  });
  elements.checkoutDialog.addEventListener("click", (event) => {
    if (event.target === elements.checkoutDialog) {
      hideDialog(elements.checkoutDialog);
    }
  });

  elements.startPairingRequestButton.addEventListener("click", async () => {
    try {
      await createPairingRequest();
      startPolling();
      showToast("Pairingforespørsel opprettet.");
    } catch (error) {
      showToast(error.message);
    }
  });

  elements.copyPairingLinkButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(elements.pairingAdminUrl.value);
      showToast("Adminlenke kopiert.");
    } catch {
      showToast("Kunne ikke kopiere lenken.");
    }
  });

  elements.checkPairingStatusButton.addEventListener("click", () => {
    loadPairingRequestStatus()
      .then(() => showToast("Pairingstatus oppdatert."))
      .catch((error) => showToast(error.message));
  });

  elements.unpairButton.addEventListener("click", () => {
    unpairKiosk()
      .then(() => showToast("Paringen er fjernet fra nettbrettet."))
      .catch((error) => showToast(error.message));
  });

  elements.refreshButton.addEventListener("click", () => {
    (state.kioskCode ? loadState() : loadPairingRequestStatus())
      .then(() => {
        closeSettings();
        showToast("Kiosk oppdatert.");
      })
      .catch((error) => showToast(error.message));
  });

  elements.assignedStartButton.addEventListener("click", () => {
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
  renderPairingRequestCard();

  if (!state.kioskCode && !state.pairingRequestCode) {
    renderDisconnected();
    return;
  }

  try {
    if (state.kioskCode) {
      await loadState();
    } else {
      renderDisconnected();
      await loadPairingRequestStatus();
    }
    startPolling();
  } catch (error) {
    renderDisconnected();
    showToast(error.message);
  }
}

window.bdOpenSettings = openSettings;
window.bdCloseSettings = closeSettings;

bootstrap();
