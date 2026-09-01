const API_ROOT = "../api/v1";
const PAIRING_URL = "../api/kiosk-pairing.php";

const state = {
  kioskCode: localStorage.getItem("bd:kioskCode") || "",
  pairingToken: localStorage.getItem("bd:kioskPairingToken") || "",
  pairingRequestCode: localStorage.getItem("bd:kioskPairingRequestCode") || "",
  pairingExpires: localStorage.getItem("bd:kioskPairingExpires") || "",
  snapshot: null,
  pollHandle: null,
  liveSource: null,
  socket: null,
  realtime: null,
  reconnectHandle: null,
  inputMode: localStorage.getItem("bd:kioskInputMode") || "sum",
  sumValue: "",
  darts: [],
  multiplier: "S",
  mutating: false,
  toastHandle: null,
  renderedView: "",
};

const el = {
  brandLogo: document.getElementById("brandLogo"), brandFallback: document.getElementById("brandFallback"), brandEyebrow: document.getElementById("brandEyebrow"), brandTitle: document.getElementById("brandTitle"), brandSponsor: document.getElementById("brandSponsor"),
  connectionPill: document.getElementById("connectionPill"), connectionText: document.getElementById("connectionText"), settingsButton: document.getElementById("settingsButton"),
  setupState: document.getElementById("setupState"), pairingQr: document.getElementById("pairingQr"), qrLoading: document.getElementById("qrLoading"), pairingCode: document.getElementById("pairingCode"), pairingExpires: document.getElementById("pairingExpires"), pairingMessage: document.getElementById("pairingMessage"), newPairingButton: document.getElementById("newPairingButton"),
  idleState: document.getElementById("idleState"), idleClub: document.getElementById("idleClub"), idleBoard: document.getElementById("idleBoard"), idleMessage: document.getElementById("idleMessage"), idleMode: document.getElementById("idleMode"),
  assignedState: document.getElementById("assignedState"), assignedBoard: document.getElementById("assignedBoard"), assignedRound: document.getElementById("assignedRound"), assignedBestOf: document.getElementById("assignedBestOf"), assignedPlayerA: document.getElementById("assignedPlayerA"), assignedPlayerB: document.getElementById("assignedPlayerB"), startMatchButton: document.getElementById("startMatchButton"),
  matchState: document.getElementById("matchState"), playerABox: document.getElementById("playerABox"), playerBBox: document.getElementById("playerBBox"), playerATurn: document.getElementById("playerATurn"), playerBTurn: document.getElementById("playerBTurn"), playerAName: document.getElementById("playerAName"), playerBName: document.getElementById("playerBName"), playerARemaining: document.getElementById("playerARemaining"), playerBRemaining: document.getElementById("playerBRemaining"), playerALegs: document.getElementById("playerALegs"), playerBLegs: document.getElementById("playerBLegs"), matchBoard: document.getElementById("matchBoard"), currentLeg: document.getElementById("currentLeg"), matchRound: document.getElementById("matchRound"), undoButton: document.getElementById("undoButton"),
  manualScoring: document.getElementById("manualScoring"), scoliaScoring: document.getElementById("scoliaScoring"), throwingPlayer: document.getElementById("throwingPlayer"), sumModeButton: document.getElementById("sumModeButton"), dartModeButton: document.getElementById("dartModeButton"), sumMode: document.getElementById("sumMode"), dartMode: document.getElementById("dartMode"), sumDisplay: document.getElementById("sumDisplay"), sumHint: document.getElementById("sumHint"),
  dart1: document.getElementById("dart1"), dart2: document.getElementById("dart2"), dart3: document.getElementById("dart3"), dartTotal: document.getElementById("dartTotal"), numberGrid: document.getElementById("numberGrid"), dartBackButton: document.getElementById("dartBackButton"), dartSubmitButton: document.getElementById("dartSubmitButton"), recentVisits: document.getElementById("recentVisits"),
  settingsOverlay: document.getElementById("settingsOverlay"), settingsDialog: document.getElementById("settingsDialog"), settingsCloseButton: document.getElementById("settingsCloseButton"), settingsMeta: document.getElementById("settingsMeta"), refreshButton: document.getElementById("refreshButton"), unpairButton: document.getElementById("unpairButton"), resetTerminalButton: document.getElementById("resetTerminalButton"),
  checkoutDialog: document.getElementById("checkoutDialog"), toast: document.getElementById("toast"),
};

async function requestJson(url, { method = "GET", body, pairing = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if ((pairing || String(url).includes("/kiosks/") || String(url).includes("kiosk-pairing-requests")) && state.pairingToken) {
    headers["X-Kiosk-Pairing-Token"] = state.pairingToken;
  }
  const response = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: "no-store" });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok || !payload?.ok) {
    const error = new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    error.status = response.status;
    error.code = payload?.error?.code || "";
    throw error;
  }
  return payload.data;
}

function api(path, options = {}) { return requestJson(`${API_ROOT}${path}`, options); }
function pairingApi(action, options = {}) { return requestJson(`${PAIRING_URL}?action=${encodeURIComponent(action)}`, { ...options, pairing: true }); }

function showToast(message) {
  clearTimeout(state.toastHandle);
  el.toast.textContent = message;
  el.toast.classList.remove("hidden");
  state.toastHandle = setTimeout(() => el.toast.classList.add("hidden"), 2600);
}

function newDeviceToken() {
  return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `board-${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}
function ensureToken() {
  if (!state.pairingToken) state.pairingToken = newDeviceToken();
  localStorage.setItem("bd:kioskPairingToken", state.pairingToken);
  return state.pairingToken;
}
function persistRequest(code, expiresAt = "") {
  state.pairingRequestCode = code || "";
  state.pairingExpires = expiresAt || "";
  if (code) localStorage.setItem("bd:kioskPairingRequestCode", code); else localStorage.removeItem("bd:kioskPairingRequestCode");
  if (expiresAt) localStorage.setItem("bd:kioskPairingExpires", expiresAt); else localStorage.removeItem("bd:kioskPairingExpires");
}
function persistPairing(code) {
  state.kioskCode = code;
  localStorage.setItem("bd:kioskCode", code);
  persistRequest("");
  localStorage.removeItem("bd:kioskClub");
}
function clearLocalPairing({ newToken = true } = {}) {
  state.kioskCode = "";
  state.snapshot = null;
  state.renderedView = "";
  localStorage.removeItem("bd:kioskCode");
  localStorage.removeItem("bd:kioskClub");
  persistRequest("");
  if (newToken) {
    state.pairingToken = newDeviceToken();
    localStorage.setItem("bd:kioskPairingToken", state.pairingToken);
  }
}

function currentKiosk() { return state.snapshot?.kiosk || null; }
function currentMatch() { return state.snapshot?.match || null; }
function currentPlayer() { const m = currentMatch(); if (!m) return null; return m.current_player_id === m.player_a.id ? m.player_a : m.player_b; }
function currentRemaining() { return Number(currentPlayer()?.remaining || 0); }
function isManual() { return (currentKiosk()?.scoring_mode || "manual") === "manual"; }
function roundLabel(match) { return match?.round_label || match?.bracket_label || "Kamp"; }
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }

function setConnection(text, tone = "neutral") {
  if (el.connectionText.textContent !== text) el.connectionText.textContent = text;
  const nextClass = `status-pill ${tone}`;
  if (el.connectionPill.className !== nextClass) el.connectionPill.className = nextClass;
}
function applyBranding() {
  const kiosk = currentKiosk(), club = kiosk?.club || null;
  const initials = String(club?.name || "BD").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  el.brandFallback.textContent = initials || "BD";
  el.brandEyebrow.textContent = club?.name || "Blindleia Darts";
  el.brandTitle.textContent = kiosk ? (kiosk.name || `Board ${kiosk.board_number}`) : "Board Terminal";
  const sponsor = String(kiosk?.sponsor_label || "").trim();
  if (el.brandSponsor) {
    el.brandSponsor.textContent = sponsor ? `Presentert av ${sponsor}` : "";
    el.brandSponsor.classList.toggle("hidden", !sponsor);
  }
  if (club?.logo_url) {
    if (el.brandLogo.getAttribute("src") !== club.logo_url) el.brandLogo.src = club.logo_url;
    el.brandLogo.classList.remove("hidden");
    el.brandFallback.classList.add("hidden");
    el.brandLogo.onerror = () => { el.brandLogo.classList.add("hidden"); el.brandFallback.classList.remove("hidden"); };
  } else {
    el.brandLogo.classList.add("hidden");
    el.brandFallback.classList.remove("hidden");
  }
}
function showState(view, node) {
  if (state.renderedView === view) return;
  [el.setupState, el.idleState, el.assignedState, el.matchState].forEach((candidate) => candidate.classList.add("hidden"));
  node.classList.remove("hidden");
  state.renderedView = view;
}

function adminPairingUrl(code) {
  const url = new URL("../admin/", window.location.href);
  url.searchParams.set("pairing", code);
  url.hash = "kiosks";
  return url.toString();
}
function qrUrl(code) {
  return `https://quickchart.io/qr?size=420&margin=2&text=${encodeURIComponent(adminPairingUrl(code))}`;
}
function formatExpiry(value) {
  if (!value) return "Koden er gyldig i 30 minutter.";
  const date = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return "Koden er gyldig i 30 minutter.";
  return `Koden utløper ${new Intl.DateTimeFormat("nb-NO", { hour: "2-digit", minute: "2-digit" }).format(date)}.`;
}
function renderSetup() {
  showState("setup", el.setupState);
  applyBranding();
  setConnection(state.pairingRequestCode ? "Venter på admin" : "Ikke satt opp", "neutral");
  el.pairingCode.textContent = state.pairingRequestCode || "—";
  el.pairingExpires.textContent = formatExpiry(state.pairingExpires);
  el.pairingMessage.textContent = state.pairingRequestCode ? "Venter på at en admin velger board …" : "Lager pairingkode …";
  if (state.pairingRequestCode) {
    el.pairingQr.src = qrUrl(state.pairingRequestCode);
    el.pairingQr.classList.remove("hidden");
    el.qrLoading.classList.add("hidden");
  } else {
    el.pairingQr.removeAttribute("src");
    el.pairingQr.classList.add("hidden");
    el.qrLoading.classList.remove("hidden");
  }
  renderSettings();
}
function renderIdle() {
  const kiosk = currentKiosk(); showState("idle", el.idleState); applyBranding(); setConnection(`Board ${kiosk.board_number} · klar`, "good");
  el.idleClub.textContent = kiosk.club?.name || "Blindleia Dartklubb"; el.idleBoard.textContent = kiosk.name || `Board ${kiosk.board_number}`; el.idleMessage.textContent = "Venter på neste kamp på dette boardet."; el.idleMode.textContent = kiosk.scoring_mode === "scolia" ? "Scolia scoring" : "Manuell scoring"; renderSettings();
}
function renderAssigned() {
  const kiosk = currentKiosk(), match = currentMatch(); showState("assigned", el.assignedState); applyBranding(); setConnection(`Board ${kiosk.board_number} · kamp klar`, "good");
  el.assignedBoard.textContent = `Board ${kiosk.board_number}`; el.assignedRound.textContent = roundLabel(match); el.assignedBestOf.textContent = `Best of ${match.best_of_legs}`; el.assignedPlayerA.textContent = match.player_a.display_name; el.assignedPlayerB.textContent = match.player_b.display_name; el.startMatchButton.disabled = state.mutating; renderSettings();
}
function renderVisits() {
  const visits = currentMatch()?.recent_visits || [];
  el.recentVisits.innerHTML = visits.length ? visits.map((visit) => `<div class="visit-row"><div><strong>${escapeHtml(visit.player_name)}</strong><span>#${Number(visit.visit_number || 0)}</span></div><div><strong class="visit-score">${Number(visit.score || 0)}</strong><span>${Number(visit.is_bust) === 1 ? "Bust" : `→ ${Number(visit.remaining_after ?? 0)}`}</span></div></div>`).join("") : `<div class="empty-visits">Ingen kast registrert ennå.</div>`;
}
function renderMatch() {
  const kiosk = currentKiosk(), match = currentMatch(), player = currentPlayer(); showState("match", el.matchState); applyBranding(); setConnection(`Board ${kiosk.board_number} · live`, "good");
  el.playerAName.textContent = match.player_a.display_name; el.playerBName.textContent = match.player_b.display_name; el.playerARemaining.textContent = match.player_a.remaining; el.playerBRemaining.textContent = match.player_b.remaining; el.playerALegs.textContent = `${match.player_a.legs_won} legs`; el.playerBLegs.textContent = `${match.player_b.legs_won} legs`;
  const aTurn = match.current_player_id === match.player_a.id; el.playerABox.classList.toggle("active", aTurn); el.playerBBox.classList.toggle("active", !aTurn); el.playerATurn.classList.toggle("hidden", !aTurn); el.playerBTurn.classList.toggle("hidden", aTurn);
  el.matchBoard.textContent = `Board ${kiosk.board_number}`; el.currentLeg.textContent = `Leg ${match.current_leg?.leg_number || 1}`; el.matchRound.textContent = roundLabel(match); el.throwingPlayer.textContent = player?.display_name || "—"; el.undoButton.disabled = state.mutating;
  el.manualScoring.classList.toggle("hidden", !isManual()); el.scoliaScoring.classList.toggle("hidden", isManual()); renderInput(); renderVisits(); renderSettings();
}
function render() {
  if (!state.kioskCode || !state.snapshot) { renderSetup(); return; }
  if (state.snapshot.state === "idle" || !state.snapshot.match) { renderIdle(); return; }
  if (state.snapshot.state === "assigned") { renderAssigned(); return; }
  renderMatch();
}

function possibleVisitScores() {
  const singles = new Set([0, 25, 50]);
  for (let i = 1; i <= 20; i += 1) { singles.add(i); singles.add(i * 2); singles.add(i * 3); }
  const vals = [...singles], totals = new Set();
  for (const a of vals) for (const b of vals) for (const c of vals) totals.add(a + b + c);
  return totals;
}
const POSSIBLE = possibleVisitScores();
function isCheckoutNumber(value) { return value > 1 && value <= 170 && ![159, 162, 163, 165, 166, 168, 169].includes(value); }
function dartScore(dart) { if (dart.value === "BULL") return dart.multiplier === "D" ? 50 : 25; if (dart.value === 0) return 0; return dart.value * (dart.multiplier === "T" ? 3 : dart.multiplier === "D" ? 2 : 1); }
function totalDarts() { return state.darts.reduce((sum, dart) => sum + dartScore(dart), 0); }
function dartLabel(dart) { if (!dart) return "—"; if (dart.value === 0) return "MISS"; if (dart.value === "BULL") return dart.multiplier === "D" ? "BULL" : "25"; return `${dart.multiplier === "S" ? "" : dart.multiplier}${dart.value}`; }
function isDoubleOut() { const last = [...state.darts].reverse().find((dart) => dart.value !== 0); return Boolean(last && last.multiplier === "D"); }
function renderInput() {
  el.sumModeButton.classList.toggle("active", state.inputMode === "sum"); el.dartModeButton.classList.toggle("active", state.inputMode === "per_dart"); el.sumMode.classList.toggle("hidden", state.inputMode !== "sum"); el.dartMode.classList.toggle("hidden", state.inputMode !== "per_dart");
  const score = Number(state.sumValue || 0), after = currentRemaining() - score; el.sumDisplay.textContent = state.sumValue || "—";
  if (!state.sumValue) el.sumHint.textContent = "Trykk Lagre kast for 0";
  else if (!POSSIBLE.has(score)) el.sumHint.textContent = "Ugyldig sum med tre piler";
  else if (after === 0 && isCheckoutNumber(currentRemaining())) el.sumHint.textContent = "Checkout";
  else if (score > 180 || after < 0 || after === 1 || after === 0) el.sumHint.textContent = "Bust";
  else el.sumHint.textContent = `Gjenstår ${after}`;
  el.dart1.textContent = `Pil 1: ${dartLabel(state.darts[0])}`; el.dart2.textContent = `Pil 2: ${dartLabel(state.darts[1])}`; el.dart3.textContent = `Pil 3: ${dartLabel(state.darts[2])}`; el.dartTotal.textContent = String(totalDarts());
  el.dartSubmitButton.textContent = state.darts.length ? "Lagre kast" : "Lagre kast · 0";
  document.querySelectorAll("[data-multiplier]").forEach((button) => button.classList.toggle("active", button.dataset.multiplier === state.multiplier));
}
function resetInput() { state.sumValue = ""; state.darts = []; state.multiplier = "S"; renderInput(); }

async function ensurePairingRequest({ forceNew = false } = {}) {
  if (state.kioskCode) return;
  if (forceNew) {
    state.pairingToken = newDeviceToken();
    localStorage.setItem("bd:kioskPairingToken", state.pairingToken);
    persistRequest("");
  }
  ensureToken();
  if (state.pairingRequestCode && !forceNew) return;
  render();
  const data = await pairingApi("create", {
    method: "POST",
    body: { device_name: `Board Terminal · ${navigator.platform || "nettbrett"}` },
  });
  persistRequest(data.request.request_code, data.request.expires_at || "");
  render();
}
async function checkPairing() {
  if (!state.pairingRequestCode) return;
  try {
    const data = await api(`/kiosk-pairing-requests/${encodeURIComponent(state.pairingRequestCode)}`);
    if (data.status === "approved" && data.kiosk?.code) {
      persistPairing(data.kiosk.code);
      state.snapshot = data.snapshot || null;
      state.renderedView = "";
      render();
      await startLive();
      showToast(`Terminalen er koblet til ${data.kiosk.name || data.kiosk.code}.`);
    }
  } catch (error) {
    if ([404, 409, 410].includes(Number(error.status))) {
      persistRequest("");
      await ensurePairingRequest({ forceNew: true });
      return;
    }
    throw error;
  }
}
async function loadState() {
  if (!state.kioskCode) return;
  try { state.snapshot = await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/state`); render(); }
  catch (error) {
    if ([401, 403, 404].includes(Number(error.status))) {
      clearLocalPairing({ newToken: true });
      await ensurePairingRequest();
      render();
      showToast("Pairingen er ikke lenger gyldig. Ny pairingkode er laget.");
      return;
    }
    throw error;
  }
}
async function startMatch() { state.mutating = true; el.startMatchButton.disabled = true; try { state.snapshot = await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/start-match`, { method: "POST" }); resetInput(); render(); } finally { state.mutating = false; } }
async function undo() { state.mutating = true; try { state.snapshot = await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/undo`, { method: "POST" }); resetInput(); render(); } finally { state.mutating = false; } }

function requestCheckoutDarts() {
  return new Promise((resolve) => {
    el.checkoutDialog.showModal();
    const handler = (event) => { const button = event.target.closest("[data-darts-used]"); if (!button) return; el.checkoutDialog.close(); el.checkoutDialog.removeEventListener("click", handler); resolve(Number(button.dataset.dartsUsed)); };
    el.checkoutDialog.addEventListener("click", handler);
  });
}
async function submitSum() {
  if (!isManual() || state.mutating) return;
  const score = Number(state.sumValue || 0);
  if (!Number.isFinite(score) || score < 0 || !POSSIBLE.has(score)) { showToast("Ugyldig score."); return; }
  const checkout = currentRemaining() - score === 0 && isCheckoutNumber(currentRemaining());
  const dartsUsed = checkout ? await requestCheckoutDarts() : 3;
  state.mutating = true;
  try { state.snapshot = await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/visit`, { method: "POST", body: { score, darts_used: dartsUsed, input_mode: "sum" } }); resetInput(); render(); }
  catch (error) {
    if (error.code === "match_not_available") await loadState().catch(() => undefined);
    showToast(error.message);
  }
  finally { state.mutating = false; }
}
async function submitDarts() {
  if (!isManual() || state.mutating) return;
  const score = totalDarts(), checkout = state.darts.length > 0 && currentRemaining() - score === 0 && isDoubleOut();
  const darts = state.darts.slice();
  while (!checkout && darts.length < 3) darts.push({ multiplier: "S", value: 0 });
  state.mutating = true;
  try { state.snapshot = await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/visit`, { method: "POST", body: { input_mode: "per_dart", darts_used: checkout ? state.darts.length : 3, darts } }); resetInput(); render(); }
  catch (error) {
    if (error.code === "match_not_available") await loadState().catch(() => undefined);
    showToast(error.message);
  }
  finally { state.mutating = false; }
}

function startPolling() {
  clearInterval(state.pollHandle);
  state.pollHandle = setInterval(() => {
    if (state.mutating) return;
    if (state.kioskCode) loadState().catch(() => undefined);
    else if (state.pairingRequestCode) checkPairing().catch(() => undefined);
  }, 1500);
}
async function realtimeConfig() {
  if (state.realtime) return state.realtime;
  try { state.realtime = await api("/realtime/config"); }
  catch { state.realtime = { enabled: false }; }
  return state.realtime;
}
function closeLive() {
  if (state.socket) { const socket = state.socket; state.socket = null; socket.close(); }
  if (state.liveSource) { state.liveSource.close(); state.liveSource = null; }
  clearTimeout(state.reconnectHandle);
  clearInterval(state.pollHandle);
  state.pollHandle = null;
}
function startSseLive() {
  if (!state.kioskCode) { startPolling(); return; }
  if (typeof EventSource !== "function") { startPolling(); return; }
  const url = `${API_ROOT}/kiosks/${encodeURIComponent(state.kioskCode)}/live?pairing_token=${encodeURIComponent(state.pairingToken)}`;
  const source = new EventSource(url); state.liveSource = source;
  source.addEventListener("snapshot", (event) => { if (state.mutating) return; try { state.snapshot = JSON.parse(event.data); render(); } catch {} });
  source.onerror = () => {
    if (state.liveSource !== source) return;
    state.liveSource = null;
    source.close();
    startPolling();
    clearTimeout(state.reconnectHandle);
    state.reconnectHandle = setTimeout(() => startLive().catch(() => undefined), 2500);
  };
}
async function startLive() {
  closeLive();
  if (!state.kioskCode) { startPolling(); return; }
  const config = await realtimeConfig();
  if (!config?.enabled || !config.websocket_url || typeof WebSocket !== "function") { startSseLive(); return; }
  try {
    const socket = new WebSocket(config.websocket_url);
    state.socket = socket;
    socket.addEventListener("open", () => {
      if (state.socket !== socket) return;
      const channels = [`kiosk:${state.kioskCode}`];
      const clubId = Number(currentKiosk()?.club?.id || 0);
      if (clubId > 0) channels.push(`club:${clubId}`);
      socket.send(JSON.stringify({ type: "subscribe", channels }));
    });
    socket.addEventListener("message", (event) => {
      if (state.mutating) return;
      try {
        const message = JSON.parse(event.data);
        if (message?.type === "event" && message?.event === "snapshot" && message?.payload) {
          if (message.payload.refresh === true) {
            loadState().catch(() => undefined);
            return;
          }
          state.snapshot = message.payload;
          render();
        }
      } catch {}
    });
    socket.addEventListener("close", () => {
      if (state.socket !== socket) return;
      state.socket = null;
      startSseLive();
      clearTimeout(state.reconnectHandle);
      state.reconnectHandle = setTimeout(() => startLive().catch(() => undefined), 2500);
    });
    socket.addEventListener("error", () => socket.close());
  } catch { startSseLive(); }
}

function renderSettings() {
  const kiosk = currentKiosk();
  el.settingsMeta.innerHTML = kiosk
    ? `<div><span>Klubb</span><strong>${escapeHtml(kiosk.club?.name || "—")}</strong></div><div><span>Board</span><strong>${escapeHtml(kiosk.name || kiosk.code)}</strong></div><div><span>Scoring</span><strong>${kiosk.scoring_mode === "scolia" ? "Scolia" : "Manuell"}</strong></div><div><span>Enhet</span><strong>${escapeHtml(kiosk.paired_device_name || "Dette nettbrettet")}</strong></div>`
    : `<div><span>Status</span><strong>${state.pairingRequestCode ? `Venter på pairingkode ${escapeHtml(state.pairingRequestCode)}` : "Ikke satt opp"}</strong></div>`;
  el.unpairButton.classList.toggle("hidden", !state.kioskCode);
}
function openSettings() { renderSettings(); el.settingsOverlay.classList.remove("hidden"); el.settingsDialog.classList.remove("hidden"); }
function closeSettings() { el.settingsOverlay.classList.add("hidden"); el.settingsDialog.classList.add("hidden"); }
async function resetTerminal() {
  if (state.kioskCode) {
    try { await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/unpair`, { method: "POST" }); } catch {}
  }
  closeLive();
  clearLocalPairing({ newToken: true });
  closeSettings();
  await ensurePairingRequest();
  render();
  startPolling();
  showToast("Terminalen er nullstilt. Ny pairingkode er laget.");
}

function renderNumberGrid() { el.numberGrid.innerHTML = Array.from({ length: 20 }, (_, i) => 20 - i).map((value) => `<button type="button" data-number="${value}">${value}</button>`).join(""); }
function bindEvents() {
  el.newPairingButton.addEventListener("click", () => ensurePairingRequest({ forceNew: true }).then(() => startPolling()).catch((error) => showToast(error.message)));
  el.startMatchButton.addEventListener("click", () => startMatch().catch((error) => showToast(error.message)));
  el.undoButton.addEventListener("click", () => undo().catch((error) => showToast(error.message)));
  el.sumModeButton.addEventListener("click", () => { state.inputMode = "sum"; localStorage.setItem("bd:kioskInputMode", state.inputMode); renderInput(); });
  el.dartModeButton.addEventListener("click", () => { state.inputMode = "per_dart"; localStorage.setItem("bd:kioskInputMode", state.inputMode); renderInput(); });
  document.querySelectorAll("[data-key]").forEach((button) => button.addEventListener("click", () => { const key = button.dataset.key; if (key === "del") state.sumValue = state.sumValue.slice(0, -1); else if (key === "ok") { submitSum(); return; } else if (state.sumValue.length < 3) state.sumValue += key; renderInput(); }));
  document.querySelectorAll("[data-multiplier]").forEach((button) => button.addEventListener("click", () => { state.multiplier = button.dataset.multiplier; renderInput(); }));
  el.numberGrid.addEventListener("click", (event) => { const button = event.target.closest("[data-number]"); if (!button || state.darts.length >= 3) return; state.darts.push({ multiplier: state.multiplier, value: Number(button.dataset.number) }); state.multiplier = "S"; renderInput(); });
  document.querySelectorAll("[data-special]").forEach((button) => button.addEventListener("click", () => { if (state.darts.length >= 3) return; const special = button.dataset.special; state.darts.push(special === "miss" ? { multiplier: "S", value: 0 } : { multiplier: special === "dbull" ? "D" : "S", value: "BULL" }); renderInput(); }));
  el.dartBackButton.addEventListener("click", () => { state.darts.pop(); renderInput(); });
  el.dartSubmitButton.addEventListener("click", submitDarts);
  el.settingsButton.addEventListener("click", openSettings); el.settingsCloseButton.addEventListener("click", closeSettings); el.settingsOverlay.addEventListener("click", closeSettings);
  el.refreshButton.addEventListener("click", () => (state.kioskCode ? loadState() : checkPairing()).then(() => { closeSettings(); showToast("Oppdatert."); }).catch((error) => showToast(error.message)));
  el.unpairButton.addEventListener("click", () => resetTerminal().catch((error) => showToast(error.message)));
  el.resetTerminalButton.addEventListener("click", () => resetTerminal().catch((error) => showToast(error.message)));
}

async function boot() {
  localStorage.removeItem("bd:kioskClub");
  renderNumberGrid();
  bindEvents();
  applyBranding();
  ensureToken();

  if (!state.kioskCode) {
    render();
    try {
      await ensurePairingRequest();
      await checkPairing();
    } catch (error) {
      showToast(error.message);
    }
    startPolling();
    return;
  }

  try { await loadState(); await startLive(); }
  catch (error) { render(); showToast(error.message); }
}

boot();