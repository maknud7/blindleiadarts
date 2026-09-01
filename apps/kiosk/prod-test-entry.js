(() => {
  const TEST_MODE_KEY = "bd:kioskTestMode";
  const TEST_BOARD_ID_KEY = "bd:kioskTestPhysicalBoardId";
  const TEST_BOARD_LABEL_KEY = "bd:kioskTestBoardLabel";
  const TEST_RETURN_URL_KEY = "bd:kioskTestReturnUrl";
  const TEST_LEASE_ACTIVE_KEY = "bd:kioskScoliaLeaseActive";
  const TEST_LEASE_CODE_KEY = "bd:kioskScoliaLeaseKioskCode";
  const TEST_LEASE_PHYSICAL_KEY = "bd:kioskScoliaLeasePhysicalId";
  const TEST_EMBEDDED_KEY = "bd:kioskTestEmbedded";
  const EMBEDDED_OPEN_KEY = "bd:kioskEmbeddedTestOpen";

  function env() {
    return document.body?.dataset?.appEnv || "prod";
  }

  function pairingToken() {
    return localStorage.getItem("bd:kioskPairingToken") || "";
  }

  function testOrigin() {
    const url = new URL(window.location.href);
    if (!url.hostname.startsWith("test.")) url.hostname = `test.${url.hostname}`;
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.origin;
  }

  function safeReturnUrl(raw) {
    if (!raw) return "";
    try {
      const candidate = new URL(raw);
      const expectedProdHost = window.location.hostname.replace(/^test\./i, "");
      if (candidate.protocol !== window.location.protocol || candidate.hostname !== expectedProdHost) return "";
      return candidate.href;
    } catch {
      return "";
    }
  }

  function setMessage(text, tone = "") {
    const node = document.getElementById("prodTestModeHelp");
    if (!node) return;
    node.textContent = text;
    node.style.color = tone === "bad" ? "#a33" : "";
  }

  function closeEmbeddedTest({ refresh = true } = {}) {
    sessionStorage.removeItem(EMBEDDED_OPEN_KEY);
    document.getElementById("prodTestRuntimeOverlay")?.remove();
    document.body?.classList.remove("prod-test-runtime-open");
    const button = document.getElementById("prodStartTestMode");
    if (button) button.disabled = false;
    if (refresh) {
      try {
        if (typeof refreshSnapshot === "function") refreshSnapshot();
        else document.getElementById("refreshButton")?.click();
      } catch {
        // PROD remains usable even if the immediate refresh hook is unavailable.
      }
    }
  }

  function openEmbeddedTest() {
    if (env() !== "prod") return false;
    if (document.getElementById("prodTestRuntimeOverlay")) return true;

    sessionStorage.setItem(EMBEDDED_OPEN_KEY, "1");
    const target = new URL("/kiosk/", testOrigin());
    target.searchParams.set("testmode", "1");
    target.searchParams.set("return_url", window.location.href);
    target.searchParams.set("embedded", "1");

    const overlay = document.createElement("div");
    overlay.id = "prodTestRuntimeOverlay";
    overlay.className = "prod-test-runtime-overlay";
    overlay.innerHTML = `
      <div class="prod-test-runtime-loading" id="prodTestRuntimeLoading">
        <span class="spinner"></span>
        <strong>Starter isolert testmodus …</strong>
      </div>
      <iframe id="prodTestRuntimeFrame" title="Blindleia TEST-kiosk" allow="fullscreen"></iframe>`;
    const frame = overlay.querySelector("iframe");
    frame.addEventListener("load", () => {
      document.getElementById("prodTestRuntimeLoading")?.classList.add("hidden");
    });
    frame.src = target.href;
    document.body.appendChild(overlay);
    document.body.classList.add("prod-test-runtime-open");
    return true;
  }

  function ensureProdControl() {
    if (env() !== "prod") return;
    const meta = document.getElementById("settingsMeta");
    if (!meta) return;
    let card = document.getElementById("prodTestModeSettings");
    if (card) return;

    card = document.createElement("section");
    card.id = "prodTestModeSettings";
    card.className = "test-mode-settings-card";
    card.innerHTML = `
      <div>
        <strong>Testmodus</strong>
        <small class="muted" id="prodTestModeHelp">Åpner isolert TEST-runtime. Du velger selv hvilken skive som skal simuleres; PROD-terminalen trenger ikke være paret.</small>
      </div>
      <div class="test-mode-settings-actions">
        <button id="prodStartTestMode" type="button" class="ghost-button test-mode-settings-button">Start testmodus</button>
      </div>`;
    meta.appendChild(card);

    document.getElementById("prodStartTestMode")?.addEventListener("click", () => {
      const button = document.getElementById("prodStartTestMode");
      if (button) button.disabled = true;
      setMessage("Åpner TEST. Velg skiva du vil simulere …");
      if (!openEmbeddedTest()) {
        if (button) button.disabled = false;
        setMessage("Kunne ikke åpne isolert TEST-runtime.", "bad");
      }
    });
  }

  async function releaseLeaseBeforeReturn() {
    if (env() !== "test" || localStorage.getItem(TEST_LEASE_ACTIVE_KEY) !== "1") return;
    const code = localStorage.getItem(TEST_LEASE_CODE_KEY) || localStorage.getItem("bd:kioskCode") || "";
    const physicalId = Number(localStorage.getItem(TEST_LEASE_PHYSICAL_KEY) || localStorage.getItem(TEST_BOARD_ID_KEY) || 0);
    const token = pairingToken();
    if (!code || !physicalId || !token) return;
    try {
      await fetch("../api/kiosk-scolia-test-lease.php?action=release", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Kiosk-Pairing-Token": token },
        body: JSON.stringify({ test_kiosk_code: code, physical_kiosk_id: physicalId }),
        cache: "no-store",
        keepalive: true,
      });
    } catch {
      // Lease expires automatically if explicit release fails.
    }
  }

  async function unpairTestAlias() {
    const code = localStorage.getItem("bd:kioskCode") || "";
    const token = pairingToken();
    if (!code || !token) return;
    try {
      await fetch(`../api/v1/kiosks/${encodeURIComponent(code)}/unpair`, {
        method: "POST",
        headers: { "X-Kiosk-Pairing-Token": token },
        cache: "no-store",
        keepalive: true,
      });
    } catch {
      // Returning to PROD must not be blocked by cleanup failure.
    }
  }

  function clearTestRuntimeMarkers() {
    [
      TEST_MODE_KEY,
      TEST_BOARD_ID_KEY,
      TEST_BOARD_LABEL_KEY,
      TEST_LEASE_ACTIVE_KEY,
      TEST_LEASE_CODE_KEY,
      TEST_LEASE_PHYSICAL_KEY,
      TEST_EMBEDDED_KEY,
      "bd:kioskPreTestCode",
      "bd:kioskCode",
      "bd:kioskPairingRequestCode",
      "bd:kioskPairingExpires",
    ].forEach((key) => localStorage.removeItem(key));
  }

  async function returnToProd(button) {
    const returnUrl = safeReturnUrl(localStorage.getItem(TEST_RETURN_URL_KEY) || "");
    if (button) button.disabled = true;
    await releaseLeaseBeforeReturn();
    await unpairTestAlias();
    const embedded = localStorage.getItem(TEST_EMBEDDED_KEY) === "1" && window.parent !== window;
    clearTestRuntimeMarkers();
    localStorage.removeItem(TEST_RETURN_URL_KEY);

    if (embedded) {
      const targetOrigin = returnUrl ? new URL(returnUrl).origin : window.location.origin.replace(/^https:\/\/test\./i, "https://");
      window.parent.postMessage({ type: "bd:kiosk-test-exit" }, targetOrigin);
      return true;
    }

    if (!returnUrl) return false;
    window.location.replace(returnUrl);
    return true;
  }

  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("#kioskTestModeToggle");
    if (!button || env() !== "test" || localStorage.getItem(TEST_MODE_KEY) !== "1") return;
    if (!localStorage.getItem(TEST_RETURN_URL_KEY)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    returnToProd(button).catch((error) => {
      button.disabled = false;
      console.warn("Kunne ikke returnere til PROD:", error);
    });
  }, true);

  window.addEventListener("message", (event) => {
    if (env() !== "prod" || event.origin !== testOrigin()) return;
    if (event.data?.type === "bd:kiosk-test-exit") {
      closeEmbeddedTest({ refresh: true });
    }
  });

  const observer = new MutationObserver(ensureProdControl);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureProdControl();

  if (env() === "prod" && sessionStorage.getItem(EMBEDDED_OPEN_KEY) === "1") {
    openEmbeddedTest();
  }
})();
