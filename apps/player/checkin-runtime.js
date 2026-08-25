const API_ROOT = "../api/v1";

function token() {
  return localStorage.getItem("bd:token") || "";
}

function statusArea() {
  return document.getElementById("statusArea");
}

function showStatus(message, tone = "info") {
  const root = statusArea();
  if (!root) {
    window.alert(message);
    return;
  }
  const card = document.createElement("div");
  card.className = "mini-card";
  const title = tone === "error" ? "Check-in feilet" : tone === "success" ? "Check-in OK" : "Check-in";
  card.innerHTML = `<strong>${title}</strong><p class="muted"></p>`;
  card.querySelector("p").textContent = message;
  root.prepend(card);
  while (root.children.length > 4) root.lastElementChild?.remove();
  root.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function api(path, { method = "GET", body } = {}) {
  const headers = { Authorization: `Bearer ${token()}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  }
  return payload.data;
}

function position() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Denne enheten støtter ikke posisjon. Kontakt arrangør for manuell check-in."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (result) => resolve(result),
      (error) => {
        const message = error.code === 1
          ? "Du må tillate posisjon for å checke inn på arenaen."
          : error.code === 3
            ? "Telefonen brukte for lang tid på å finne posisjonen. Prøv igjen nær inngangen/lokalet."
            : "Kunne ikke finne posisjonen din. Slå på presis posisjon og prøv igjen.";
        reject(new Error(message));
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  });
}

async function doCheckin(tournamentId, button) {
  if (!token()) throw new Error("Logg inn før du checker inn.");
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Sjekker …";
  try {
    const status = await api(`/tournaments/${tournamentId}/check-in-status`);
    if (status.window_state === "not_open") {
      throw new Error(`Check-in er ikke åpnet ennå. Den åpner ${String(status.opens_at).replace(" ", " kl. ")}.`);
    }
    if (status.window_state === "closed") {
      throw new Error("Check-in er stengt. Kontakt arrangør hvis du har kommet sent.");
    }

    let body = {};
    if (status.require_onsite) {
      showStatus(`Check-in krever at du er på arenaen (ca. ${Number(status.radius_meters || 0)} m radius). Finner posisjonen din …`);
      const geo = await position();
      body = {
        latitude: geo.coords.latitude,
        longitude: geo.coords.longitude,
        accuracy_meters: geo.coords.accuracy,
      };
    }

    const data = await api(`/tournaments/${tournamentId}/check-in`, { method: "POST", body });
    const distance = data.registration?.distance_meters;
    showStatus(
      distance == null
        ? "Du er checket inn og klar for turneringen."
        : `Du er checket inn på arenaen${Number.isFinite(Number(distance)) ? ` (${Math.round(Number(distance))} m fra registrert arena-posisjon)` : ""}.`,
      "success"
    );
    window.setTimeout(() => window.location.reload(), 650);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

// Capture phase intentionally takes ownership of existing data-checkin buttons before the
// legacy click handlers in app.js. Registration and all other portal actions remain untouched.
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-checkin]") : null;
  if (!target) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const tournamentId = Number(target.getAttribute("data-checkin") || 0);
  if (!tournamentId) return;
  doCheckin(tournamentId, target).catch((error) => showStatus(error.message, "error"));
}, true);
