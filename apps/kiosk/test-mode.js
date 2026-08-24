const TEST_MODE_API = "../api/kiosk-test-mode.php";

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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function styles() {
  if (document.getElementById("kioskTestModeStyles")) return;
  const style = document.createElement("style");
  style.id = "kioskTestModeStyles";
  style.textContent = `
    .test-mode-panel{margin:14px 18px 0;padding:12px 14px;border:1px dashed rgba(255,205,86,.65);border-radius:14px;background:rgba(255,205,86,.09);display:grid;gap:8px}
    .test-mode-panel strong{color:var(--text)}
    .test-mode-panel small{line-height:1.4}
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

function buildPanel(items, message = "") {
  const panel = document.createElement("div");
  panel.className = "test-mode-panel";
  const hasItems = items.length > 0;
  const options = hasItems
    ? items.map((item) => `<option value="${Number(item.id)}">${escapeHtml(item.club_name)} · Board ${Number(item.board_number)} · ${escapeHtml(item.name)}</option>`).join("")
    : `<option value="">Ingen aktive boards funnet</option>`;

  panel.innerHTML = `
    <span class="test-mode-badge">Testmiljø</span>
    <strong>Velg hvilken kiosk denne nettleseren skal bruke</strong>
    <small class="muted">${escapeHtml(message || "Denne velgeren finnes bare i testmiljøet. Produksjon bruker vanlig QR-pairing.")}</small>
    <div class="test-mode-row">
      <select aria-label="Velg testboard" ${hasItems ? "" : "disabled"}>${options}</select>
      <button type="button" class="ghost-button" ${hasItems ? "" : "disabled"}>Bruk valgt board</button>
    </div>`;

  const select = panel.querySelector("select");
  const button = panel.querySelector("button");
  if (hasItems) button.addEventListener("click", () => activateTestBoard(select.value, button));
  return panel;
}

function replacePersistentPanel(items, message = "") {
  const topbar = document.querySelector(".terminal-topbar");
  if (!topbar) return null;

  const current = document.getElementById("kioskTestSelectorPersistent");
  const panel = buildPanel(items, message);
  panel.id = "kioskTestSelectorPersistent";
  if (current) current.replaceWith(panel);
  else topbar.insertAdjacentElement("afterend", panel);
  return panel;
}

async function bootTestMode() {
  if (document.body?.dataset?.appEnv !== "test") return;

  styles();
  replacePersistentPanel([], "Laster boards fra testmiljøet …");

  try {
    const data = await jsonRequest(TEST_MODE_API);
    const items = data.items || [];
    replacePersistentPanel(
      items,
      items.length
        ? "Velg board direkte uten QR-pairing."
        : "Test-API-et svarer, men testdatabasen har ingen aktive boards."
    );
  } catch (error) {
    replacePersistentPanel([], `Kunne ikke laste testboards: ${error.message || "ukjent feil"}`);
    console.warn("Kiosk test mode unavailable", error);
  }
}

bootTestMode();
