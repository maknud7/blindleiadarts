const TEST_MODE_API = "../api/kiosk-test-mode.php";
const HEALTH_URL = "../api/health.php";

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data;
}

function ensureTestToken() {
  let token = localStorage.getItem("bd:kioskPairingToken") || "";
  if (!token) {
    token = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem("bd:kioskPairingToken", token);
  }
  return token;
}

function styles() {
  if (document.getElementById("kioskTestModeStyles")) return;
  const style = document.createElement("style");
  style.id = "kioskTestModeStyles";
  style.textContent = `
    .test-mode-panel{margin:14px 18px 0;padding:12px 14px;border:1px dashed rgba(255,205,86,.65);border-radius:14px;background:rgba(255,205,86,.09);display:grid;gap:8px}
    .test-mode-panel strong{color:var(--text)}
    .test-mode-panel select{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:#0e151e;color:var(--text)}
    .test-mode-row{display:flex;gap:8px;align-items:center}.test-mode-row select{flex:1}
    .test-mode-badge{font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:800;color:#ffda6b}
    @media(max-width:650px){.test-mode-row{display:grid}.test-mode-panel{margin:10px 10px 0}}
  `;
  document.head.appendChild(style);
}

async function activateTestBoard(kioskId, button) {
  const token = ensureTestToken();
  button.disabled = true;
  try {
    const data = await jsonRequest(TEST_MODE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kiosk-Pairing-Token": token },
      body: JSON.stringify({ kiosk_id: Number(kioskId) }),
    });
    localStorage.setItem("bd:kioskCode", data.kiosk.code);
    localStorage.removeItem("bd:kioskPairingRequestCode");
    localStorage.removeItem("bd:kioskPairingExpires");
    window.location.reload();
  } catch (error) {
    button.disabled = false;
    button.textContent = error.message || "Kunne ikke velge board";
    setTimeout(() => { button.textContent = "Bruk valgt board"; }, 2500);
  }
}

function buildPanel(items) {
  const panel = document.createElement("div");
  panel.className = "test-mode-panel";
  panel.innerHTML = `
    <span class="test-mode-badge">Testmiljø</span>
    <strong>Velg hvilken kiosk denne nettleseren skal bruke</strong>
    <div class="test-mode-row">
      <select aria-label="Velg testboard">${items.map((item) => `<option value="${Number(item.id)}">${String(item.club_name)} · Board ${Number(item.board_number)} · ${String(item.name)}</option>`).join("")}</select>
      <button type="button" class="ghost-button">Bruk valgt board</button>
    </div>`;
  const select = panel.querySelector("select");
  const button = panel.querySelector("button");
  button.addEventListener("click", () => activateTestBoard(select.value, button));
  return panel;
}

async function bootTestMode() {
  try {
    const healthResponse = await fetch(HEALTH_URL, { cache: "no-store" });
    const health = await healthResponse.json().catch(() => null);
    if (!healthResponse.ok || health?.app_env !== "test") return;

    const data = await jsonRequest(TEST_MODE_API);
    const items = data.items || [];
    if (!items.length) return;
    styles();

    const shell = document.querySelector(".terminal-shell");
    const topbar = document.querySelector(".terminal-topbar");
    if (shell && topbar && !document.getElementById("kioskTestSelectorPersistent")) {
      const panel = buildPanel(items);
      panel.id = "kioskTestSelectorPersistent";
      topbar.insertAdjacentElement("afterend", panel);
    }
  } catch (error) {
    console.warn("Kiosk test mode unavailable", error);
  }
}

bootTestMode();
