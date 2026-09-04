const KIOSK_RUNTIME_VERSION = "20260904-runtime-sync-01";
const kioskBrandStyles = document.createElement("link");
kioskBrandStyles.rel = "stylesheet";
kioskBrandStyles.href = `./brand-light.css?v=${KIOSK_RUNTIME_VERSION}`;
document.head.appendChild(kioskBrandStyles);

document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#0b3145");
document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.setAttribute("content", "default");

function ensureExtendedKioskRuntime() {
  if (!document.getElementById("prodTestEntryStyles")) {
    const css = document.createElement("link");
    css.id = "prodTestEntryStyles";
    css.rel = "stylesheet";
    css.href = `./prod-test-entry.css?v=${KIOSK_RUNTIME_VERSION}`;
    document.head.appendChild(css);
  }

  const load = (id, src) => new Promise((resolve) => {
    if (document.getElementById(id)) { resolve(); return; }
    const script = document.createElement("script");
    script.id = id;
    script.src = src;
    script.async = false;
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", () => {
      console.warn(`Kunne ikke laste kiosk-runtime: ${src}`);
      resolve();
    }, { once: true });
    document.body.appendChild(script);
  });

  load("prodTestEntryRuntime", `./prod-test-entry.js?v=${KIOSK_RUNTIME_VERSION}`)
    .then(() => load("scoliaRuntime", `./scolia-runtime.js?v=${KIOSK_RUNTIME_VERSION}`));
}

ensureExtendedKioskRuntime();

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
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("./service-worker.js", {
        scope: "./",
        updateViaCache: "none",
      });
      await registration.update().catch(() => undefined);
    } catch (error) {
      console.warn("Kiosk service worker kunne ikke registreres:", error);
    }
  });
}

const observer = new MutationObserver(() => installButton());
observer.observe(document.documentElement, { childList: true, subtree: true });
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installButton, { once: true });
else installButton();
