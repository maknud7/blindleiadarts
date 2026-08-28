(() => {
  const button = document.getElementById("refreshButton");
  const actions = document.querySelector("#settingsDialog .settings-actions");
  if (!button || !actions) return;

  button.textContent = "Last inn terminal på nytt";
  button.setAttribute("aria-describedby", "terminalRefreshHelp");

  if (!document.getElementById("terminalRefreshHelp")) {
    const help = document.createElement("p");
    help.id = "terminalRefreshHelp";
    help.className = "terminal-refresh-help";
    help.textContent = "Henter siste kioskversjon og kampstatus. Skive og pairing beholdes.";
    actions.insertBefore(help, button);
  }

  async function hardRefresh() {
    if (button.dataset.refreshing === "1") return;
    button.dataset.refreshing = "1";
    button.disabled = true;
    button.textContent = "Henter ny versjon …";

    try {
      // Remove only the kiosk shell caches. Pairing and active match state live in
      // localStorage/server state and must survive this recovery action.
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((key) => key.startsWith("bd-kiosk-shell-"))
            .map((key) => caches.delete(key))
        );
      }

      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.update().catch(() => undefined)));
      }
    } catch (error) {
      console.warn("Kunne ikke tømme kiosk-cache før reload:", error);
    }

    const url = new URL(window.location.href);
    url.searchParams.set("terminal_refresh", String(Date.now()));
    window.location.replace(url.toString());
  }

  // Capture phase is intentional: app.js has a lightweight state-refresh handler
  // on the same button. This recovery action must take precedence and perform a
  // full shell reload instead.
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    hardRefresh();
  }, { capture: true });
})();
