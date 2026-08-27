const API_ROOT = "../api/v1";
const TOKEN_KEY = "bd:token";
const card = document.getElementById("playerBreakCard");

let context = null;
let fetchedAt = 0;
let refreshBusy = false;
let ticker = null;

function token() { return localStorage.getItem(TOKEN_KEY) || ""; }
function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

async function api(path, { method = "GET" } = {}) {
  const auth = token();
  if (!auth) throw Object.assign(new Error("not_logged_in"), { status: 401 });

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${API_ROOT}${path}`, {
      method,
      headers: { Authorization: `Bearer ${auth}` },
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw Object.assign(new Error(payload?.error?.message || "Kunne ikke oppdatere pause."), { status: response.status });
    }
    return payload.data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw Object.assign(new Error(`API-kallet ${path} brukte mer enn 12 sekunder.`), { status: 408 });
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function remainingSeconds() {
  const pause = context?.break;
  if (!pause || pause.status !== "active") return null;
  const base = Number(pause.remaining_seconds || 0);
  return Math.max(0, base - Math.floor((Date.now() - fetchedAt) / 1000));
}

function clock(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function ensureStyles() {
  if (document.getElementById("playerBreakStyles")) return;
  const style = document.createElement("style");
  style.id = "playerBreakStyles";
  style.textContent = `
    .break-countdown{font-size:clamp(2.7rem,12vw,5rem);line-height:1;font-weight:900;letter-spacing:-.05em;margin:.25rem 0}
    .break-state{display:grid;gap:.65rem}
    .break-state button{width:100%}
    .pause-managed-note{margin:.5rem 0 0}
  `;
  document.head.appendChild(style);
}

function patchPortalRendering() {
  const name = String(context?.tournament_name || "");
  if (!name) return;
  const label = context.registration_status === "paused" ? "Pause" : "Checket inn";
  const noteText = context.registration_status === "paused"
    ? "Du er midlertidig satt på pause og blir ikke sendt til ny skive."
    : "Du er checket inn og klar for board-tildeling.";

  for (const root of [document.getElementById("registrationList"), document.getElementById("tournamentList")]) {
    if (!root) continue;
    root.querySelectorAll(".list-item").forEach((item) => {
      const title = item.querySelector("strong")?.textContent?.trim() || "";
      if (title !== name) return;

      if (root.id === "registrationList") {
        const pill = item.querySelector(".pill");
        if (pill && pill.textContent !== label) pill.textContent = label;
      }

      item.querySelectorAll("[data-register], [data-checkin], [data-withdraw]").forEach((button) => {
        if (context.registration_status === "paused" || context.registration_status === "checked_in") button.remove();
      });

      let note = item.querySelector(".pause-managed-note");
      if (!note) {
        note = document.createElement("p");
        note.className = "muted pause-managed-note";
        note.textContent = noteText;
        item.appendChild(note);
      } else if (note.textContent !== noteText) {
        note.textContent = noteText;
      }
    });
  }
}

function render() {
  ensureStyles();
  if (!card) return;
  if (!token()) {
    card.innerHTML = `<p class="muted">Logg inn for å bruke spillerpause.</p>`;
    return;
  }
  if (!context) {
    card.innerHTML = `<p class="muted">Ingen aktiv turnering der du er checket inn akkurat nå.</p>`;
    return;
  }

  const pause = context.break;
  const match = context.match;
  if (pause?.status === "scheduled") {
    card.innerHTML = `
      <div class="break-state">
        <strong>${escapeHtml(context.tournament_name)}</strong>
        <p>Pausen er registrert.</p>
        <p class="muted">Den starter idet ${escapeHtml(pause.after_match_round || match?.round_label || "kampen din")} er ferdig, og varer deretter nøyaktig 7 minutter.</p>
      </div>`;
  } else if (pause?.status === "active") {
    card.innerHTML = `
      <div class="break-state">
        <strong>${escapeHtml(context.tournament_name)} · pause</strong>
        <div class="break-countdown">${clock(remainingSeconds())}</div>
        <p class="muted">Du blir ikke satt opp på ny skive før klokken er ute. Pausen kan ikke forlenges.</p>
      </div>`;
  } else {
    const afterMatch = match && ["assigned", "in_progress"].includes(String(match.status || ""));
    card.innerHTML = `
      <div class="break-state">
        <strong>${escapeHtml(context.tournament_name)}</strong>
        <p class="muted">Pausen varer alltid 7 minutter. ${afterMatch ? "Siden du allerede har en kamp, starter den først når kampen er ferdig." : "Den starter med én gang."}</p>
        <button id="requestPlayerBreak" type="button">${afterMatch ? "Ta 7 min pause etter kampen" : "Ta 7 min pause"}</button>
      </div>`;
    document.getElementById("requestPlayerBreak")?.addEventListener("click", requestBreak);
  }
  patchPortalRendering();
}

async function requestBreak(event) {
  const button = event?.currentTarget;
  if (!context?.tournament_id || refreshBusy) return;
  refreshBusy = true;
  if (button) { button.disabled = true; button.textContent = "Registrerer pause …"; }
  try {
    await api(`/tournaments/${Number(context.tournament_id)}/me/break`, { method: "POST" });
    await refresh();
  } catch (error) {
    card.innerHTML = `<div class="break-state"><strong>Kunne ikke starte pause</strong><p class="muted">${escapeHtml(error.message)}</p></div>`;
  } finally {
    refreshBusy = false;
  }
}

async function refresh() {
  if (refreshBusy && !context) return;
  if (!token()) {
    context = null;
    render();
    return;
  }
  try {
    const data = await api("/me/break-context");
    context = data.context || null;
    fetchedAt = Date.now();
    render();
  } catch (error) {
    if (Number(error.status) === 401) {
      context = null;
      render();
      return;
    }
  }
}

function startTicker() {
  clearInterval(ticker);
  ticker = setInterval(() => {
    if (context?.break?.status === "active") {
      const left = remainingSeconds();
      render();
      if (left <= 0) refresh().catch(() => undefined);
    }
  }, 1000);
}

const observer = new MutationObserver(() => patchPortalRendering());
[document.getElementById("registrationList"), document.getElementById("tournamentList")]
  .filter(Boolean)
  .forEach((node) => observer.observe(node, { childList: true, subtree: true }));

window.addEventListener("storage", (event) => {
  if (event.key === TOKEN_KEY) refresh().catch(() => undefined);
});

ensureStyles();
render();
refresh().catch(() => undefined);
startTicker();
setInterval(() => refresh().catch(() => undefined), 5000);
