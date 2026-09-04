const API_ROOT = "../api/v1";
let tournamentId = 0;
let checkedInCount = 0;
let refreshTimer = null;
let refreshSerial = 0;

function token() {
  return localStorage.getItem("bd:token") || "";
}

async function api(path) {
  const headers = {};
  if (token()) headers.Authorization = `Bearer ${token()}`;
  const response = await fetch(`${API_ROOT}${path}`, { headers, cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data;
}

function ensureHint() {
  const warning = document.getElementById("tcStartWarning");
  if (!warning) return null;
  let hint = document.getElementById("tcFormatGuard");
  if (!hint) {
    hint = document.createElement("div");
    hint.id = "tcFormatGuard";
    hint.className = "tc-format-guard";
    warning.insertAdjacentElement("beforebegin", hint);
  }
  if (!document.getElementById("tcFormatGuardStyle")) {
    const style = document.createElement("style");
    style.id = "tcFormatGuardStyle";
    style.textContent = `
      .tc-format-guard{margin:12px 0 0;padding:11px 13px;border:1px solid var(--line);border-radius:12px;background:rgba(94,168,255,.055);color:var(--muted);font-size:.86rem;line-height:1.42}
      .tc-format-guard strong{display:block;margin-bottom:2px;color:var(--text,#f4f7fb)}
      .tc-format-guard.good{border-color:rgba(77,212,166,.28);background:rgba(77,212,166,.06)}
      .tc-format-guard.warning{border-color:rgba(233,185,73,.32);background:rgba(233,185,73,.07)}
      .tc-format-guard.error{border-color:rgba(255,107,107,.38);background:rgba(255,107,107,.07);color:#ffc4c4}
    `;
    document.head.appendChild(style);
  }
  return hint;
}

function nextBracketSize(count) {
  let size = 2;
  while (size < count) size *= 2;
  return size;
}

function formatValue() {
  return document.getElementById("tcTournamentFormat")?.value || "groups_playoff";
}

function evaluate() {
  const hint = ensureHint();
  const groupInput = document.getElementById("tcGroupCount");
  const qualifierInput = document.getElementById("tcQualifiers");
  const startButton = document.getElementById("tcStart");
  if (!hint || !groupInput || !qualifierInput || !startButton) return { valid: true, message: "" };

  const format = formatValue();
  const groupFormat = format === "groups_playoff" || format === "groups_only";
  if (!groupFormat) {
    hint.className = "tc-format-guard";
    hint.innerHTML = `<strong>Format uten gruppespill</strong>Gruppestørrelse og antall videre gjelder ikke for dette formatet.`;
    return { valid: true, message: "" };
  }

  const groupCount = Math.max(1, Number(groupInput.value || 1));
  const qualifiers = Math.max(1, Number(qualifierInput.value || 1));
  const maxGroups = checkedInCount >= 4 ? Math.floor(checkedInCount / 4) : 0;
  const smallestGroup = groupCount > 0 ? Math.floor(checkedInCount / groupCount) : 0;

  groupInput.min = "1";
  groupInput.max = String(Math.max(1, maxGroups));
  qualifierInput.min = "1";
  qualifierInput.max = String(Math.max(1, Math.min(16, smallestGroup || 1)));

  let valid = true;
  let message = "";
  let detail = "";

  if (checkedInCount < 4) {
    valid = false;
    message = "Gruppespill krever minst 4 innsjekkede spillere.";
  } else if (groupCount > maxGroups) {
    valid = false;
    message = `Med ${checkedInCount} innsjekkede kan du ha maks ${maxGroups} ${maxGroups === 1 ? "gruppe" : "grupper"}, slik at alle grupper får minst 4 spillere.`;
  } else if (smallestGroup < 4) {
    valid = false;
    message = "Alle grupper må ha minst 4 spillere.";
  } else if (format === "groups_playoff" && qualifiers > smallestGroup) {
    valid = false;
    message = `Du kan ikke sende ${qualifiers} videre når den minste gruppen bare har ${smallestGroup} spillere.`;
  } else if (format === "groups_playoff") {
    const qualified = groupCount * qualifiers;
    if (qualified < 2) {
      valid = false;
      message = "Sluttspillet må få minst 2 kvalifiserte spillere.";
    } else if (qualified > 32) {
      valid = false;
      message = `Denne kombinasjonen gir ${qualified} kvalifiserte. Sluttspillet støtter maksimalt 32.`;
    } else {
      const bracket = nextBracketSize(qualified);
      const byes = bracket - qualified;
      detail = `${groupCount} ${groupCount === 1 ? "gruppe" : "grupper"} · minste gruppe ${smallestGroup} · ${qualified} videre → ${bracket}-plassers sluttspill${byes ? ` · ${byes} ${byes === 1 ? "friplass" : "friplasser"}` : ""}.`;
    }
  } else {
    detail = `${groupCount} ${groupCount === 1 ? "gruppe" : "grupper"} · minste gruppe ${smallestGroup}.`;
  }

  hint.className = `tc-format-guard ${valid ? "good" : "error"}`;
  hint.innerHTML = valid
    ? `<strong>Formatet er gyldig</strong>${detail}`
    : `<strong>Formatet må justeres før start</strong>${message}`;

  startButton.dataset.formatInvalid = valid ? "0" : "1";
  if (!valid) startButton.disabled = true;
  return { valid, message };
}

function showError(message) {
  const box = document.getElementById("tcMessage");
  if (!box) return;
  box.textContent = message;
  box.className = "message error";
}

async function refresh() {
  const id = tournamentId || Number(window.__bdTournamentContext?.id || 0);
  if (!id) return evaluate();
  const serial = ++refreshSerial;
  try {
    const data = await api(`/tournaments/${id}`);
    if (serial !== refreshSerial) return;
    const registrations = data?.tournament?.registrations || [];
    checkedInCount = registrations.filter((row) => String(row.status) === "checked_in").length;
  } catch {
    if (serial !== refreshSerial) return;
    checkedInCount = 0;
  }
  evaluate();
}

function queueRefresh() {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => refresh(), 80);
}

window.addEventListener("bd:tournament-context", (event) => {
  tournamentId = Number(event.detail?.id || 0);
  queueRefresh();
});
window.addEventListener("bd:tournament-tools-ready", queueRefresh);

document.addEventListener("input", (event) => {
  if (["tcGroupCount", "tcQualifiers"].includes(event.target?.id)) evaluate();
});
document.addEventListener("change", (event) => {
  if (["tcGroupCount", "tcQualifiers", "tcTournamentFormat"].includes(event.target?.id)) evaluate();
});

document.addEventListener("click", (event) => {
  const button = event.target?.closest?.("#tcStart");
  if (!button) return;
  const result = evaluate();
  if (result.valid) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  showError(result.message || "Formatet må justeres før turneringen kan startes.");
}, true);

const observer = new MutationObserver(() => evaluate());
observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "value"] });

queueRefresh();
