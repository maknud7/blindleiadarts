const TEST_MODE_API = "../api/kiosk-test-mode.php";
const TEST_MODE_KEY = "bd:kioskTestMode";

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
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function active() { return localStorage.getItem(TEST_MODE_KEY) === "1"; }
function setActive(value) {
  if (value) localStorage.setItem(TEST_MODE_KEY, "1");
  else localStorage.removeItem(TEST_MODE_KEY);
}
function styles() {
  if (document.getElementById("kioskTestModeStyles")) return;
  const style = document.createElement("style");
  style.id = "kioskTestModeStyles";
  style.textContent = `
    .test-mode-panel{margin:14px 18px 0;padding:12px 14px;border:2px solid rgba(255,205,86,.72);border-radius:14px;background:rgba(255,205,86,.10);display:grid;gap:8px}
    .test-mode-panel strong{color:var(--text)}.test-mode-panel small{line-height:1.4}.test-mode-panel select{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:#0e151e;color:var(--text)}
    .test-mode-row{display:flex;gap:8px;align-items:center}.test-mode-row select{flex:1}.test-mode-badge{font-size:12px;text-transform:uppercase;letter-spacing:.11em;font-weight:900;color:#ffda6b}.test-mode-exit{justify-self:start}
    body.kiosk-test-mode::before{content:"TEST";position:fixed;left:10px;bottom:10px;z-index:9999;padding:5px 9px;border-radius:8px;background:#ffcf4a;color:#17120a;font:900 12px/1 system-ui;letter-spacing:.12em;pointer-events:none}
    @media(max-width:650px){.test-mode-row{display:grid}.test-mode-panel{margin:10px 10px 0}}
  `;
  document.head.appendChild(style);
}
function ensureAdminTestControl() {
  if (document.body?.dataset?.appEnv !== "test") return;
  const actions = document.querySelector("#settingsDialog .settings-actions");
  if (!actions) return;
  let button = document.getElementById("kioskTestModeToggle");
  if (!button) {
    button = document.createElement("button");
    button.id = "kioskTestModeToggle";
    button.type = "button";
    button.className = "ghost-button";
    button.dataset.kioskAdminControl = "1";
    actions.prepend(button);
    button.addEventListener("click", () => {
      setActive(!active());
      const url = new URL(window.location.href);
      url.searchParams.delete("testmode");
      window.location.replace(url.toString());
    });
  }
  const label = active() ? "Avslutt testmodus" : "Aktiver testmodus";
  if (button.textContent !== label) button.textContent = label;
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
    localStorage.setItem("bd:kioskTestPhysicalBoardId", String(data.physical_board?.id || kioskId));
    localStorage.removeItem("bd:kioskPairingRequestCode");
    localStorage.removeItem("bd:kioskPairingExpires");
    window.location.reload();
  } catch (error) {
    button.disabled = false;
    const old = button.textContent;
    button.textContent = error.message || "Kunne ikke velge board";
    setTimeout(() => { button.textContent = old; }, 2600);
  }
}
function buildPanel(items, message = "") {
  const panel = document.createElement("div");
  panel.className = "test-mode-panel";
  const hasItems = items.length > 0;
  const options = hasItems
    ? items.map((item) => `<option value="${Number(item.id)}">${escapeHtml(item.club_name)} · Board ${Number(item.board_number)} · ${escapeHtml(item.name)}${item.scoring_mode === "scolia" ? " · Scolia" : ""}</option>`).join("")
    : `<option value="">Ingen fysiske boards funnet</option>`;
  panel.innerHTML = `
    <span class="test-mode-badge">Testmodus aktiv</span>
    <strong>Terminalen bruker isolert test-runtime</strong>
    <small class="muted">${escapeHtml(message || "Testkamper og scoring lagres isolert. Det fysiske boardregisteret er felles, og Scolia flyttes ikke automatisk til test.")}</small>
    <div class="test-mode-row" data-kiosk-admin-control><select aria-label="Velg fysisk board" ${hasItems ? "" : "disabled"}>${options}</select><button type="button" class="ghost-button" ${hasItems ? "" : "disabled"}>Bruk valgt board</button></div>
    <button type="button" class="ghost-button test-mode-exit" data-kiosk-admin-control>Avslutt testmodus</button>`;
  const select = panel.querySelector("select");
  const use = panel.querySelector(".test-mode-row button");
  if (hasItems) use.addEventListener("click", () => activateTestBoard(select.value, use));
  panel.querySelector(".test-mode-exit").addEventListener("click", () => {
    setActive(false);
    localStorage.removeItem("bd:kioskTestPhysicalBoardId");
    const url = new URL(window.location.href);
    url.searchParams.delete("testmode");
    window.location.replace(url.toString());
  });
  return panel;
}
function replacePanel(items, message = "") {
  const topbar = document.querySelector(".terminal-topbar");
  if (!topbar) return;
  const current = document.getElementById("kioskTestSelectorPersistent");
  const panel = buildPanel(items, message);
  panel.id = "kioskTestSelectorPersistent";
  if (current) current.replaceWith(panel); else topbar.insertAdjacentElement("afterend", panel);
}
async function bootTestMode() {
  if (document.body?.dataset?.appEnv !== "test") return;
  const query = new URLSearchParams(window.location.search).get("testmode");
  if (query === "1") setActive(true);
  if (query === "0") setActive(false);
  styles();
  ensureAdminTestControl();
  const observer = new MutationObserver(ensureAdminTestControl);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  if (!active()) return;

  document.body.classList.add("kiosk-test-mode");
  replacePanel([], "Laster fysisk boardregister …");
  try {
    const data = await jsonRequest(TEST_MODE_API);
    replacePanel(data.items || [], (data.items || []).length
      ? "Velg fysisk skive fra admin-modus. Testdata for kamp og scoring er fortsatt isolert."
      : "Det fysiske boardregisteret har ingen aktive skiver.");
  } catch (error) {
    replacePanel([], `Kunne ikke laste fysisk boardregister: ${error.message || "ukjent feil"}`);
    console.warn("Kiosk test mode unavailable", error);
  }
}

bootTestMode();