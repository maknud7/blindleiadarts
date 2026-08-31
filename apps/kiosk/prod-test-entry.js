(() => {
  const TEST_MODE_KEY = "bd:kioskTestMode";
  const TEST_BOARD_ID_KEY = "bd:kioskTestPhysicalBoardId";
  const TEST_BOARD_LABEL_KEY = "bd:kioskTestBoardLabel";
  const TEST_RETURN_URL_KEY = "bd:kioskTestReturnUrl";
  const TEST_LEASE_ACTIVE_KEY = "bd:kioskScoliaLeaseActive";
  const TEST_LEASE_CODE_KEY = "bd:kioskScoliaLeaseKioskCode";
  const TEST_LEASE_PHYSICAL_KEY = "bd:kioskScoliaLeasePhysicalId";

  function env() {
    return document.body?.dataset?.appEnv || "prod";
  }

  function pairingToken() {
    return localStorage.getItem("bd:kioskPairingToken") || "";
  }

  function ensureTestToken() {
    let token = pairingToken();
    if (!token) {
      token = globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem("bd:kioskPairingToken", token);
    }
    return token;
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

  function currentPhysicalKiosk() {
    try {
      return typeof currentKiosk === "function" ? currentKiosk() : null;
    } catch {
      return null;
    }
  }

  function hasProdMatch() {
    try {
      return typeof currentMatch === "function" && Boolean(currentMatch());
    } catch {
      return false;
    }
  }

  function setMessage(text, tone = "") {
    const node = document.getElementById("prodTestModeHelp");
    if (!node) return;
    node.textContent = text;
    node.style.color = tone === "bad" ? "#a33" : "";
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
        <small class="muted" id="prodTestModeHelp">Bruk denne fysiske skiva mot isolert TEST-runtime. PROD-pairingen beholdes og gjenopprettes når testen avsluttes.</small>
      </div>
      <div class="test-mode-settings-actions">
        <button id="prodStartTestMode" type="button" class="ghost-button test-mode-settings-button" data-kiosk-admin-control>Start testmodus</button>
      </div>`;
    meta.appendChild(card);

    document.getElementById("prodStartTestMode")?.addEventListener("click", () => {
      const button = document.getElementById("prodStartTestMode");
      const kiosk = currentPhysicalKiosk();
      const code = localStorage.getItem("bd:kioskCode") || "";
      if (!kiosk?.id || !code) {
        setMessage("Terminalen må være paret til en fysisk PROD-skive før testmodus kan startes.", "bad");
        return;
      }
      if (hasProdMatch()) {
        setMessage("Testmodus kan ikke startes mens PROD har en kamp tildelt eller pågående på denne skiva.", "bad");
        return;
      }

      if (button) button.disabled = true;
      const target = new URL("/kiosk/", testOrigin());
      target.searchParams.set("testmode", "1");
      target.searchParams.set("physical_board_id", String(kiosk.id));
      target.searchParams.set("return_url", window.location.href);
      window.location.assign(target.href);
    });
  }

  async function autoEnterTestFromProd() {
    if (env() !== "test") return false;
    const params = new URLSearchParams(window.location.search);
    const physicalId = Number(params.get("physical_board_id") || 0);
    if (!physicalId) return false;

    const returnUrl = safeReturnUrl(params.get("return_url") || "");
    if (returnUrl) localStorage.setItem(TEST_RETURN_URL_KEY, returnUrl);
    localStorage.setItem(TEST_MODE_KEY, "1");

    const token = ensureTestToken();
    try {
      const response = await fetch("../api/kiosk-test-mode.php", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Kiosk-Pairing-Token": token },
        body: JSON.stringify({ kiosk_id: physicalId, source: "physical" }),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Kunne ikke starte testmodus (${response.status})`);

      const data = payload.data;
      localStorage.setItem("bd:kioskCode", data.kiosk.code);
      localStorage.setItem(TEST_BOARD_ID_KEY, String(data.source_board?.id || data.physical_board?.id || physicalId));
      localStorage.setItem(TEST_BOARD_LABEL_KEY, `${data.kiosk.name || `Skive ${data.kiosk.board_number || ""}`}${data.physical_board?.scoring_mode === "scolia" ? " · Scolia" : ""}`);
      localStorage.removeItem("bd:kioskPairingRequestCode");
      localStorage.removeItem("bd:kioskPairingExpires");

      const clean = new URL(window.location.href);
      clean.searchParams.delete("testmode");
      clean.searchParams.delete("physical_board_id");
      clean.searchParams.delete("return_url");
      window.location.replace(clean.href);
      return true;
    } catch (error) {
      console.error("Kunne ikke starte testmodus fra PROD:", error);
      const topbar = document.querySelector(".terminal-topbar");
      if (topbar && !document.getElementById("prodTestEntryError")) {
        const box = document.createElement("div");
        box.id = "prodTestEntryError";
        box.className = "test-mode-panel";
        box.innerHTML = `<span class="test-mode-badge">Testmodus</span><strong>Kunne ikke starte testmodus</strong><small class="muted"></small><button type="button" class="ghost-button">Tilbake til PROD</button>`;
        box.querySelector("small").textContent = error.message || "Ukjent feil";
        box.querySelector("button").addEventListener("click", () => {
          const saved = localStorage.getItem(TEST_RETURN_URL_KEY) || "";
          if (saved) window.location.replace(saved);
        });
        topbar.insertAdjacentElement("afterend", box);
      }
      return false;
    }
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
      // Lease expires automatically after three minutes if explicit release fails.
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
      "bd:kioskPreTestCode",
      "bd:kioskCode",
    ].forEach((key) => localStorage.removeItem(key));
  }

  async function returnToProd(button) {
    const returnUrl = safeReturnUrl(localStorage.getItem(TEST_RETURN_URL_KEY) || "");
    if (!returnUrl) return false;
    if (button) button.disabled = true;
    await releaseLeaseBeforeReturn();
    await unpairTestAlias();
    clearTestRuntimeMarkers();
    localStorage.removeItem(TEST_RETURN_URL_KEY);
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

  const observer = new MutationObserver(ensureProdControl);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureProdControl();
  autoEnterTestFromProd().catch((error) => console.error(error));
})();