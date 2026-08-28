const HOST_IS_TEST = /(^|[.-])test([.-]|$)/i.test(window.location.hostname);
const QUERY_IS_TEST = new URLSearchParams(window.location.search).get("pwa") === "test";
const IS_TEST = HOST_IS_TEST || QUERY_IS_TEST || document.body?.dataset?.appEnv === "test";
const APP_NAME = IS_TEST ? "Blindleia Darts TEST" : "Blindleia Darts";
const LOGO_URL = new URL(
  IS_TEST ? "../static/club-logos/blindleia-dartklubb-test.svg" : "../static/club-logos/blindleia-dartklubb-logo.png",
  import.meta.url
).href;
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

function applyEnvironmentBranding() {
  if (!IS_TEST) return;
  document.documentElement.dataset.appEnv = "test";
  if (document.body) document.body.dataset.appEnv = "test";
  document.title = APP_NAME;

  const theme = document.querySelector('meta[name="theme-color"]');
  if (theme) theme.setAttribute("content", "#f3c23c");

  const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (appleTitle) appleTitle.setAttribute("content", APP_NAME);

  const icon = document.querySelector('link[rel="icon"]');
  if (icon) {
    icon.setAttribute("href", LOGO_URL);
    icon.setAttribute("type", "image/svg+xml");
  }
  const touchIcon = document.querySelector('link[rel="apple-touch-icon"]');
  if (touchIcon) touchIcon.setAttribute("href", LOGO_URL);
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
      <img src="${LOGO_URL}" alt="${APP_NAME}">
      <div><strong>${APP_NAME} er installert</strong><p>Du kan åpne spillerportalen direkte fra Hjem-skjermen.</p></div>
      <span class="pwa-installed-badge">Installert</span>`;
    return;
  }

  const instructions = isIos()
    ? `På iPhone: trykk Del i Safari og velg «Legg til på Hjem-skjerm». ${IS_TEST ? "Se etter den gule TEST-logoen." : ""}`
    : deferredInstallPrompt
      ? `Installer ${APP_NAME} som en egen app. Innloggingen beholdes, og appen åpner rett på spillerportalen.`
      : "Åpne nettlesermenyen og velg «Installer app» eller «Legg til på startskjermen».";

  card.innerHTML = `
    <img src="${LOGO_URL}" alt="${APP_NAME}">
    <div class="pwa-install-copy"><strong>Ha ${APP_NAME} på mobilen</strong><p>${instructions}</p></div>
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

async function registerCanonicalServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const rootUrl = new URL("../", import.meta.url);
  const workerUrl = new URL("../api/pwa-service-worker.php", import.meta.url);

  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      registrations
        .filter((registration) => new URL(registration.scope).pathname.includes("/player/"))
        .map((registration) => registration.unregister().catch(() => false))
    );
    await navigator.serviceWorker.register(workerUrl.href, { scope: rootUrl.pathname });
  } catch (error) {
    console.warn("PWA service worker kunne ikke registreres", error);
  }
}

applyEnvironmentBranding();
ensureInstallCard();
window.addEventListener("load", registerCanonicalServiceWorker, { once: true });
