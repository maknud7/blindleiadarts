const renewButton = document.getElementById("newPairingButton");
const RENEW_URL = "../api/kiosk-pairing-renew.php";
const DEADLINE_KEY = "bd:kioskPairingLocalDeadline";

function currentCode() { return localStorage.getItem("bd:kioskPairingRequestCode") || ""; }
function currentToken() { return localStorage.getItem("bd:kioskPairingToken") || ""; }
function paired() { return Boolean(localStorage.getItem("bd:kioskCode")); }

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

renewButton?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
  renewPairingCode();
}, { capture: true });

setInterval(() => {
  if (paired()) {
    localStorage.removeItem(DEADLINE_KEY);
    return;
  }
  const deadline = ensureLocalDeadline();
  if (deadline > 0 && Date.now() >= deadline) renewPairingCode();
}, 5000);

ensureLocalDeadline();
