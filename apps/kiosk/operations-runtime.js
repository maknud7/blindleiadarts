(() => {
  const idle = document.getElementById("idleState");
  if (!idle) return;

  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "./operations-runtime.css";
  document.head.appendChild(css);

  const panel = document.createElement("div");
  panel.className = "post-match-panel";
  panel.innerHTML = `
    <div id="opsResult" class="post-match-result hidden">
      <p class="eyebrow">Kampen er registrert</p>
      <h3 id="opsWinner">—</h3>
      <p id="opsScore" class="muted">—</p>
      <p class="post-match-hint">Sjekk resultatet før boardet går videre. «Angre siste» åpner kampen igjen.</p>
    </div>
    <div class="post-match-actions">
      <button id="opsUndo" type="button" class="ghost-button hidden">Angre siste</button>
      <button id="opsNext" type="button" class="start-match">Klar for neste kamp</button>
    </div>
    <p id="opsStatus" class="muted post-match-status"></p>`;
  idle.appendChild(panel);

  const result = document.getElementById("opsResult");
  const winner = document.getElementById("opsWinner");
  const score = document.getElementById("opsScore");
  const undo = document.getElementById("opsUndo");
  const next = document.getElementById("opsNext");
  const status = document.getElementById("opsStatus");
  let mutating = false;
  let lastMatchId = 0;

  function kioskCode() { return localStorage.getItem("bd:kioskCode") || ""; }
  function pairingToken() { return localStorage.getItem("bd:kioskPairingToken") || ""; }
  function headers() {
    const token = pairingToken();
    return token ? { "X-Kiosk-Pairing-Token": token } : {};
  }
  async function request(path, options = {}) {
    const response = await fetch(`../api/v1${path}`, {
      ...options,
      headers: { ...headers(), ...(options.headers || {}) },
      cache: "no-store",
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  }
  function isIdleVisible() { return !idle.classList.contains("hidden"); }

  async function refreshPostMatch() {
    const code = kioskCode();
    if (!code || !isIdleVisible() || mutating) return;
    try {
      const data = await request(`/kiosks/${encodeURIComponent(code)}/post-match`);
      const match = data.last_completed_match || null;
      lastMatchId = Number(match?.id || 0);
      if (!match) {
        result.classList.add("hidden");
        undo.classList.add("hidden");
        status.textContent = "Boardet er ledig. Hent neste kvalifiserte kamp fra køen.";
        return;
      }
      result.classList.remove("hidden");
      undo.classList.remove("hidden");
      winner.textContent = `${match.winner_name || "Resultat"} vant`;
      score.textContent = `${match.player_a_name} ${Number(match.legs_a || 0)}–${Number(match.legs_b || 0)} ${match.player_b_name} · ${match.round_label || match.bracket_label || match.tournament_name}`;
      status.textContent = "Resultatet kan fortsatt korrigeres før du går videre.";
    } catch {
      // The normal kiosk runtime handles connectivity; keep this panel quiet.
    }
  }

  async function nextMatch() {
    if (mutating) return;
    const code = kioskCode();
    if (!code) return;
    mutating = true;
    next.disabled = true;
    undo.disabled = true;
    status.textContent = "Henter neste kamp …";
    try {
      const data = await request(`/kiosks/${encodeURIComponent(code)}/next-match`, { method: "POST" });
      if (data.assignment?.assigned) {
        status.textContent = "Neste kamp er klar.";
        window.location.reload();
        return;
      }
      const reason = data.assignment?.reason;
      status.textContent = reason === "auto_assign_disabled"
        ? "Automatisk kampflyt er slått av for turneringen."
        : reason === "no_ready_match"
          ? "Ingen ledig kamp akkurat nå. Spillere kan være opptatt eller ikke checket inn."
          : "Ingen aktiv turnering eller kamp er klar for dette boardet.";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      mutating = false;
      next.disabled = false;
      undo.disabled = false;
      refreshPostMatch().catch(() => undefined);
    }
  }

  async function undoLast() {
    if (mutating || !lastMatchId) return;
    const code = kioskCode();
    if (!code) return;
    mutating = true;
    next.disabled = true;
    undo.disabled = true;
    status.textContent = "Åpner siste kast igjen …";
    try {
      await request(`/kiosks/${encodeURIComponent(code)}/undo`, { method: "POST" });
      window.location.reload();
    } catch (error) {
      status.textContent = error.message;
      mutating = false;
      next.disabled = false;
      undo.disabled = false;
    }
  }

  next.addEventListener("click", nextMatch);
  undo.addEventListener("click", undoLast);
  window.setInterval(() => refreshPostMatch().catch(() => undefined), 1500);
  refreshPostMatch().catch(() => undefined);
})();

import("./scolia-runtime.js").catch((error) => console.warn("Scolia runtime kunne ikke lastes:", error));
