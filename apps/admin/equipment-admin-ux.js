const API_ROOT = "../api/v1";

const state = {
  role: null,
  screenIds: new Map(),
  screenIdsLoading: null,
};

function token() { return localStorage.getItem("bd:token") || ""; }
function clubId() { return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0); }
function esc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }

async function requestJson(path, { method = "GET", body } = {}) {
  const headers = { Authorization: `Bearer ${token()}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data;
}

function showMessage(text, tone = "info") {
  const target = document.getElementById("globalMessage");
  if (!target) return;
  target.textContent = text;
  target.className = `message ${tone}`;
  target.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function makeReveal(id, title, description, content) {
  const reveal = document.createElement("section");
  reveal.id = id;
  reveal.className = "equipment-reveal hidden";
  reveal.innerHTML = `<div class="equipment-reveal-head"><div><p class="eyebrow">Utstyr</p><h3>${esc(title)}</h3><p class="muted">${esc(description)}</p></div><button type="button" class="equipment-reveal-close button secondary">Lukk</button></div>`;
  reveal.appendChild(content);
  reveal.querySelector(".equipment-reveal-close")?.addEventListener("click", () => reveal.classList.add("hidden"));
  return reveal;
}

function openOnly(target) {
  ["boardCreateReveal", "pairingReveal", "screenCreateReveal"].forEach((id) => {
    const node = document.getElementById(id);
    if (node && node !== target) node.classList.add("hidden");
  });
  target?.classList.toggle("hidden");
}

function addAdvancedBoardFields(form) {
  if (!form || form.querySelector(".equipment-advanced")) return;
  const submit = form.querySelector('button[type="submit"]');
  const details = document.createElement("details");
  details.className = "equipment-advanced";
  details.innerHTML = `<summary>Valgfritt: navn og sponsor</summary><div class="equipment-advanced-fields"><label><span>Visningsnavn</span><input name="name" maxlength="120" placeholder="F.eks. Skive 1"></label><label><span>Sponsor / presentert av</span><input name="sponsor_label" maxlength="150" placeholder="F.eks. Sjøbua"></label><label><span>Sponsorlogo (URL)</span><input name="sponsor_logo_url" type="url" maxlength="255" placeholder="https://..."></label></div>`;
  const existingName = form.querySelector('input[name="name"]')?.closest("label");
  if (existingName) existingName.remove();
  submit?.insertAdjacentElement("beforebegin", details);
}

function setupBoardFlow() {
  const section = document.getElementById("kiosks");
  const panelHead = section?.querySelector(":scope > .panel-head");
  const pairingCard = section?.querySelector(":scope > .claim-admin-card");
  const layout = section?.querySelector(":scope > .kiosk-layout");
  const form = document.getElementById("kioskForm");
  if (!section || !panelHead || !pairingCard || !layout || !form || document.getElementById("equipmentBoardActions")) return;

  const actionbar = document.createElement("div");
  actionbar.id = "equipmentBoardActions";
  actionbar.className = "equipment-actionbar";
  actionbar.innerHTML = `<div class="equipment-actionbar-copy"><strong>Skiver</strong><span>Opprett selve skiva først. Nettbrett kobles til skiva etterpå.</span></div><div class="equipment-actionbar-actions"><button id="newBoardButton" type="button">+ Ny skive</button><button id="pairTabletButton" type="button" class="button secondary">Koble nettbrett</button></div>`;
  panelHead.insertAdjacentElement("afterend", actionbar);

  const createReveal = makeReveal("boardCreateReveal", "Ny skive", "Kun det som trengs for å få skiva inn i systemet.", form);
  actionbar.insertAdjacentElement("afterend", createReveal);
  form.querySelector("h3").textContent = "Opprett skive";
  const intro = form.querySelector("p.muted");
  if (intro) intro.textContent = "Velg skivenummer og scoring. Navn og sponsor er valgfritt.";
  addAdvancedBoardFields(form);

  const pairingIntro = pairingCard.querySelector(".claim-admin-grid > div:first-child");
  pairingIntro?.classList.add("equipment-pairing-intro");
  if (pairingIntro) {
    pairingIntro.innerHTML = `<p class="eyebrow">Nettbrett</p><h3>Koble nettbrett til en skive</h3><p class="muted">Åpne kiosk på nettbrettet og skriv pairingkoden her. Velg normalt en skive som allerede finnes. Hvis dette er første gangs oppsett kan du fortsatt opprette skiva i samme flyt.</p>`;
  }
  const pairingReveal = makeReveal("pairingReveal", "Koble nettbrett", "Pairing påvirker bare terminalen – ikke selve skiva.", pairingCard);
  createReveal.insertAdjacentElement("afterend", pairingReveal);

  layout.classList.add("equipment-list-only");
  const listHeading = layout.querySelector(".subsection-head h3");
  if (listHeading) listHeading.textContent = "Skiver";

  document.getElementById("newBoardButton")?.addEventListener("click", () => openOnly(createReveal));
  document.getElementById("pairTabletButton")?.addEventListener("click", () => openOnly(pairingReveal));

  form.addEventListener("submit", createBoard, true);
}

async function createBoard(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
  const form = event.currentTarget;
  const data = new FormData(form);
  const boardNumber = Number(data.get("board_number") || 0);
  const scoring = String(data.get("scoring_mode") || "manual");
  const serial = String(data.get("scolia_serial_number") || "").trim();
  if (boardNumber <= 0) return;
  if (scoring === "scolia" && !/^[A-Za-z0-9._:-]{3,120}$/.test(serial)) {
    showMessage("Scolia-skive må ha en gyldig Scolia-ID / serienummer.", "warning");
    return;
  }

  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const created = await requestJson(`/clubs/${clubId()}/kiosks`, { method: "POST", body: {
      board_number: boardNumber,
      name: String(data.get("name") || "").trim() || `Skive ${boardNumber}`,
      sponsor_label: String(data.get("sponsor_label") || "").trim(),
      sponsor_logo_url: String(data.get("sponsor_logo_url") || "").trim(),
      scoring_mode: scoring,
    }});
    const id = Number(created.kiosk?.id || 0);
    if (scoring === "scolia") {
      if (!id) throw new Error("Skiva ble opprettet uten gyldig ID.");
      await requestJson(`/clubs/${clubId()}/kiosks/${id}/scolia`, { method: "PATCH", body: {
        serial_number: serial,
        mode: "live",
        auto_fallback_to_manual: true,
      }});
    }
    form.reset();
    document.getElementById("kioskScoringMode")?.dispatchEvent(new Event("change"));
    document.getElementById("boardCreateReveal")?.classList.add("hidden");
    showMessage(`Skive ${boardNumber} er opprettet. Koble nettbrett når du er klar.`, "success");
    document.getElementById("refreshAllButton")?.click();
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    submit.disabled = false;
  }
}

function setupScreenFlow() {
  const section = document.getElementById("screens");
  const panelHead = section?.querySelector(":scope > .panel-head");
  const layout = section?.querySelector(":scope > .screen-layout");
  const form = document.getElementById("screenForm");
  if (!section || !panelHead || !layout || !form || document.getElementById("newScreenButton")) return;

  const actionbar = document.createElement("div");
  actionbar.className = "equipment-actionbar";
  actionbar.innerHTML = `<div class="equipment-actionbar-copy"><strong>Venue-skjermer</strong><span>Opprett en skjermkode, åpne venue-siden på TV-en og skriv inn koden.</span></div><div class="equipment-actionbar-actions"><button id="newScreenButton" type="button">+ Ny skjerm</button></div>`;
  panelHead.insertAdjacentElement("afterend", actionbar);

  const reveal = makeReveal("screenCreateReveal", "Ny venue-skjerm", "Gi skjermen et navn du kjenner igjen. Koden genereres automatisk.", form);
  actionbar.insertAdjacentElement("afterend", reveal);
  form.querySelector("h3").textContent = "Opprett skjermkode";
  document.getElementById("newScreenButton")?.addEventListener("click", () => openOnly(reveal));

  const observer = new MutationObserver(() => {
    if (!reveal.classList.contains("hidden")) reveal.classList.add("hidden");
  });
  document.getElementById("screenList") && observer.observe(document.getElementById("screenList"), { childList: true });
}

async function loadRole() {
  if (!token()) return;
  try {
    const me = await requestJson("/auth/me");
    state.role = me.user?.role || null;
  } catch {
    state.role = null;
  }
}

async function loadScreenIds() {
  if (state.screenIdsLoading) return state.screenIdsLoading;
  state.screenIdsLoading = requestJson(`/clubs/${clubId()}/screen-devices`).then((data) => {
    state.screenIds = new Map((data.items || []).map((screen) => [String(screen.access_code || ""), Number(screen.id || 0)]));
  }).finally(() => { state.screenIdsLoading = null; });
  return state.screenIdsLoading;
}

function armDelete(button) {
  if (button.dataset.armed === "1") return true;
  button.dataset.armed = "1";
  button.dataset.originalText = button.textContent;
  button.textContent = "Bekreft sletting";
  button.classList.add("is-armed");
  window.setTimeout(() => {
    if (!button.isConnected || button.dataset.armed !== "1") return;
    button.dataset.armed = "0";
    button.textContent = button.dataset.originalText || "Slett";
    button.classList.remove("is-armed");
  }, 4500);
  return false;
}

async function deleteEquipment(button) {
  if (!armDelete(button)) return;
  button.disabled = true;
  const kind = button.dataset.kind;
  const id = Number(button.dataset.id || 0);
  try {
    const path = kind === "screen"
      ? `/clubs/${clubId()}/screen-devices/${id}`
      : `/clubs/${clubId()}/kiosks/${id}`;
    await requestJson(path, { method: "DELETE" });
    showMessage(kind === "screen" ? "Venue-skjermen er slettet." : "Skiva er slettet.", "success");
    state.screenIds.clear();
    document.getElementById("refreshAllButton")?.click();
  } catch (error) {
    button.disabled = false;
    button.dataset.armed = "0";
    button.textContent = "Slett";
    button.classList.remove("is-armed");
    showMessage(error.message, "error");
  }
}

async function decorateDeleteActions() {
  if (state.role !== "super_admin") return;

  document.querySelectorAll("#kioskList .board-row").forEach((row) => {
    if (row.querySelector(".equipment-delete-button")) return;
    const source = row.querySelector("[data-kiosk-id]");
    const id = Number(row.dataset.kioskId || source?.dataset.kioskId || 0);
    if (!id) return;
    const controls = row.querySelector(".board-controls") || row;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "equipment-delete-button";
    button.dataset.kind = "board";
    button.dataset.id = String(id);
    button.textContent = "Slett";
    button.title = "Permanent sletting · kun superadmin";
    button.addEventListener("click", () => deleteEquipment(button));
    controls.appendChild(button);
  });

  await loadScreenIds().catch(() => undefined);
  document.querySelectorAll("#screenList .screen-row").forEach((row) => {
    if (row.querySelector(".equipment-delete-button")) return;
    const code = row.querySelector(".screen-code")?.textContent?.trim() || "";
    const id = Number(state.screenIds.get(code) || 0);
    if (!id) return;
    const controls = row.querySelector(".row-right") || row;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "equipment-delete-button";
    button.dataset.kind = "screen";
    button.dataset.id = String(id);
    button.textContent = "Slett";
    button.title = "Permanent sletting · kun superadmin";
    button.addEventListener("click", () => deleteEquipment(button));
    controls.appendChild(button);
  });
}

function observeLists() {
  const callback = () => window.queueMicrotask(() => decorateDeleteActions().catch(() => undefined));
  [document.getElementById("kioskList"), document.getElementById("screenList")].filter(Boolean).forEach((node) => {
    new MutationObserver(callback).observe(node, { childList: true, subtree: true });
  });
}

async function init() {
  setupBoardFlow();
  setupScreenFlow();
  await loadRole();
  observeLists();
  await decorateDeleteActions();
  document.getElementById("clubSelect")?.addEventListener("change", () => {
    state.screenIds.clear();
    window.setTimeout(() => decorateDeleteActions().catch(() => undefined), 150);
  });
}

init();
