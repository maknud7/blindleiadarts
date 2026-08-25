const API_ROOT = "../api/v1";
const UNLOCK_KEY = "bd:scoliaShadowToolsUnlocked";
const ADMIN_CODE = "2201";

const clubSelect = document.getElementById("clubSelect");
const refreshAll = document.getElementById("refreshAllButton");

function token() { return localStorage.getItem("bd:token") || ""; }
function clubId() { return Number(clubSelect?.value || localStorage.getItem("bd:selectedClubId") || 0); }
function unlocked() { return sessionStorage.getItem(UNLOCK_KEY) === "1"; }
function esc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }

async function request(path, { method = "GET", body } = {}) {
  const headers = { Authorization: `Bearer ${token()}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data;
}

function ensureStyles() {
  if (document.getElementById("scoliaShadowToolStyles")) return;
  const style = document.createElement("style");
  style.id = "scoliaShadowToolStyles";
  style.textContent = `
    .scolia-test-tools{margin-top:18px;border:1px dashed var(--line);border-radius:16px;padding:16px;background:rgba(13,85,151,.035)}
    .scolia-test-head{display:flex;justify-content:space-between;gap:14px;align-items:start}.scolia-test-head h3{margin:2px 0 0}.scolia-test-head .badge{white-space:nowrap}
    .scolia-test-unlock{display:flex;gap:8px;align-items:end;flex-wrap:wrap;margin-top:12px}.scolia-test-unlock label{display:grid;gap:5px}.scolia-test-unlock input{max-width:130px}
    .scolia-test-list{display:grid;gap:9px;margin-top:12px}.scolia-test-row{display:flex;justify-content:space-between;gap:12px;align-items:center;border:1px solid var(--line);border-radius:12px;padding:11px}.scolia-test-row>div:first-child{display:grid;gap:3px}.scolia-test-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.scolia-test-note{margin-top:10px;padding:10px 12px;border-radius:10px;background:rgba(255,194,92,.08);border:1px solid rgba(255,194,92,.22)}
    @media(max-width:700px){.scolia-test-row{align-items:stretch;flex-direction:column}.scolia-test-actions{display:grid}.scolia-test-head{flex-direction:column}}
  `;
  document.head.appendChild(style);
}

function ensurePanel() {
  const integrations = document.getElementById("integrations");
  if (!integrations || document.getElementById("scoliaShadowTools")) return null;
  ensureStyles();
  const root = document.createElement("section");
  root.id = "scoliaShadowTools";
  root.className = "scolia-test-tools";
  integrations.appendChild(root);
  return root;
}

function lockedHtml() {
  return `
    <div class="scolia-test-head">
      <div><p class="eyebrow">Avansert admin</p><h3>Testverktøy</h3><p class="muted">Shadow er skjult fra vanlig drift og brukes bare når vi vil kontrollere Scolia mot manuell scoring.</p></div>
      <span class="badge neutral">Låst</span>
    </div>
    <form id="scoliaShadowUnlockForm" class="scolia-test-unlock">
      <label><span>Admin-kode</span><input id="scoliaShadowUnlockCode" type="password" inputmode="numeric" maxlength="8" autocomplete="off" required></label>
      <button type="submit" class="button secondary">Åpne testverktøy</button>
    </form>
    <div id="scoliaShadowMessage" class="muted"></div>`;
}

function modeLabel(mode) {
  if (mode === "shadow") return "Shadow-test aktiv";
  if (mode === "live") return "Normal Scolia";
  return "Scolia av";
}

function unlockedHtml(boards) {
  const mapped = boards.filter((board) => String(board.serial_number || "").trim() !== "");
  const rows = mapped.length
    ? mapped.map((board) => {
        const mode = String(board.mode || "off");
        const shadow = mode === "shadow";
        return `<div class="scolia-test-row">
          <div>
            <strong>Board ${Number(board.board_number || 0)} · ${esc(board.name || "Board")}</strong>
            <small class="muted">Scolia-ID ${esc(board.serial_number)} · ${esc(modeLabel(mode))}</small>
          </div>
          <div class="scolia-test-actions">
            <span class="badge ${shadow ? "warning" : "neutral"}">${shadow ? "SHADOW" : "NORMAL"}</span>
            ${shadow
              ? `<button type="button" class="button" data-shadow-mode="live" data-kiosk-id="${Number(board.id)}">Tilbake til normal Scolia</button>`
              : `<button type="button" class="button secondary" data-shadow-mode="shadow" data-kiosk-id="${Number(board.id)}">Start shadow-test</button>`}
          </div>
        </div>`;
      }).join("")
    : `<p class="muted">Ingen boards med Scolia-ID er konfigurert.</p>`;

  return `
    <div class="scolia-test-head">
      <div><p class="eyebrow">Avansert admin</p><h3>Testverktøy</h3><p class="muted">Vanlig drift har bare scoringtypene Manuell og Scolia. Shadow finnes kun her for kontroll og feilsøking.</p></div>
      <button id="scoliaShadowLock" type="button" class="button quiet">Lås</button>
    </div>
    <div class="scolia-test-note"><strong>Shadow påvirker ikke offisiell score.</strong><div class="muted">Scolia lytter og lagrer sammenligningsdata, mens kampen scores manuelt. Fallback er fortsatt en automatisk sikkerhetstilstand, ikke en scoringtype.</div></div>
    <div id="scoliaShadowMessage" class="muted"></div>
    <div class="scolia-test-list">${rows}</div>`;
}

function setMessage(text, bad = false) {
  const node = document.getElementById("scoliaShadowMessage");
  if (!node) return;
  node.textContent = text;
  node.style.color = bad ? "var(--danger, #b00020)" : "";
}

async function setMode(kioskId, mode, button) {
  const data = await request(`/clubs/${clubId()}/kiosks/${kioskId}/scolia`);
  const board = data?.board;
  const serial = String(board?.serial_number || "").trim();
  if (!serial) throw new Error("Boardet mangler Scolia-ID.");

  if (mode === "shadow") {
    const ok = confirm("Starte shadow-test? Offisiell scoring går da manuelt, mens Scolia bare observerer og lagrer sammenligningsdata.");
    if (!ok) return;
  } else {
    const ok = confirm("Avslutte shadow-test og gå tilbake til normal Scolia-scoring?");
    if (!ok) return;
  }

  button.disabled = true;
  try {
    await request(`/clubs/${clubId()}/kiosks/${kioskId}/scolia`, {
      method: "PATCH",
      body: {
        serial_number: serial,
        mode,
        auto_fallback_to_manual: Number(board.auto_fallback_to_manual ?? 1) === 1,
      },
    });
    setMessage(mode === "shadow" ? "Shadow-test er aktivert." : "Boardet er tilbake på normal Scolia.");
    await render();
  } finally {
    button.disabled = false;
  }
}

function bindLocked(root) {
  root.querySelector("#scoliaShadowUnlockForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = root.querySelector("#scoliaShadowUnlockCode")?.value || "";
    if (code !== ADMIN_CODE) {
      setMessage("Feil admin-kode.", true);
      return;
    }
    sessionStorage.setItem(UNLOCK_KEY, "1");
    render().catch((error) => setMessage(error.message, true));
  });
}

function bindUnlocked(root) {
  root.querySelector("#scoliaShadowLock")?.addEventListener("click", () => {
    sessionStorage.removeItem(UNLOCK_KEY);
    render().catch(() => undefined);
  });
  root.querySelectorAll("[data-shadow-mode]").forEach((button) => {
    button.addEventListener("click", () => setMode(Number(button.dataset.kioskId), button.dataset.shadowMode, button).catch((error) => setMessage(error.message, true)));
  });
}

async function render() {
  const root = ensurePanel();
  if (!root || !clubId() || !token()) return;
  if (!unlocked()) {
    root.innerHTML = lockedHtml();
    bindLocked(root);
    return;
  }
  const dashboard = await request(`/clubs/${clubId()}/scolia`);
  root.innerHTML = unlockedHtml(dashboard?.boards || []);
  bindUnlocked(root);
}

function scheduleRender() { window.setTimeout(() => render().catch((error) => setMessage(error.message, true)), 120); }

const observer = new MutationObserver(() => {
  if (document.getElementById("integrations") && !document.getElementById("scoliaShadowTools")) scheduleRender();
});
observer.observe(document.documentElement, { childList: true, subtree: true });
clubSelect?.addEventListener("change", scheduleRender);
refreshAll?.addEventListener("click", scheduleRender);
window.addEventListener("hashchange", () => { if (location.hash === "#settings" || location.hash === "#integrations") scheduleRender(); });
scheduleRender();