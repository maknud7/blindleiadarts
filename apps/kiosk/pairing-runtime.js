const renewButton = document.getElementById("newPairingButton");
const RENEW_URL = "../api/kiosk-pairing-renew.php";
const PREFERENCE_URL = "../api/kiosk-player-preference.php";
const DEADLINE_KEY = "bd:kioskPairingLocalDeadline";

const sumModeButton = document.getElementById("sumModeButton");
const dartModeButton = document.getElementById("dartModeButton");
const throwingPlayer = document.getElementById("throwingPlayer");

let applyingPlayerPreference = false;
let preferenceSyncBusy = false;
let preferenceSyncQueued = false;
let preferenceSyncTimer = null;
let lastPreferenceSyncAt = 0;

function currentCode() { return localStorage.getItem("bd:kioskPairingRequestCode") || ""; }
function currentToken() { return localStorage.getItem("bd:kioskPairingToken") || ""; }
function kioskCode() { return localStorage.getItem("bd:kioskCode") || ""; }
function paired() { return Boolean(kioskCode()); }

function ensureLocalDeadline() {
  const code = currentCode();
  if (!code || paired()) {
    localStorage.removeItem(DEADLINE_KEY);
    return 0;
  }

  const marker = `${code}:`;
  const stored = localStorage.getItem(DEADLINE_KEY) || "";
  if (stored.startsWith(marker)) return Number(stored.slice(marker.length)) || 0;

  const deadline = Date.now() + (30 * 60 * 1000);
  localStorage.setItem(DEADLINE_KEY, `${marker}${deadline}`);
  return deadline;
}

async function renewPairingCode() {
  const code = currentCode();
  const token = currentToken();
  if (!code || !token || paired()) return;

  renewButton.disabled = true;
  try {
    const response = await fetch(RENEW_URL, {
      method: "POST",
      headers: { "X-Kiosk-Pairing-Token": token },
      cache: "no-store",
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || "Kunne ikke fornye pairingkoden.");

    const request = payload.data?.request || {};
    localStorage.setItem("bd:kioskPairingRequestCode", request.request_code || "");
    localStorage.setItem("bd:kioskPairingExpires", request.expires_at || "");
    localStorage.removeItem(DEADLINE_KEY);
    window.location.reload();
  } catch (error) {
    renewButton.disabled = false;
    renewButton.textContent = error.message || "Prøv igjen";
    setTimeout(() => { renewButton.textContent = "Lag ny kode"; }, 2500);
  }
}

async function readPlayerPreference({ apply = true } = {}) {
  const code = kioskCode();
  const token = currentToken();
  if (!code || !token) return null;

  const url = new URL(PREFERENCE_URL, window.location.href);
  url.searchParams.set("kiosk_code", code);

  const response = await fetch(url, {
    headers: { "X-Kiosk-Pairing-Token": token },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) return null;

  const data = payload.data || {};
  if (apply && data.current_player_id) {
    const current = (data.players || []).find((player) => Number(player.id) === Number(data.current_player_id));
    const preferredMode = current?.preferred_input_mode === "per_dart" ? "per_dart" : "sum";
    applyPreferredMode(preferredMode);
  }

  return data;
}

function applyPreferredMode(mode) {
  const button = mode === "per_dart" ? dartModeButton : sumModeButton;
  if (!button || button.classList.contains("active")) return;

  applyingPlayerPreference = true;
  try {
    button.click();
  } finally {
    applyingPlayerPreference = false;
  }
}

async function savePlayerPreference(mode) {
  if (applyingPlayerPreference || !paired()) return;

  const data = await readPlayerPreference({ apply: false });
  const playerId = Number(data?.current_player_id || 0);
  if (!playerId) return;

  const code = kioskCode();
  const token = currentToken();
  const response = await fetch(PREFERENCE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Kiosk-Pairing-Token": token,
    },
    body: JSON.stringify({
      kiosk_code: code,
      player_id: playerId,
      preferred_input_mode: mode,
    }),
    cache: "no-store",
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) return;

  const returned = payload.data || {};
  if (Number(returned.current_player_id || 0) === playerId) applyPreferredMode(mode);
}

async function syncPlayerPreference() {
  if (!paired() || preferenceSyncBusy) {
    if (paired()) preferenceSyncQueued = true;
    return;
  }

  preferenceSyncBusy = true;
  preferenceSyncQueued = false;
  lastPreferenceSyncAt = Date.now();
  try {
    await readPlayerPreference({ apply: true });
  } catch {
    // Preference memory is an enhancement. Never block ordinary kiosk scoring if it is unavailable.
  } finally {
    preferenceSyncBusy = false;
    if (preferenceSyncQueued) schedulePreferenceSync(50);
  }
}

function schedulePreferenceSync(delay = 80) {
  clearTimeout(preferenceSyncTimer);
  const sinceLast = Date.now() - lastPreferenceSyncAt;
  const wait = Math.max(delay, sinceLast < 300 ? 300 - sinceLast : 0);
  preferenceSyncTimer = setTimeout(syncPlayerPreference, wait);
}

function ensureSponsorStyles() {
  if (document.getElementById("boardSponsorRuntimeStyles")) return;
  const style = document.createElement("style");
  style.id = "boardSponsorRuntimeStyles";
  style.textContent = `
    .board-sponsor-badge{display:flex;align-items:center;gap:9px;max-width:300px;padding:7px 10px;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:rgba(255,255,255,.05)}
    .board-sponsor-badge.hidden{display:none}
    .board-sponsor-badge img{width:42px;height:42px;object-fit:contain;border-radius:8px;background:#fff;padding:3px}
    .board-sponsor-copy{display:grid;gap:1px;min-width:0}
    .board-sponsor-copy span{font-size:10px;text-transform:uppercase;letter-spacing:.08em;opacity:.65}
    .board-sponsor-copy strong{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    @media (max-width:700px){.board-sponsor-badge{max-width:190px}.board-sponsor-copy span{display:none}.board-sponsor-badge img{width:34px;height:34px}}
  `;
  document.head.appendChild(style);
}

function ensureSponsorBadge() {
  ensureSponsorStyles();
  let badge = document.getElementById("boardSponsorBadge");
  if (badge) return badge;

  const status = document.querySelector(".terminal-status");
  if (!status) return null;

  badge = document.createElement("div");
  badge.id = "boardSponsorBadge";
  badge.className = "board-sponsor-badge hidden";
  badge.innerHTML = `<img id="boardSponsorLogo" class="hidden" alt="Sponsorlogo"><div class="board-sponsor-copy"><span>Presentert av</span><strong id="boardSponsorLabel"></strong></div>`;
  status.prepend(badge);
  return badge;
}

function renderBoardSponsor() {
  const badge = ensureSponsorBadge();
  if (!badge) return;

  let kiosk = null;
  try {
    kiosk = typeof currentKiosk === "function" ? currentKiosk() : null;
  } catch {
    kiosk = null;
  }

  const label = String(kiosk?.sponsor_label || "").trim();
  const logoUrl = String(kiosk?.sponsor_logo_url || "").trim();
  const logo = document.getElementById("boardSponsorLogo");
  const labelNode = document.getElementById("boardSponsorLabel");

  if (!label && !logoUrl) {
    badge.classList.add("hidden");
    return;
  }

  labelNode.textContent = label || "Sponsor";
  if (logoUrl) {
    logo.src = logoUrl;
    logo.classList.remove("hidden");
    logo.onerror = () => logo.classList.add("hidden");
  } else {
    logo.removeAttribute("src");
    logo.classList.add("hidden");
  }
  badge.classList.remove("hidden");
}

renewButton?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
  renewPairingCode();
}, { capture: true });

sumModeButton?.addEventListener("click", () => {
  if (!applyingPlayerPreference) savePlayerPreference("sum").catch(() => undefined);
});

dartModeButton?.addEventListener("click", () => {
  if (!applyingPlayerPreference) savePlayerPreference("per_dart").catch(() => undefined);
});

if (throwingPlayer && typeof MutationObserver === "function") {
  const observer = new MutationObserver(() => schedulePreferenceSync(40));
  observer.observe(throwingPlayer, { childList: true, characterData: true, subtree: true });
}

setInterval(() => {
  renderBoardSponsor();
  if (paired()) {
    localStorage.removeItem(DEADLINE_KEY);
    schedulePreferenceSync(0);
    return;
  }
  const deadline = ensureLocalDeadline();
  if (deadline > 0 && Date.now() >= deadline) renewPairingCode();
}, 3000);

ensureLocalDeadline();
renderBoardSponsor();
if (paired()) setTimeout(() => schedulePreferenceSync(0), 500);
