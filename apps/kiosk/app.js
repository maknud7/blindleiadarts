const API_ROOT = "../api/v1";
const state = {
  kioskCode: localStorage.getItem("bd:kioskCode") || "",
  snapshot: null,
  pollHandle: null,
};

const elements = {
  kioskSetupForm: document.getElementById("kioskSetupForm"),
  kioskCodeInput: document.getElementById("kioskCodeInput"),
  brandLogo: document.getElementById("brandLogo"),
  brandFallback: document.getElementById("brandFallback"),
  brandTitle: document.getElementById("brandTitle"),
  refreshButton: document.getElementById("refreshButton"),
  startMatchButton: document.getElementById("startMatchButton"),
  undoButton: document.getElementById("undoButton"),
  stateArea: document.getElementById("stateArea"),
  kioskMeta: document.getElementById("kioskMeta"),
  visitForm: document.getElementById("visitForm"),
  scoreInput: document.getElementById("scoreInput"),
  dartsUsedInput: document.getElementById("dartsUsedInput"),
};

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    throw new Error(payload?.error?.message || `Request failed with ${response.status}`);
  }

  return payload.data;
}

async function loadState() {
  if (!state.kioskCode) {
    renderDisconnected();
    return;
  }

  try {
    state.snapshot = await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/state`);
    renderState();
  } catch (error) {
    state.snapshot = null;
    renderError(error.message);
  }
}

function renderDisconnected() {
  elements.kioskMeta.innerHTML = `<span class="pill">Ingen kiosk valgt</span>`;
  elements.stateArea.innerHTML = `
    <div class="waiting">
      <h2>Koble kiosken til et board</h2>
      <p class="muted">Skriv inn kiosk-koden fra adminpanelet for å hente assigned match og lokal scoringsflyt.</p>
    </div>
  `;
  elements.startMatchButton.classList.add("hidden");
}

function renderError(message) {
  elements.kioskMeta.innerHTML = `<span class="pill">${state.kioskCode}</span>`;
  elements.stateArea.innerHTML = `
    <div class="waiting">
      <h2>Klarte ikke å laste kioskstate</h2>
      <p class="muted">${message}</p>
    </div>
  `;
  elements.startMatchButton.classList.add("hidden");
}

function renderState() {
  const snapshot = state.snapshot;
  const kiosk = snapshot.kiosk;

  applyClubBranding(kiosk.club);

  elements.kioskCodeInput.value = kiosk.code;
  elements.kioskMeta.innerHTML = `
    <span class="pill">${kiosk.name}</span>
    <span class="pill">Board ${kiosk.board_number}</span>
    ${kiosk.sponsor_label ? `<span class="pill">${kiosk.sponsor_label}</span>` : ""}
  `;

  if (snapshot.state === "idle") {
    elements.startMatchButton.classList.add("hidden");
    elements.stateArea.innerHTML = `
      <div class="waiting">
        <h2>Venter på ny kamp</h2>
        <p class="muted">${snapshot.message || "Ingen assigned kamp på denne kiosken akkurat nå."}</p>
      </div>
    `;
    return;
  }

  const match = snapshot.match;
  const currentPlayerId = match.current_player_id;
  const recentVisits = (match.recent_visits || []).map((visit) => `
    <div class="visit-item">
      <strong>${visit.player_name}</strong>
      <p class="muted">Visit ${visit.visit_number} · Score ${visit.score}${Number(visit.is_bust) === 1 ? " · Bust" : ""}</p>
    </div>
  `).join("");

  elements.startMatchButton.classList.toggle("hidden", snapshot.state !== "assigned");
  elements.stateArea.innerHTML = `
    <div class="match-card">
      <div class="row">
        <div>
          <p class="eyebrow">${match.round_label || "Kamp"}</p>
          <h2>${match.player_a.display_name} vs ${match.player_b.display_name}</h2>
          <p class="muted">${match.bracket_label || "Lokal runtime"} · ${match.status}</p>
        </div>
      </div>
      <div class="score-grid">
        <div class="player-box ${currentPlayerId === match.player_a.id ? "active" : ""}">
          <p>${match.player_a.display_name}</p>
          <strong>${match.player_a.remaining}</strong>
          <p class="muted">${match.player_a.legs_won} legs vunnet</p>
        </div>
        <div class="player-box ${currentPlayerId === match.player_b.id ? "active" : ""}">
          <p>${match.player_b.display_name}</p>
          <strong>${match.player_b.remaining}</strong>
          <p class="muted">${match.player_b.legs_won} legs vunnet</p>
        </div>
      </div>
      <div class="pill">
        Leg ${match.current_leg.leg_number} · Første spiller ${match.current_leg.starting_player_id}
      </div>
    </div>
    <div class="stack">
      ${recentVisits || `<div class="visit-item"><p class="muted">Ingen visits registrert ennå.</p></div>`}
    </div>
  `;
}

function applyClubBranding(club) {
  const initials = (club?.name || "Klubb")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  elements.brandTitle.textContent = club?.name
    ? `${club.name} kiosk`
    : "Board-side matchflyt";
  elements.brandFallback.textContent = initials || "KL";

  if (club?.logo_url) {
    elements.brandLogo.src = club.logo_url;
    elements.brandLogo.alt = `${club.name} logo`;
    elements.brandLogo.classList.remove("hidden");
    elements.brandFallback.classList.add("hidden");
  } else {
    elements.brandLogo.removeAttribute("src");
    elements.brandLogo.classList.add("hidden");
    elements.brandFallback.classList.remove("hidden");
  }
}

async function startMatch() {
  if (!state.kioskCode) {
    return;
  }

  state.snapshot = await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/start-match`, { method: "POST" });
  renderState();
}

async function submitVisit(score) {
  if (!state.kioskCode) {
    return;
  }

  const value = Number(score ?? elements.scoreInput.value);

  if (Number.isNaN(value)) {
    return;
  }

  state.snapshot = await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/visit`, {
    method: "POST",
    body: {
      score: value,
      darts_used: Number(elements.dartsUsedInput.value || 3),
      input_mode: "sum",
    },
  });

  elements.scoreInput.value = "";
  renderState();
}

async function undoVisit() {
  if (!state.kioskCode) {
    return;
  }

  state.snapshot = await api(`/kiosks/${encodeURIComponent(state.kioskCode)}/undo`, { method: "POST" });
  renderState();
}

function startPolling() {
  if (state.pollHandle) {
    window.clearInterval(state.pollHandle);
  }

  state.pollHandle = window.setInterval(() => {
    loadState().catch(() => undefined);
  }, 5000);
}

function bindEvents() {
  elements.kioskSetupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    state.kioskCode = elements.kioskCodeInput.value.trim();
    localStorage.setItem("bd:kioskCode", state.kioskCode);
    await loadState();
    startPolling();
  });

  elements.refreshButton.addEventListener("click", () => loadState());
  elements.startMatchButton.addEventListener("click", () => startMatch().catch((error) => renderError(error.message)));
  elements.undoButton.addEventListener("click", () => undoVisit().catch((error) => renderError(error.message)));

  elements.visitForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      await submitVisit();
    } catch (error) {
      renderError(error.message);
    }
  });

  document.querySelectorAll("[data-score]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await submitVisit(Number(button.dataset.score));
      } catch (error) {
        renderError(error.message);
      }
    });
  });
}

async function bootstrap() {
  bindEvents();
  elements.kioskCodeInput.value = state.kioskCode;
  await loadState();
  startPolling();
}

bootstrap();
