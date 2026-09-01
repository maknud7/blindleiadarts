(() => {
  const params = new URLSearchParams(window.location.search);
  const onTestHost = /^test\./i.test(window.location.hostname) || /(^|\.)test([.-]|$)/i.test(window.location.hostname);
  if (!onTestHost) return;

  const TEST_MODE_KEY = "bd:kioskTestMode";
  const TEST_BOARD_ID_KEY = "bd:kioskTestPhysicalBoardId";
  const TEST_BOARD_LABEL_KEY = "bd:kioskTestBoardLabel";
  const TEST_RETURN_URL_KEY = "bd:kioskTestReturnUrl";
  const TEST_EMBEDDED_KEY = "bd:kioskTestEmbedded";
  const TEST_SESSION_AUTH_KEY = "bd:kioskTestLaunchAuthorized";

  function prodHost() {
    return window.location.hostname.replace(/^test\./i, "");
  }

  function safeProdReturnUrl(raw) {
    if (!raw) return "";
    try {
      const candidate = new URL(raw);
      if (candidate.protocol !== window.location.protocol || candidate.hostname !== prodHost()) return "";
      if (!candidate.pathname.startsWith("/kiosk")) return "";
      return candidate.href;
    } catch {
      return "";
    }
  }

  function redirectToProdKiosk() {
    const target = new URL(window.location.href);
    target.hostname = prodHost();
    target.pathname = "/kiosk/";
    target.search = "";
    target.hash = "";
    document.documentElement.style.visibility = "hidden";
    window.location.replace(target.href);
  }

  const freshReturnUrl = safeProdReturnUrl(params.get("return_url") || "");
  const storedReturnUrl = safeProdReturnUrl(localStorage.getItem(TEST_RETURN_URL_KEY) || "");
  const freshLaunch = params.get("testmode") === "1" && Boolean(freshReturnUrl);
  const activeSession = localStorage.getItem(TEST_MODE_KEY) === "1"
    && sessionStorage.getItem(TEST_SESSION_AUTH_KEY) === "1"
    && Boolean(storedReturnUrl);

  // A TEST kiosk can only be entered from the PROD kiosk. Reloads inside the
  // authorized TEST frame remain valid, while a typed TEST URL, old bookmark or
  // new TEST tab is sent to the canonical PROD terminal.
  if (!freshLaunch && !activeSession) {
    [
      TEST_MODE_KEY,
      TEST_BOARD_ID_KEY,
      TEST_BOARD_LABEL_KEY,
      TEST_RETURN_URL_KEY,
      TEST_EMBEDDED_KEY,
      "bd:kioskPreTestCode",
      "bd:kioskCode",
      "bd:kioskPairingRequestCode",
      "bd:kioskPairingExpires",
    ].forEach((key) => localStorage.removeItem(key));
    sessionStorage.removeItem(TEST_SESSION_AUTH_KEY);
    redirectToProdKiosk();
    return;
  }

  if (!freshLaunch) return;

  localStorage.setItem(TEST_RETURN_URL_KEY, freshReturnUrl);
  localStorage.setItem(TEST_MODE_KEY, "1");
  sessionStorage.setItem(TEST_SESSION_AUTH_KEY, "1");
  if (params.get("embedded") === "1" && window.parent !== window) localStorage.setItem(TEST_EMBEDDED_KEY, "1");
  else localStorage.removeItem(TEST_EMBEDDED_KEY);

  // Every launch from PROD starts at the board chooser. No existing PROD pairing
  // or previous TEST alias is reused to decide which board should be tested.
  [
    TEST_BOARD_ID_KEY,
    TEST_BOARD_LABEL_KEY,
    "bd:kioskPreTestCode",
    "bd:kioskCode",
    "bd:kioskPairingRequestCode",
    "bd:kioskPairingExpires",
    "bd:kioskScoliaLeaseActive",
    "bd:kioskScoliaLeaseKioskCode",
    "bd:kioskScoliaLeasePhysicalId",
  ].forEach((key) => localStorage.removeItem(key));
})();
