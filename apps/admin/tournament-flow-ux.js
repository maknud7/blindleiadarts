const API_ROOT = "../api/v1";
const host = document.getElementById("tournaments");

if (host) {
  let checkinBusy = false;

  function token() {
    return localStorage.getItem("bd:token") || "";
  }

  async function api(path, { method = "GET", body } = {}) {
    const headers = {};
    if (token()) headers.Authorization = `Bearer ${token()}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${API_ROOT}${path}`, {
      method,
      headers,
      cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      const error = new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
      error.code = payload?.error?.code || "request_failed";
      throw error;
    }
    return payload.data;
  }

  function currentTournamentId() {
    return Number(document.getElementById("tcTournament")?.value || window.__bdTournamentContext?.id || 0);
  }

  function inlineStatus(row, text, tone = "info") {
    if (!row) return;
    let node = row.querySelector(".tc-inline-action-status");
    if (!node) {
      node = document.createElement("div");
      node.className = "tc-inline-action-status";
      row.appendChild(node);
    }
    node.textContent = text;
    node.dataset.tone = tone;
  }

  async function handleCheckin(button) {
    if (checkinBusy) return;
    const tournamentId = currentTournamentId();
    const playerId = Number(button.dataset.playerId || 0);
    const row = button.closest(".tc-registration");
    if (!tournamentId || !playerId) return;

    checkinBusy = true;
    button.disabled = true;
    const oldText = button.textContent;
    button.textContent = "Sjekker inn …";
    inlineStatus(row, "Registrerer oppmøte …");

    try {
      // I adminrommet er dette en eksplisitt manuell innsjekk. Tidsvinduet skal
      // ikke tvinge turneringsleder gjennom en ekstra browser-confirm.
      await api(`/tournaments/${tournamentId}/admin-check-in/${playerId}`, {
        method: "POST",
        body: { force: true },
      });
      inlineStatus(row, "✓ Sjekket inn", "success");
      window.setTimeout(() => document.getElementById("tcRefresh")?.click(), 120);
    } catch (error) {
      inlineStatus(row, error.message, "error");
      button.disabled = false;
      button.textContent = oldText || "Sjekk inn";
    } finally {
      checkinBusy = false;
    }
  }

  function bypassBrowserConfirmForThisClick() {
    const original = window.confirm;
    const bypass = () => true;
    window.confirm = bypass;
    window.setTimeout(() => {
      if (window.confirm === bypass) window.confirm = original;
    }, 0);
  }

  host.addEventListener("click", (event) => {
    const checkin = event.target.closest(".tc-checkin");
    if (checkin && host.contains(checkin)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      handleCheckin(checkin);
      return;
    }

    // Startknappen forklarer allerede konsekvensen rett over knappen og har
    // spillerantallet i selve teksten. Unngå et ekstra browser-popup oppå det.
    if (event.target.closest("#tcStart")) {
      bypassBrowserConfirmForThisClick();
      return;
    }

    // Kodebytte er en eksplisitt handling i avanserte innsjekk-innstillinger.
    // Hold også denne i samme arbeidsflate uten browser-popup.
    if (event.target.closest("#tcRotateCode")) {
      bypassBrowserConfirmForThisClick();
    }
  }, true);

  const style = document.createElement("style");
  style.id = "tournamentFlowUxStyles";
  style.textContent = `
    .tc-inline-action-status{grid-column:1/-1;margin-top:7px;font-size:12px;color:var(--muted)}
    .tc-inline-action-status[data-tone="success"]{color:#216149}
    .tc-inline-action-status[data-tone="error"]{color:#a83a3a}
    .tc-stage .tc-embedded-tool{margin:14px 0 0;padding:14px 0 0;border-top:1px solid var(--line)}
    .tc-stage .tc-embedded-tool.tournament-control{border-top:1px solid var(--line)}
    #tcBrowse{display:none!important}
  `;
  document.head.appendChild(style);
}
