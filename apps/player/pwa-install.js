const LOGO_URL = "../static/club-logos/blindleia-dartklubb-logo.png";
let deferredInstallPrompt = null;

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function isIos() {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

function isMobileLike() {
  return isIos() || /android/i.test(window.navigator.userAgent) || window.matchMedia("(pointer: coarse)").matches;
}

function ensureInstallCard() {
  const profileSection = document.querySelector('[data-portal-section="profile"]');
  if (!profileSection || document.getElementById("pwaInstallCard") || !isMobileLike()) return;

  const card = document.createElement("div");
  card.id = "pwaInstallCard";
  card.className = "pwa-install-card";
  profileSection.appendChild(card);
  renderInstallCard();
}

function renderInstallCard() {
  const card = document.getElementById("pwaInstallCard");
  if (!card) return;

  if (isStandalone()) {
    card.innerHTML = `
      <img src="${LOGO_URL}" alt="Blindleia Dartklubb">
      <div><strong>Blindleia Darts er installert</strong><p>Du kan åpne spillerportalen direkte fra Hjem-skjermen.</p></div>
      <span class="pwa-installed-badge">Installert</span>`;
    return;
  }

  const instructions = isIos()
    ? "På iPhone: trykk Del i Safari og velg «Legg til på Hjem-skjerm»."
    : deferredInstallPrompt
      ? "Installer spillerportalen som en app. Innloggingen beholdes, og appen åpner rett på Blindleia Darts."
      : "Åpne nettlesermenyen og velg «Installer app» eller «Legg til på startskjermen».";

  card.innerHTML = `
    <img src="${LOGO_URL}" alt="Blindleia Dartklubb">
    <div class="pwa-install-copy"><strong>Ha Blindleia Darts på mobilen</strong><p>${instructions}</p></div>
    ${deferredInstallPrompt ? '<button id="pwaInstallButton" type="button">Installer</button>' : ""}`;

  document.getElementById("pwaInstallButton")?.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    const prompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    await prompt.prompt();
    await prompt.userChoice.catch(() => undefined);
    renderInstallCard();
  });
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  ensureInstallCard();
  renderInstallCard();
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  renderInstallCard();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js", { scope: "./" }).catch((error) => {
      console.warn("PWA service worker kunne ikke registreres", error);
    });
  });
}

ensureInstallCard();
import("./player-now.js?v=20260828-1145").catch((error) => console.warn("Akkurat nå-modulen kunne ikke lastes", error));
