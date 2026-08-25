let deferredInstallPrompt = null;

const isStandalone = () => window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent || "");

function installButton() {
  const actions = document.querySelector("#settingsDialog .settings-actions");
  if (!actions || document.getElementById("installKioskButton") || isStandalone()) return null;
  const button = document.createElement("button");
  button.id = "installKioskButton";
  button.type = "button";
  button.className = "ghost-button";
  button.textContent = "Installer på nettbrett";
  actions.prepend(button);
  button.addEventListener("click", async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice.catch(() => null);
      deferredInstallPrompt = null;
      button.classList.add("hidden");
      return;
    }
    const meta = document.getElementById("settingsMeta");
    if (!meta) return;
    const text = isIos()
      ? "På iPad/iPhone: trykk Del i Safari og velg «Legg til på Hjem-skjermen». Start deretter Blindleia Board fra ikonet."
      : "Åpne nettlesermenyen og velg «Installer app» eller «Legg til på startskjermen». Terminalen åpnes deretter som egen app.";
    const note = document.createElement("div");
    note.className = "install-note";
    note.textContent = text;
    meta.prepend(note);
  });
  return button;
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installButton()?.classList.remove("hidden");
});
window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  document.getElementById("installKioskButton")?.classList.add("hidden");
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js", { scope: "./" }).catch((error) => console.warn("Kiosk service worker kunne ikke registreres:", error)));
}

const observer = new MutationObserver(() => installButton());
observer.observe(document.documentElement, { childList: true, subtree: true });
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installButton, { once: true });
else installButton();