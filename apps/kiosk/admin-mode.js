const KIOSK_ADMIN_PIN = "2201";
const KIOSK_ADMIN_SESSION_KEY = "bd:kioskAdminMode";

function isTestEnvironment() {
  return document.body?.dataset?.appEnv === "test";
}
function shortcutRequested() {
  return isTestEnvironment() && new URLSearchParams(window.location.search).get("testmode") === "1";
}
function isUnlocked() {
  return sessionStorage.getItem(KIOSK_ADMIN_SESSION_KEY) === "1";
}
function setUnlocked(value) {
  if (value) sessionStorage.setItem(KIOSK_ADMIN_SESSION_KEY, "1");
  else sessionStorage.removeItem(KIOSK_ADMIN_SESSION_KEY);
  document.body?.classList.toggle("kiosk-admin-mode", value);
}
function ensureStyles() {
  if (document.getElementById("kioskAdminModeStyles")) return;
  const style = document.createElement("style");
  style.id = "kioskAdminModeStyles";
  style.textContent = `
    [data-kiosk-admin-control]{display:none!important}
    body.kiosk-admin-mode [data-kiosk-admin-control]:not(.hidden){display:inline-flex!important}
    .kiosk-admin-status{padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.04);font-size:13px;line-height:1.45}
    .kiosk-admin-status strong{display:block;margin-bottom:3px}
    body.kiosk-admin-mode .kiosk-admin-status{border-color:rgba(255,205,86,.5);background:rgba(255,205,86,.08)}
  `;
  document.head.appendChild(style);
}
function protectExistingControls() {
  [document.getElementById("unpairButton"), document.getElementById("resetTerminalButton")]
    .filter(Boolean)
    .forEach((node) => node.dataset.kioskAdminControl = "1");
}
function statusNode() {
  const meta = document.getElementById("settingsMeta");
  if (!meta) return null;
  let node = document.getElementById("kioskAdminStatus");
  if (!node) {
    node = document.createElement("div");
    node.id = "kioskAdminStatus";
    node.className = "kiosk-admin-status";
    meta.appendChild(node);
  }
  node.innerHTML = isUnlocked()
    ? `<strong>Admin-modus er aktiv</strong>Avanserte terminalvalg er låst opp for denne økten.`
    : `<strong>Vanlig modus</strong>Avanserte terminalvalg krever admin-kode.`;
  return node;
}
function unlock() {
  const code = window.prompt("Admin-kode");
  if (code === null) return;
  if (String(code).trim() !== KIOSK_ADMIN_PIN) {
    const node = statusNode();
    if (node) node.innerHTML = `<strong>Feil kode</strong>Admin-modus ble ikke aktivert.`;
    return;
  }
  setUnlocked(true);
  render();
}
function lock() {
  setUnlocked(false);
  render();
}
function ensureButton() {
  const actions = document.querySelector("#settingsDialog .settings-actions");
  if (!actions) return null;
  let button = document.getElementById("kioskAdminModeButton");
  if (!button) {
    button = document.createElement("button");
    button.id = "kioskAdminModeButton";
    button.type = "button";
    button.className = "ghost-button";
    actions.appendChild(button);
    button.addEventListener("click", () => isUnlocked() ? lock() : unlock());
  }
  button.textContent = isUnlocked() ? "Lås admin-modus" : "Admin-modus";
  return button;
}
function render() {
  ensureStyles();
  protectExistingControls();
  document.body?.classList.toggle("kiosk-admin-mode", isUnlocked());
  ensureButton();
  statusNode();
}

// ?testmode=1 is the deliberate technician shortcut on the isolated test domain.
// It unlocks this local convenience gate, but does not grant server-side admin rights.
if (shortcutRequested()) setUnlocked(true);
else setUnlocked(isUnlocked());

const observer = new MutationObserver(render);
observer.observe(document.documentElement, { childList: true, subtree: true });
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render, { once: true });
else render();