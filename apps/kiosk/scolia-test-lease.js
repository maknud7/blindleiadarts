(() => {
  const TEST_LEASE_API_ROOT = "../api/v1";
  const TEST_MODE_KEY = "bd:kioskTestMode";
  const TEST_BOARD_ID_KEY = "bd:kioskTestPhysicalBoardId";
  const TEST_LEASE_ACTIVE_KEY = "bd:kioskScoliaLeaseActive";
  const TEST_LEASE_CODE_KEY = "bd:kioskScoliaLeaseKioskCode";
  const TEST_LEASE_PHYSICAL_KEY = "bd:kioskScoliaLeasePhysicalId";
  const TEST_LEASE_PENDING_KEY = "bd:kioskScoliaLeasePending";
  const TEST_LEASE_NA_PHYSICAL_KEY = "bd:kioskScoliaLeaseNotApplicablePhysicalId";
  const TEST_LEASE_ERROR_KEY = "bd:kioskScoliaLeaseError";
  const REQUEST_TIMEOUT_MS = 15000;
  const ENSURE_INTERVAL_MS = 750;
  const HEARTBEAT_INTERVAL_MS = 60000;

  let busy = false;
  let heartbeatBusy = false;

  function isTestEnvironment() {
    return document.body?.dataset?.appEnv === "test";
  }

  function testModeActive() {
    return localStorage.getItem(TEST_MODE_KEY) === "1";
  }

  function selectedPhysicalBoardId() {
    return Number(localStorage.getItem(TEST_BOARD_ID_KEY) || 0);
  }

  function kioskCode() {
    return localStorage.getItem("bd:kioskCode") || "";
  }

  function pairingToken() {
    return localStorage.getItem("bd:kioskPairingToken") || "";
  }

  function testLeaseActive() {
    return localStorage.getItem(TEST_LEASE_ACTIVE_KEY) === "1";
  }

  function activeLeaseMatches(physicalId, code) {
    return testLeaseActive()
      && Number(localStorage.getItem(TEST_LEASE_PHYSICAL_KEY) || 0) === Number(physicalId)
      && String(localStorage.getItem(TEST_LEASE_CODE_KEY) || "") === String(code || "");
  }

  function clearPending() {
    localStorage.removeItem(TEST_LEASE_PENDING_KEY);
  }

  function setPending() {
    localStorage.setItem(TEST_LEASE_PENDING_KEY, "1");
  }

  function setError(message = "") {
    if (message) localStorage.setItem(TEST_LEASE_ERROR_KEY, String(message));
    else localStorage.removeItem(TEST_LEASE_ERROR_KEY);
  }

  function rememberLease(physicalId, code) {
    localStorage.setItem(TEST_LEASE_ACTIVE_KEY, "1");
    localStorage.setItem(TEST_LEASE_PHYSICAL_KEY, String(physicalId));
    localStorage.setItem(TEST_LEASE_CODE_KEY, String(code));
    localStorage.removeItem(TEST_LEASE_NA_PHYSICAL_KEY);
    clearPending();
    setError("");
    window.dispatchEvent(new CustomEvent("bd:scolia-test-lease-ready", { detail: { physicalId, code } }));
  }

  function clearLeaseMarker() {
    localStorage.removeItem(TEST_LEASE_ACTIVE_KEY);
    localStorage.removeItem(TEST_LEASE_PHYSICAL_KEY);
    localStorage.removeItem(TEST_LEASE_CODE_KEY);
  }

  function clearSelectionMarkers() {
    clearLeaseMarker();
    clearPending();
    localStorage.removeItem(TEST_LEASE_NA_PHYSICAL_KEY);
    setError("");
  }

  async function fetchWithTimeout(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function leaseRequest(action, body, { keepalive = false } = {}) {
    const code = String(body?.test_kiosk_code || kioskCode() || "").trim();
    if (!code) throw new Error("Testterminalen mangler skivekode.");
    const headers = { "Content-Type": "application/json" };
    const token = pairingToken();
    if (token) headers["X-Kiosk-Pairing-Token"] = token;
    const init = {
      method: "POST",
      headers,
      body: JSON.stringify(body || {}),
      cache: "no-store",
      keepalive,
    };
    const url = `${TEST_LEASE_API_ROOT}/kiosks/${encodeURIComponent(code)}/scolia/test-lease/${encodeURIComponent(action)}`;
    const response = keepalive ? await fetch(url, init) : await fetchWithTimeout(url, init);
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      const error = new Error(payload?.error?.message || `Scolia test-lease feilet (${response.status})`);
      error.code = payload?.error?.code || "scolia_test_lease_failed";
      error.status = response.status;
      throw error;
    }
    return payload.data;
  }

  async function releaseTestLease({ keepalive = false } = {}) {
    if (!isTestEnvironment() || busy) return;
    const code = localStorage.getItem(TEST_LEASE_CODE_KEY) || "";
    const physicalId = Number(localStorage.getItem(TEST_LEASE_PHYSICAL_KEY) || 0);
    if (!testLeaseActive() || !code || !physicalId || !pairingToken()) {
      clearLeaseMarker();
      return;
    }

    busy = true;
    try {
      await leaseRequest("release", { test_kiosk_code: code, physical_kiosk_id: physicalId }, { keepalive });
    } catch (error) {
      if (!keepalive) console.warn("Scolia test-lease kunne ikke frigis:", error.message);
    } finally {
      clearLeaseMarker();
      busy = false;
    }
  }

  async function ensureTestLease() {
    if (!isTestEnvironment() || busy) return;

    const active = testModeActive();
    const physicalId = selectedPhysicalBoardId();
    const code = kioskCode();
    const token = pairingToken();

    if (!active || !physicalId || !code || !token) {
      if (testLeaseActive()) await releaseTestLease();
      if (!active || !physicalId) clearSelectionMarkers();
      return;
    }

    const storedPhysicalId = Number(localStorage.getItem(TEST_LEASE_PHYSICAL_KEY) || 0);
    const storedCode = localStorage.getItem(TEST_LEASE_CODE_KEY) || "";
    if (testLeaseActive() && (storedPhysicalId !== physicalId || storedCode !== code)) {
      await releaseTestLease();
    }

    if (activeLeaseMatches(physicalId, code)) {
      clearPending();
      setError("");
      return;
    }

    const notApplicablePhysicalId = Number(localStorage.getItem(TEST_LEASE_NA_PHYSICAL_KEY) || 0);
    if (notApplicablePhysicalId === physicalId) {
      clearPending();
      return;
    }
    if (notApplicablePhysicalId && notApplicablePhysicalId !== physicalId) {
      localStorage.removeItem(TEST_LEASE_NA_PHYSICAL_KEY);
    }

    setPending();
    busy = true;
    try {
      const data = await leaseRequest("acquire", { test_kiosk_code: code, physical_kiosk_id: physicalId });
      if (data?.leased) {
        rememberLease(physicalId, code);
        return;
      }

      // Manual physical boards legitimately return leased=false. Remember that for
      // this selection so TEST does not keep asking for a Scolia bridge lease.
      localStorage.setItem(TEST_LEASE_NA_PHYSICAL_KEY, String(physicalId));
      clearLeaseMarker();
      clearPending();
      setError("");
    } catch (error) {
      // Keep the pending marker while TEST retries. This prevents the Scolia UI from
      // interpreting initial bridge setup as a genuine board outage.
      setPending();
      setError(error.message || "Kunne ikke koble TEST til Scolia.");
      console.warn("Scolia test-lease kunne ikke aktiveres:", error.message);
    } finally {
      busy = false;
    }
  }

  async function heartbeatTestLease() {
    if (!isTestEnvironment() || heartbeatBusy) return;
    if (!testLeaseActive()) {
      await ensureTestLease();
      return;
    }

    const code = localStorage.getItem(TEST_LEASE_CODE_KEY) || "";
    const physicalId = Number(localStorage.getItem(TEST_LEASE_PHYSICAL_KEY) || 0);
    if (!testModeActive() || !code || !physicalId || selectedPhysicalBoardId() !== physicalId || kioskCode() !== code) {
      await releaseTestLease();
      return;
    }

    heartbeatBusy = true;
    try {
      await leaseRequest("heartbeat", { test_kiosk_code: code, physical_kiosk_id: physicalId });
      setError("");
    } catch (error) {
      clearLeaseMarker();
      setPending();
      setError(error.message || "Scolia test-lease mistet forbindelsen.");
      await ensureTestLease();
    } finally {
      heartbeatBusy = false;
    }
  }

  if (!isTestEnvironment()) return;

  ensureTestLease().catch(() => undefined);
  window.setInterval(() => ensureTestLease().catch(() => undefined), ENSURE_INTERVAL_MS);
  window.setInterval(() => heartbeatTestLease().catch(() => undefined), HEARTBEAT_INTERVAL_MS);

  window.addEventListener("focus", () => ensureTestLease().catch(() => undefined));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) ensureTestLease().catch(() => undefined);
  });
  window.addEventListener("pagehide", () => {
    const storedPhysicalId = Number(localStorage.getItem(TEST_LEASE_PHYSICAL_KEY) || 0);
    if (!testModeActive() || !selectedPhysicalBoardId() || selectedPhysicalBoardId() !== storedPhysicalId) {
      releaseTestLease({ keepalive: true }).catch(() => undefined);
    }
  });

  window.BlindleiaScoliaTestLease = {
    ensure: ensureTestLease,
    release: releaseTestLease,
    isPending: () => localStorage.getItem(TEST_LEASE_PENDING_KEY) === "1",
    isActive: () => activeLeaseMatches(selectedPhysicalBoardId(), kioskCode()),
  };
})();
