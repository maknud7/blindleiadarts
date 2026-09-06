const API_ROOT = "../api/v1";
const TOKEN_KEY = "bd:token";
const card = document.getElementById("playerBreakCard");
const section = document.getElementById("playerBreakSection");

let context = null;
let fetchedAt = 0;
let refreshBusy = false;
let ticker = null;
let lastError = "";

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
    #playerBreakSection.player-break-available{display:block!important}
    .break-countdown{font-size:clamp(2.7rem,12vw,5rem);line-height:1;font-weight:900;letter-spacing:-.05em;margin:.25rem 0}
    .break-state{display:grid;gap:.65rem}
    .break-state button{width:100%}
    .pause-managed-note{margin:.5rem 0 0}
    .hub-player-break-inline{display:flex;align-items:center;justify-content:space-between;gap:.8rem;padding:.75rem .9rem;border:1px solid var(--line);border-radius:14px;background:var(--surface-soft,rgba(255,255,255,.04))}
    .hub-player-break-inline>div{display:grid;gap:.12rem;min-width:0}
    .hub-player-break-inline strong{font-size:.94rem}
    .hub-player-break-inline small{color:var(--muted)}
    .hub-player-break-inline button{flex:0 0 auto;white-space:nowrap}
    .hub-player-break-inline .hub-break-clock{font-size:1.15rem;font-variant-numeric:tabular-nums}
    .hub-player-break-inline .hub-break-error{color:var(--danger,#b42318)}
    @media(max-width:620px){.hub-player-break-inline{align-items:stretch;flex-direction:column}.hub-player-break-inline button{width:100%}}
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

function inlineBreakState() {
  const pause = context?.break;
  const match = context?.match;
  if (pause?.status === "scheduled") {
    return {
      signature: `scheduled:${Number(pause.after_match_id || 0)}:${lastError}`,
      html: `<div><strong>Pause registrert</strong><small>Starter etter ${escapeHtml(pause.after_match_round || match?.round_label || "denne kampen")} og varer i 7 minutter.${lastError ? ` <span class="hub-break-error">${escapeHtml(lastError)}</span>` : ""}</small></div>`,
    };
  }
  if (pause?.status === "active") {
    const left = remainingSeconds();
    return {
      signature: `active:${left}:${lastError}`,
      html: `<div><strong>På pause</strong><small>Du blir ikke sendt til ny skive før pausen er ferdig.${lastError ? ` <span class="hub-break-error">${escapeHtml(lastError)}</span>` : ""}</small></div><strong class="hub-break-clock">${clock(left)}</strong>`,
    };
  }

  const afterMatch = match && ["assigned", "in_progress"].includes(String(match.status || ""));
  const label = afterMatch ? "Ta 7 min pause etter kampen" : "Ta 7 min pause";
  const note = afterMatch ? "Pausen starter når kampen din er ferdig." : "Du tas ut av kampkøen i 7 minutter.";
  return {
    signature: `available:${afterMatch ? "after" : "now"}:${refreshBusy ? "busy" : "ready"}:${lastError}`,
    html: `<div><strong>Spillerpause</strong><small>${escapeHtml(note)}${lastError ? ` <span class="hub-break-error">${escapeHtml(lastError)}</span>` : ""}</small></div><button type="button" class="ghost" data-player-break-request ${refreshBusy ? "disabled" : ""}>${refreshBusy ? "Registrerer …" : escapeHtml(label)}</button>`,
  };
}

function patchActiveTournamentRendering() {
  const hub = document.getElementById("activeTournamentHub");
  if (!hub) return;

  let slot = hub.querySelector(".hub-player-break-inline");
  const heading = hub.querySelector(".hub-heading h2")?.textContent?.trim() || "";
  const sameTournament = Boolean(context && (!heading || heading === String(context.tournament_name || "")));
  if (!token() || !sameTournament || hub.classList.contains("hidden")) {
    slot?.remove();
    return;
  }

  const anchor = hub.querySelector(".hub-personal-strip") || hub.querySelector(".hub-heading");
  if (!anchor) return;
  if (!slot) {
    slot = document.createElement("div");
    slot.className = "hub-player-break-inline";
    slot.addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-player-break-request]");
      if (button) requestBreak({ currentTarget: button });
    });
    anchor.insertAdjacentElement("afterend", slot);
  }

  const next = inlineBreakState();
  if (slot.dataset.breakSignature !== next.signature) {
    slot.dataset.breakSignature = next.signature;
    slot.innerHTML = next.html;
  }
}

function render() {
  ensureStyles();
  section?.classList.toggle("player-break-available", Boolean(token() && context));
  if (!card) {
    patchActiveTournamentRendering();
    return;
  }
  if (!token()) {
    card.innerHTML = `<p class="muted">Logg inn for å bruke spillerpause.</p>`;
    patchActiveTournamentRendering();
    return;
  }
  if (!context) {
    card.innerHTML = `<p class="muted">Ingen aktiv turnering der du er checket inn akkurat nå.</p>`;
    patchActiveTournamentRendering();
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
        ${lastError ? `<p class="muted">${escapeHtml(lastError)}</p>` : ""}
      </div>`;
  } else if (pause?.status === "active") {
    card.innerHTML = `
      <div class="break-state">
        <strong>${escapeHtml(context.tournament_name)} · pause</strong>
        <div class="break-countdown">${clock(remainingSeconds())}</div>
        <p class="muted">Du blir ikke satt opp på ny skive før klokken er ute. Pausen kan ikke forlenges.</p>
        ${lastError ? `<p class="muted">${escapeHtml(lastError)}</p>` : ""}
      </div>`;
  } else {
    const afterMatch = match && ["assigned", "in_progress"].includes(String(match.status || ""));
    card.innerHTML = `
      <div class="break-state">
        <strong>${escapeHtml(context.tournament_name)}</strong>
        <p class="muted">Pausen varer alltid 7 minutter. ${afterMatch ? "Siden du allerede har en kamp, starter den først når kampen er ferdig." : "Den starter med én gang."}</p>
        ${lastError ? `<p class="muted">${escapeHtml(lastError)}</p>` : ""}
        <button type="button" data-player-break-request>${afterMatch ? "Ta 7 min pause etter kampen" : "Ta 7 min pause"}</button>
      </div>`;
    card.querySelector("[data-player-break-request]")?.addEventListener("click", requestBreak);
  }
  patchPortalRendering();
  patchActiveTournamentRendering();
}

async function requestBreak(event) {
  const button = event?.currentTarget;
  if (!context?.tournament_id || refreshBusy) return;
  refreshBusy = true;
  lastError = "";
  if (button) { button.disabled = true; button.textContent = "Registrerer pause …"; }
  patchActiveTournamentRendering();
  try {
    await api(`/tournaments/${Number(context.tournament_id)}/me/break`, { method: "POST" });
    await refresh();
  } catch (error) {
    lastError = error.message || "Kunne ikke starte pause.";
    render();
  } finally {
    refreshBusy = false;
    patchActiveTournamentRendering();
  }
}

async function refresh() {
  if (refreshBusy && !context) return;
  if (!token()) {
    context = null;
    lastError = "";
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
      lastError = "";
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

const observer = new MutationObserver(() => {
  patchPortalRendering();
  patchActiveTournamentRendering();
});
[
  document.getElementById("registrationList"),
  document.getElementById("tournamentList"),
  document.getElementById("activeTournamentHub"),
]
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