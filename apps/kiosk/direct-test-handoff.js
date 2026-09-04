(() => {
  const params = new URLSearchParams(window.location.search);
  const onTestHost = /^test\./i.test(window.location.hostname) || /(^|\.)test([.-]|$)/i.test(window.location.hostname);
  if (!onTestHost) return;

  const TEST_LEASE_API = "../api/kiosk-scolia-test-lease.php";
  const TEST_MODE_KEY = "bd:kioskTestMode";
  const TEST_BOARD_ID_KEY = "bd:kioskTestPhysicalBoardId";
  const TEST_BOARD_LABEL_KEY = "bd:kioskTestBoardLabel";
  const TEST_RETURN_URL_KEY = "bd:kioskTestReturnUrl";
  const TEST_EMBEDDED_KEY = "bd:kioskTestEmbedded";
  const TEST_SESSION_AUTH_KEY = "bd:kioskTestLaunchAuthorized";
  const TEST_LEASE_ACTIVE_KEY = "bd:kioskScoliaLeaseActive";
  const TEST_LEASE_CODE_KEY = "bd:kioskScoliaLeaseKioskCode";
  const TEST_LEASE_PHYSICAL_KEY = "bd:kioskScoliaLeasePhysicalId";

  let leaseBusy = false;

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

  function kioskCode() {
    return localStorage.getItem("bd:kioskCode") || "";
  }

  function selectedPhysicalBoardId() {
    return Number(localStorage.getItem(TEST_BOARD_ID_KEY) || 0);
  }

  function testModeActive() {
    return localStorage.getItem(TEST_MODE_KEY) === "1";
  }

  function testLeaseActive() {
    return localStorage.getItem(TEST_LEASE_ACTIVE_KEY) === "1";
  }

  function rememberLease(physicalId, code) {
    localStorage.setItem(TEST_LEASE_ACTIVE_KEY, "1");
    localStorage.setItem(TEST_LEASE_PHYSICAL_KEY, String(physicalId));
    localStorage.setItem(TEST_LEASE_CODE_KEY, code);
  }

  function clearLeaseMarker() {
    localStorage.removeItem(TEST_LEASE_ACTIVE_KEY);
    localStorage.removeItem(TEST_LEASE_CODE_KEY);
    localStorage.removeItem(TEST_LEASE_PHYSICAL_KEY);
  }

  async function leaseRequest(action, body, { keepalive = false } = {}) {
    const token = pairingToken();
    if (!token) throw new Error("Testterminalen mangler device-token.");
    const response = await fetch(`${TEST_LEASE_API}?action=${encodeURIComponent(action)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kiosk-Pairing-Token": token,
      },
      body: JSON.stringify(body || {}),
      cache: "no-store",
      keepalive,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      const error = new Error(payload?.error?.message || `Scolia test-lease feilet (${response.status})`);
      error.code = payload?.error?.code || "scolia_test_lease_failed";
      throw error;
    }
    return payload.data;
  }

  async function releaseKnownLease({ keepalive = false } = {}) {
    if (!testLeaseActive() || leaseBusy) return;
    const code = localStorage.getItem(TEST_LEASE_CODE_KEY) || "";
    const physicalId = Number(localStorage.getItem(TEST_LEASE_PHYSICAL_KEY) || 0);
    if (!code || !physicalId || !pairingToken()) {
      clearLeaseMarker();
      return;
    }

    leaseBusy = true;
    try {
      await leaseRequest("release", { test_kiosk_code: code, physical_kiosk_id: physicalId }, { keepalive });
    } catch (error) {
      if (!keepalive) console.warn("Kunne ikke frigi Scolia test-lease:", error.message);
    } finally {
      clearLeaseMarker();
      leaseBusy = false;
    }
  }

  async function ensureTestLease() {
    if (leaseBusy) return;

    const active = testModeActive();
    const physicalId = selectedPhysicalBoardId();
    const code = kioskCode();
    const storedPhysicalId = Number(localStorage.getItem(TEST_LEASE_PHYSICAL_KEY) || 0);
    const storedCode = localStorage.getItem(TEST_LEASE_CODE_KEY) || "";

    if (!active || !physicalId || !code) {
      if (testLeaseActive()) await releaseKnownLease();
      return;
    }

    if (testLeaseActive() && storedPhysicalId === physicalId && storedCode === code) return;
    if (testLeaseActive()) await releaseKnownLease();

    leaseBusy = true;
    try {
      const data = await leaseRequest("acquire", { test_kiosk_code: code, physical_kiosk_id: physicalId });
      if (!data?.leased) {
        clearLeaseMarker();
        return;
      }
      rememberLease(physicalId, code);
    } catch (error) {
      clearLeaseMarker();
      console.warn("Scolia test-lease kunne ikke aktiveres:", error.message);
    } finally {
      leaseBusy = false;
    }
  }

  async function heartbeatTestLease() {
    if (!testLeaseActive()) {
      await ensureTestLease();
      return;
    }

    const code = localStorage.getItem(TEST_LEASE_CODE_KEY) || "";
    const physicalId = Number(localStorage.getItem(TEST_LEASE_PHYSICAL_KEY) || 0);
    if (!testModeActive() || !code || !physicalId || selectedPhysicalBoardId() !== physicalId) {
      await releaseKnownLease();
      return;
    }

    try {
      await leaseRequest("heartbeat", { test_kiosk_code: code, physical_kiosk_id: physicalId });
    } catch (error) {
      clearLeaseMarker();
      console.warn("Scolia test-lease heartbeat feilet, forsøker å koble til på nytt:", error.message);
      await ensureTestLease();
    }
  }

  function startTestLeaseRuntime() {
    ensureTestLease().catch((error) => console.warn("Scolia test-lease init feilet:", error.message));
    window.setInterval(() => ensureTestLease().catch(() => undefined), 5000);
    window.setInterval(() => heartbeatTestLease().catch(() => undefined), 60000);
    window.addEventListener("pagehide", () => {
      if (!testLeaseActive()) return;
      const storedPhysicalId = Number(localStorage.getItem(TEST_LEASE_PHYSICAL_KEY) || 0);
      if (!testModeActive() || selectedPhysicalBoardId() !== storedPhysicalId) {
        releaseKnownLease({ keepalive: true }).catch(() => undefined);
      }
    });
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
      TEST_LEASE_ACTIVE_KEY,
      TEST_LEASE_CODE_KEY,
      TEST_LEASE_PHYSICAL_KEY,
    ].forEach((key) => localStorage.removeItem(key));
  }

  // The old scolia-runtime.js is intentionally not loaded anymore because its UI
  // overlaps the current Scolia live surface. Keep only the TEST lease lifecycle
  // here so a selected physical Scolia board is routed to the isolated TEST runtime.
  startTestLeaseRuntime();
})();
