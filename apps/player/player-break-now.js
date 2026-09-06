const nowCard = document.getElementById("playerNowCard");
const breakCard = document.getElementById("playerBreakCard");

let syncing = false;

function token() {
  return localStorage.getItem("bd:token") || "";
}

function currentSituation() {
  return String(document.body.dataset.playerSituation || "");
}

function mirrorLabel() {
  const sourceButton = breakCard?.querySelector("[data-player-break-request]");
  if (sourceButton) {
    return {
      label: sourceButton.textContent?.trim() || "Ta 7 min pause",
      disabled: Boolean(sourceButton.disabled),
      mode: "request",
    };
  }

  const countdown = breakCard?.querySelector(".break-countdown")?.textContent?.trim();
  if (countdown) {
    return {
      label: `På pause · ${countdown}`,
      disabled: true,
      mode: "active",
    };
  }

  const text = String(breakCard?.textContent || "").replace(/\s+/g, " ").trim();
  if (text.includes("Pausen er registrert")) {
    return {
      label: "Pause etter kampen registrert",
      disabled: true,
      mode: "scheduled",
    };
  }

  return null;
}

function removeMirror() {
  document.querySelectorAll("[data-player-break-now]").forEach((button) => button.remove());
}

function syncNowBreakAction() {
  if (syncing) return;
  syncing = true;
  try {
    const card = document.getElementById("playerNowCard");
    const actions = card?.querySelector(".player-now-actions");
    const situation = currentSituation();
    const supported = ["pending_match", "assigned_match", "live_match", "waiting"].includes(situation);
    const state = token() && supported ? mirrorLabel() : null;

    if (!actions || !state) {
      removeMirror();
      return;
    }

    let button = actions.querySelector("[data-player-break-now]");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "ghost player-now-break-action";
      button.dataset.playerBreakNow = "1";
      const tournamentButton = actions.querySelector("[data-px-tournament]");
      if (tournamentButton) actions.insertBefore(button, tournamentButton);
      else actions.appendChild(button);
    }

    button.textContent = state.label;
    button.disabled = state.disabled;
    button.dataset.breakMode = state.mode;
    button.onclick = state.mode === "request"
      ? () => {
          const source = breakCard?.querySelector("[data-player-break-request]");
          if (!source || source.disabled) return;
          button.disabled = true;
          button.textContent = "Registrerer pause …";
          source.click();
        }
      : null;
  } finally {
    syncing = false;
  }
}

const observer = new MutationObserver(() => window.requestAnimationFrame(syncNowBreakAction));
if (breakCard) observer.observe(breakCard, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled"] });
observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-player-situation"] });

window.addEventListener("bd:player-state-changed", syncNowBreakAction);
window.addEventListener("storage", (event) => {
  if (event.key === "bd:token") syncNowBreakAction();
});

syncNowBreakAction();
