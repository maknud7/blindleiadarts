const API_ROOT = "../api/v1";

const state = {
  kioskCode: localStorage.getItem("bd:kioskCode") || "",
  pairingToken: localStorage.getItem("bd:kioskPairingToken") || "",
  pairingRequestCode: localStorage.getItem("bd:kioskPairingRequestCode") || "",
  connectedClub: (() => { try { return JSON.parse(localStorage.getItem("bd:kioskClub") || "null"); } catch { return null; } })(),
  snapshot: null,
  pollHandle: null,
  liveSource: null,
  reconnectHandle: null,
  inputMode: localStorage.getItem("bd:kioskInputMode") || "sum",
  sumValue: "",
  darts: [],
  multiplier: "S",
  mutating: false,
  toastHandle: null,
};

const el = {
  brandLogo: document.getElementById("brandLogo"), brandFallback: document.getElementById("brandFallback"), brandEyebrow: document.getElementById("brandEyebrow"), brandTitle: document.getElementById("brandTitle"),
  connectionPill: document.getElementById("connectionPill"), connectionText: document.getElementById("connectionText"), settingsButton: document.getElementById("settingsButton"),
  setupState: document.getElementById("setupState"), clubStep: document.getElementById("clubStep"), pairStep: document.getElementById("pairStep"), clubConnectCode: document.getElementById("clubConnectCode"), connectClubButton: document.getElementById("connectClubButton"),
  pairInstruction: document.getElementById("pairInstruction"), startPairingButton: document.getElementById("startPairingButton"), pairingCard: document.getElementById("pairingCard"), pairingCode: document.getElementById("pairingCode"),
  idleState: document.getElementById("idleState"), idleClub: document.getElementById("idleClub"), idleBoard: document.getElementById("idleBoard"), idleMessage: document.getElementById("idleMessage"), idleMode: document.getElementById("idleMode"),
  assignedState: document.getElementById("assignedState"), assignedBoard: document.getElementById("assignedBoard"), assignedRound: document.getElementById("assignedRound"), assignedBestOf: document.getElementById("assignedBestOf"), assignedPlayerA: document.getElementById("assignedPlayerA"), assignedPlayerB: document.getElementById("assignedPlayerB"), startMatchButton: document.getElementById("startMatchButton"),
  matchState: document.getElementById("matchState"), playerABox: document.getElementById("playerABox"), playerBBox: document.getElementById("playerBBox"), playerATurn: document.getElementById("playerATurn"), playerBTurn: document.getElementById("playerBTurn"), playerAName: document.getElementById("playerAName"), playerBName: document.getElementById("playerBName"), playerARemaining: document.getElementById("playerARemaining"), playerBRemaining: document.getElementById("playerBRemaining"), playerALegs: document.getElementById("playerALegs"), playerBLegs: document.getElementById("playerBLegs"), matchBoard: document.getElementById("matchBoard"), currentLeg: document.getElementById("currentLeg"), matchRound: document.getElementById("matchRound"), undoButton: document.getElementById("undoButton"),
  manualScoring: document.getElementById("manualScoring"), scoliaScoring: document.getElementById("scoliaScoring"), throwingPlayer: document.getElementById("throwingPlayer"), sumModeButton: document.getElementById("sumModeButton"), dartModeButton: document.getElementById("dartModeButton"), sumMode: document.getElementById("sumMode"), dartMode: document.getElementById("dartMode"), sumDisplay: document.getElementById("sumDisplay"), sumHint: document.getElementById("sumHint"),
  dart1: document.getElementById("dart1"), dart2: document.getElementById("dart2"), dart3: document.getElementById("dart3"), dartTotal: document.getElementById("dartTotal"), numberGrid: document.getElementById("numberGrid"), dartBackButton: document.getElementById("dartBackButton"), dartSubmitButton: document.getElementById("dartSubmitButton"), recentVisits: document.getElementById("recentVisits"),
  settingsOverlay: document.getElementById("settingsOverlay"), settingsDialog: document.getElementById("settingsDialog"), settingsCloseButton: document.getElementById("settingsCloseButton"), settingsMeta: document.getElementById("settingsMeta"), refreshButton: document.getElementById("refreshButton"), unpairButton: document.getElementById("unpairButton"), changeClubButton: document.getElementById("changeClubButton"),
  checkoutDialog: document.getElementById("checkoutDialog"), toast: document.getElementById("toast"),
};

async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (state.pairingToken) headers["X-Kiosk-Pairing-Token"] = state.pairingToken;
  const response = await fetch(`${API_ROOT}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: "no-store" });
  let payload = null; try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok || !payload?.ok) { const error = new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`); error.status = response.status; throw error; }
  return payload.data;
}

function showToast(message) { clearTimeout(state.toastHandle); el.toast.textContent = message; el.toast.classList.remove("hidden"); state.toastHandle = setTimeout(() => el.toast.classList.add("hidden"), 2600); }
function ensureToken() { if (!state.pairingToken) state.pairingToken = crypto?.randomUUID ? crypto.randomUUID() : `board-${Date.now()}-${Math.random().toString(16).slice(2)}`; localStorage.setItem("bd:kioskPairingToken", state.pairingToken); return state.pairingToken; }
function persistClub(club) { state.connectedClub = club; club ? localStorage.setItem("bd:kioskClub", JSON.stringify(club)) : localStorage.removeItem("bd:kioskClub"); }
function persistRequest(code) { state.pairingRequestCode = code || ""; code ? localStorage.setItem("bd:kioskPairingRequestCode", code) : localStorage.removeItem("bd:kioskPairingRequestCode"); }
function persistPairing(code) { state.kioskCode = code; localStorage.setItem("bd:kioskCode", code); persistRequest(""); }
function clearPairingLocal() { state.kioskCode = ""; localStorage.removeItem("bd:kioskCode"); persistRequest(""); state.snapshot = null; }
function clearEverything() { closeLive(); clearPairingLocal(); persistClub(null); state.pairingToken = ""; localStorage.removeItem("bd:kioskPairingToken"); state.sumValue = ""; state.darts = []; }

function currentKiosk() { return state.snapshot?.kiosk || null; }
function currentMatch() { return state.snapshot?.match || null; }
function currentPlayer() { const m = currentMatch(); if (!m) return null; return m.current_player_id === m.player_a.id ? m.player_a : m.player_b; }
function currentRemaining() { return Number(currentPlayer()?.remaining || 0); }
function isManual() { return (currentKiosk()?.scoring_mode || "manual") === "manual"; }
function roundLabel(match) { return match?.round_label || match?.bracket_label || "Kamp"; }

function setConnection(text, tone = "neutral") { el.connectionText.textContent = text; el.connectionPill.className = `status-pill ${tone}`; }
function applyBranding() {
  const kiosk = currentKiosk(), club = kiosk?.club || state.connectedClub;
  const initials = String(club?.name || "BD").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  el.brandFallback.textContent = initials || "BD"; el.brandEyebrow.textContent = club?.name || "Blindleia Darts"; el.brandTitle.textContent = kiosk ? (kiosk.name || `Board ${kiosk.board_number}`) : "Board Terminal";
  if (club?.logo_url) { el.brandLogo.src = club.logo_url; el.brandLogo.classList.remove("hidden"); el.brandFallback.classList.add("hidden"); el.brandLogo.onerror = () => { el.brandLogo.classList.add("hidden"); el.brandFallback.classList.remove("hidden"); }; }
  else { el.brandLogo.classList.add("hidden"); el.brandFallback.classList.remove("hidden"); }
}
function hideStates() { [el.setupState, el.idleState, el.assignedState, el.matchState].forEach((node) => node.classList.add("hidden")); }

function renderSetup() {
  hideStates(); el.setupState.classList.remove("hidden"); applyBranding(); setConnection(state.connectedClub ? "Venter på pairing" : "Ikke satt opp", "neutral");
  const hasClub = Boolean(state.connectedClub?.id); el.clubStep.classList.toggle("done-step", hasClub); el.pairStep.classList.toggle("disabled-step", !hasClub); el.startPairingButton.disabled = !hasClub || Boolean(state.pairingRequestCode);
  if (hasClub) { el.clubConnectCode.value = state.connectedClub.kiosk_pairing_code || ""; el.pairInstruction.textContent = `Koblet til ${state.connectedClub.name}. Start pairing og godkjenn nettbrettet i Admin.`; }
  else { el.pairInstruction.textContent = "Koble til klubben først."; }
  if (state.pairingRequestCode) { el.pairingCard.classList.remove("hidden"); el.pairingCode.textContent = state.pairingRequestCode; } else { el.pairingCard.classList.add("hidden"); el.pairingCode.textContent = "—"; }
  renderSettings();
}
function renderIdle() {
  const kiosk = currentKiosk(); hideStates(); el.idleState.classList.remove("hidden"); applyBranding(); setConnection(`Board ${kiosk.board_number} · klar`, "good");
  el.idleClub.textContent = kiosk.club?.name || "Blindleia Dartklubb"; el.idleBoard.textContent = kiosk.name || `Board ${kiosk.board_number}`; el.idleMessage.textContent = "Venter på at Blindleia tildeler neste kamp."; el.idleMode.textContent = kiosk.scoring_mode === "scolia" ? "Scolia scoring" : "Manuell scoring"; renderSettings();
}
function renderAssigned() {
  const kiosk = currentKiosk(), match = currentMatch(); hideStates(); el.assignedState.classList.remove("hidden"); applyBranding(); setConnection(`Board ${kiosk.board_number} · kamp klar`, "good");
  el.assignedBoard.textContent = `Board ${kiosk.board_number}`; el.assignedRound.textContent = roundLabel(match); el.assignedBestOf.textContent = `Best of ${match.best_of_legs}`; el.assignedPlayerA.textContent = match.player_a.display_name; el.assignedPlayerB.textContent = match.player_b.display_name; el.startMatchButton.disabled = state.mutating; renderSettings();
}
function renderVisits() {
  const visits = currentMatch()?.recent_visits || [];
  el.recentVisits.innerHTML = visits.length ? visits.map((visit) => `<div class="visit-row"><div><strong>${escapeHtml(visit.player_name)}</strong><span>#${Number(visit.visit_number || 0)}</span></div><div><strong class="visit-score">${Number(visit.score || 0)}</strong><span>${Number(visit.is_bust) === 1 ? "Bust" : `→ ${Number(visit.remaining_after ?? 0)}`}</span></div></div>`).join("") : `<div class="empty-visits">Ingen kast registrert ennå.</div>`;
}
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function renderMatch() {
  const kiosk = currentKiosk(), match = currentMatch(), player = currentPlayer(); hideStates(); el.matchState.classList.remove("hidden"); applyBranding(); setConnection(`Board ${kiosk.board_number} · live`, "good");
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
  const singles = new Set([0,25,50]); for (let i=1;i<=20;i+=1) { singles.add(i); singles.add(i*2); singles.add(i*3); }
  const vals = [...singles], totals = new Set(); for (const a of vals) for (const b of vals) for (const c of vals) totals.add(a+b+c); return totals;
}
const POSSIBLE = possibleVisitScores();
function isCheckoutNumber(value) { return value > 1 && value <= 170 && ![159,162,163,165,166,168,169].includes(value); }
function dartScore(dart) { if (dart.value === "BULL") return dart.multiplier === "D" ? 50 : 25; if (dart.value === 0) return 0; return dart.value * (dart.multiplier === "T" ? 3 : dart.multiplier === "D" ? 2 : 1); }
function totalDarts() { return state.darts.reduce((sum,dart) => sum + dartScore(dart),0); }
function dartLabel(dart) { if (!dart) return "—"; if (dart.value === 0) return "MISS"; if (dart.value === "BULL") return dart.multiplier === "D" ? "BULL" : "25"; return `${dart.multiplier === "S" ? "" : dart.multiplier}${dart.value}`; }
function isDoubleOut() { const last = [...state.darts].reverse().find((dart) => dart.value !== 0); return Boolean(last && last.multiplier === "D"); }

function renderInput() {
  el.sumModeButton.classList.toggle("active", state.inputMode === "sum"); el.dartModeButton.classList.toggle("active", state.inputMode === "per_dart"); el.sumMode.classList.toggle("hidden", state.inputMode !== "sum"); el.dartMode.classList.toggle("hidden", state.inputMode !== "per_dart");
  const score = Number(state.sumValue || 0), after = currentRemaining() - score; el.sumDisplay.textContent = state.sumValue || "—";
  if (!state.sumValue) el.sumHint.textContent = "Tast total score";
  else if (!POSSIBLE.has(score)) el.sumHint.textContent = "Ugyldig sum med tre piler";
  else if (after === 0 && isCheckoutNumber(currentRemaining())) el.sumHint.textContent = "Checkout";
  else if (score > 180 || after < 0 || after === 1 || after === 0) el.sumHint.textContent = "Bust";
  else el.sumHint.textContent = `Gjenstår ${after}`;
  el.dart1.textContent = `Pil 1: ${dartLabel(state.darts[0])}`; el.dart2.textContent = `Pil 2: ${dartLabel(state.darts[1])}`; el.dart3.textContent = `Pil 3: ${dartLabel(state.darts[2])}`; el.dartTotal.textContent = String(totalDarts());
  document.querySelectorAll("[data-multiplier]").forEach((button) => button.classList.toggle("active", button.dataset.multiplier === state.multiplier));
}
function resetInput() { state.sumValue = ""; state.darts = []; state.multiplier = "S"; renderInput(); }

async function connectClub() {
  const code = el.clubConnectCode.value.trim().toUpperCase(); if (!code) throw new Error("Skriv inn klubbkoden.");
  const data = await api("/public/kiosk/connect", { method: "POST", body: { code } }); persistClub(data.club); ensureToken(); render(); showToast(`Koblet til ${data.club.name}.`);
}
async function startPairing() {
  if (!state.connectedClub?.id) throw new Error("Koble til klubben først."); ensureToken();
  const data = await api("/kiosk-pairing-requests", { method: "POST", body: { club_id: state.connectedClub.id, device_name: `Board-terminal ${navigator.platform || "nettbrett"}` } }); persistRequest(data.request.request_code); render(); startPolling();
}
async function checkPairing() {
  if (!state.pairingRequestCode) return;
  const data = await api(`/kiosk-pairing-requests/${encodeURIComponent(state.pairingRequestCode)}`);
  if (data.status === "approved" && data.kiosk?.code) { persistPairing(data.kiosk.code); state.snapshot = data.snapshot || null; render(); await startLive(); showToast(`Paret mot ${data.kiosk.name || data.kiosk.code}.`); }
}
async function loadState() {
  if (!state.kioskCode) return;
  try { state.snapshot = await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/state`); render(); }
  catch (error) { if ([401,403,404].includes(Number(error.status))) { clearPairingLocal(); render(); showToast("Pairingen er ikke lenger gyldig. Pair nettbrettet på nytt."); return; } throw error; }
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
  if (!isManual() || state.mutating) return; const score = Number(state.sumValue || 0); if (!Number.isFinite(score) || score < 0 || !POSSIBLE.has(score)) { showToast("Ugyldig score."); return; }
  const checkout = currentRemaining() - score === 0 && isCheckoutNumber(currentRemaining()); const dartsUsed = checkout ? await requestCheckoutDarts() : 3;
  state.mutating = true; try { state.snapshot = await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/visit`, { method: "POST", body: { score, darts_used: dartsUsed, input_mode: "sum" } }); resetInput(); render(); } catch (error) { showToast(error.message); } finally { state.mutating = false; }
}
async function submitDarts() {
  if (!isManual() || !state.darts.length || state.mutating) return; const score = totalDarts(), checkout = currentRemaining() - score === 0 && isDoubleOut(); const darts = state.darts.slice(); while (!checkout && darts.length < 3) darts.push({ multiplier: "S", value: 0 });
  state.mutating = true; try { state.snapshot = await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/visit`, { method: "POST", body: { input_mode: "per_dart", darts_used: checkout ? state.darts.length : 3, darts } }); resetInput(); render(); } catch (error) { showToast(error.message); } finally { state.mutating = false; }
}

function startPolling() {
  clearInterval(state.pollHandle); state.pollHandle = setInterval(() => { if (state.mutating) return; if (state.kioskCode) loadState().catch(() => undefined); else if (state.pairingRequestCode) checkPairing().catch(() => undefined); }, 1500);
}
function closeLive() { if (state.liveSource) { state.liveSource.close(); state.liveSource = null; } clearTimeout(state.reconnectHandle); clearInterval(state.pollHandle); state.pollHandle = null; }
async function startLive() {
  closeLive(); if (!state.kioskCode) { startPolling(); return; }
  if (typeof EventSource !== "function") { startPolling(); return; }
  const url = `${API_ROOT}/kiosks/${encodeURIComponent(state.kioskCode)}/live?pairing_token=${encodeURIComponent(state.pairingToken)}`; const source = new EventSource(url); state.liveSource = source;
  source.addEventListener("snapshot", (event) => { if (state.mutating) return; try { state.snapshot = JSON.parse(event.data); render(); } catch {} });
  source.onerror = () => { if (state.liveSource === source) state.liveSource = null; source.close(); startPolling(); clearTimeout(state.reconnectHandle); state.reconnectHandle = setTimeout(() => startLive().catch(() => undefined), 2500); };
}

function renderSettings() {
  const kiosk = currentKiosk(); el.settingsMeta.innerHTML = kiosk ? `<div><span>Klubb</span><strong>${escapeHtml(kiosk.club?.name || "—")}</strong></div><div><span>Board</span><strong>${escapeHtml(kiosk.name || kiosk.code)}</strong></div><div><span>Scoring</span><strong>${kiosk.scoring_mode === "scolia" ? "Scolia" : "Manuell"}</strong></div><div><span>Enhet</span><strong>${escapeHtml(kiosk.paired_device_name || "Dette nettbrettet")}</strong></div>` : `<div><span>Status</span><strong>${state.connectedClub ? `Koblet til ${escapeHtml(state.connectedClub.name)}` : "Ikke satt opp"}</strong></div>`;
  el.unpairButton.classList.toggle("hidden", !state.kioskCode); el.changeClubButton.classList.toggle("hidden", !state.connectedClub);
}
function openSettings() { renderSettings(); el.settingsOverlay.classList.remove("hidden"); el.settingsDialog.classList.remove("hidden"); }
function closeSettings() { el.settingsOverlay.classList.add("hidden"); el.settingsDialog.classList.add("hidden"); }
async function unpair() { if (state.kioskCode) { try { await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/unpair`, { method: "POST" }); } catch {} } clearPairingLocal(); closeLive(); closeSettings(); render(); showToast("Pairing fjernet."); }

function renderNumberGrid() { el.numberGrid.innerHTML = Array.from({ length: 20 }, (_, i) => 20 - i).map((value) => `<button type="button" data-number="${value}">${value}</button>`).join(""); }
function bindEvents() {
  el.connectClubButton.addEventListener("click", () => connectClub().catch((error) => showToast(error.message)));
  el.startPairingButton.addEventListener("click", () => startPairing().catch((error) => showToast(error.message)));
  el.startMatchButton.addEventListener("click", () => startMatch().catch((error) => showToast(error.message)));
  el.undoButton.addEventListener("click", () => undo().catch((error) => showToast(error.message)));
  el.sumModeButton.addEventListener("click", () => { state.inputMode = "sum"; localStorage.setItem("bd:kioskInputMode", state.inputMode); renderInput(); });
  el.dartModeButton.addEventListener("click", () => { state.inputMode = "per_dart"; localStorage.setItem("bd:kioskInputMode", state.inputMode); renderInput(); });
  document.querySelectorAll("[data-key]").forEach((button) => button.addEventListener("click", () => { const key = button.dataset.key; if (key === "del") state.sumValue = state.sumValue.slice(0,-1); else if (key === "ok") { submitSum(); return; } else if (state.sumValue.length < 3) state.sumValue += key; renderInput(); }));
  document.querySelectorAll("[data-multiplier]").forEach((button) => button.addEventListener("click", () => { state.multiplier = button.dataset.multiplier; renderInput(); }));
  el.numberGrid.addEventListener("click", (event) => { const button = event.target.closest("[data-number]"); if (!button || state.darts.length >= 3) return; state.darts.push({ multiplier: state.multiplier, value: Number(button.dataset.number) }); state.multiplier = "S"; renderInput(); });
  document.querySelectorAll("[data-special]").forEach((button) => button.addEventListener("click", () => { if (state.darts.length >= 3) return; const special = button.dataset.special; state.darts.push(special === "miss" ? { multiplier: "S", value: 0 } : { multiplier: special === "dbull" ? "D" : "S", value: "BULL" }); renderInput(); }));
  el.dartBackButton.addEventListener("click", () => { state.darts.pop(); renderInput(); }); el.dartSubmitButton.addEventListener("click", submitDarts);
  el.settingsButton.addEventListener("click", openSettings); el.settingsCloseButton.addEventListener("click", closeSettings); el.settingsOverlay.addEventListener("click", closeSettings);
  el.refreshButton.addEventListener("click", () => (state.kioskCode ? loadState() : checkPairing()).then(() => { closeSettings(); showToast("Oppdatert."); }).catch((error) => showToast(error.message)));
  el.unpairButton.addEventListener("click", unpair); el.changeClubButton.addEventListener("click", () => { clearEverything(); closeSettings(); render(); showToast("Oppsettet er nullstilt."); });
}

async function boot() {
  renderNumberGrid(); bindEvents(); applyBranding();
  if (state.connectedClub?.kiosk_pairing_code) el.clubConnectCode.value = state.connectedClub.kiosk_pairing_code;
  if (!state.kioskCode) { render(); if (state.pairingRequestCode) { await checkPairing().catch(() => undefined); startPolling(); } return; }
  ensureToken();
  try { await loadState(); await startLive(); } catch (error) { render(); showToast(error.message); }
}
boot();
