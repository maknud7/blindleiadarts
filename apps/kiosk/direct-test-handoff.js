(() => {
  const params = new URLSearchParams(window.location.search);
  const onTestHost = /^test\./i.test(window.location.hostname) || /(^|\.)test([.-]|$)/i.test(window.location.hostname);
  if (!onTestHost) return;

  const TEST_LEASE_API_ROOT = "../api/v1";
  const TEST_MODE_KEY = "bd:kioskTestMode";
  const TEST_BOARD_ID_KEY = "bd:kioskTestPhysicalBoardId";
  const TEST_BOARD_LABEL_KEY = "bd:kioskTestBoardLabel";
  const TEST_RETURN_URL_KEY = "bd:kioskTestReturnUrl";
  const TEST_EMBEDDED_KEY = "bd:kioskTestEmbedded";
  const TEST_SESSION_AUTH_KEY = "bd:kioskTestLaunchAuthorized";
  const TEST_LEASE_ACTIVE_KEY = "bd:kioskScoliaLeaseActive";
  const TEST_LEASE_CODE_KEY = "bd:kioskScoliaLeaseKioskCode";
  const TEST_LEASE_PHYSICAL_KEY = "bd:kioskScoliaLeasePhysicalId";

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

  function pairingToken() {
    return localStorage.getItem("bd:kioskPairingToken") || "";
  }

  function clearLeaseMarkers() {
    localStorage.removeItem(TEST_LEASE_ACTIVE_KEY);
    localStorage.removeItem(TEST_LEASE_CODE_KEY);
    localStorage.removeItem(TEST_LEASE_PHYSICAL_KEY);
  }

  async function releaseKnownLease({ keepalive = false } = {}) {
    const active = localStorage.getItem(TEST_LEASE_ACTIVE_KEY) === "1";
    const code = localStorage.getItem(TEST_LEASE_CODE_KEY) || localStorage.getItem("bd:kioskCode") || "";
    const physicalId = Number(localStorage.getItem(TEST_LEASE_PHYSICAL_KEY) || 0);
    const token = pairingToken();
    if (!active || !code || !physicalId || !token) {
      clearLeaseMarkers();
      return;
    }

    try {
      const response = await fetch(
        `${TEST_LEASE_API_ROOT}/kiosks/${encodeURIComponent(code)}/scolia/test-lease/release`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Kiosk-Pairing-Token": token,
          },
          body: JSON.stringify({ test_kiosk_code: code, physical_kiosk_id: physicalId }),
          cache: "no-store",
          keepalive,
        },
      );
      if (!response.ok && !keepalive) {
        console.warn("Kunne ikke frigi tidligere Scolia test-lease:", response.status);
      }
    } catch (error) {
      if (!keepalive) console.warn("Kunne ikke frigi tidligere Scolia test-lease:", error?.message || error);
    } finally {
      clearLeaseMarkers();
    }
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
    if (testLeaseActive()) releaseKnownLease({ keepalive: true }).catch(() => undefined);
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

  if (freshLaunch) {
    if (testLeaseActive()) releaseKnownLease({ keepalive: true }).catch(() => undefined);
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
    ].forEach((key) => localStorage.removeItem(key));
  }

  // Scolia lease lifecycle has one owner: scolia-test-lease.js.
  // This handoff script only protects entry into TEST and cleans stale leases when needed.
})();
