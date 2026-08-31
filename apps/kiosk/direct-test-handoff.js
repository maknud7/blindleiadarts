(() => {
  const params = new URLSearchParams(window.location.search);
  const physicalId = Number(params.get("physical_board_id") || 0);
  const requested = params.get("testmode") === "1" && physicalId > 0;
  const onTestHost = /^test\./i.test(window.location.hostname) || /(^|\.)test([.-]|$)/i.test(window.location.hostname);
  if (!requested || !onTestHost) return;

  const TEST_MODE_KEY = "bd:kioskTestMode";
  const TEST_BOARD_ID_KEY = "bd:kioskTestPhysicalBoardId";
  const TEST_BOARD_LABEL_KEY = "bd:kioskTestBoardLabel";
  const TEST_RETURN_URL_KEY = "bd:kioskTestReturnUrl";

  const rawReturnUrl = params.get("return_url") || "";
  try {
    const candidate = new URL(rawReturnUrl);
    const prodHost = window.location.hostname.replace(/^test\./i, "");
    if (candidate.protocol === window.location.protocol && candidate.hostname === prodHost) {
      localStorage.setItem(TEST_RETURN_URL_KEY, candidate.href);
    }
  } catch {
    // Ignore malformed return URL; TEST can still start safely.
  }

  // Prevent the legacy TEST selector and the asynchronous PROD-entry helper from
  // racing this direct handoff. We already captured everything needed above.
  localStorage.removeItem(TEST_MODE_KEY);
  localStorage.removeItem(TEST_BOARD_ID_KEY);
  localStorage.removeItem(TEST_BOARD_LABEL_KEY);
  const clean = new URL(window.location.href);
  clean.searchParams.delete("testmode");
  clean.searchParams.delete("physical_board_id");
  clean.searchParams.delete("return_url");
  history.replaceState(null, "", clean.href);

  let token = localStorage.getItem("bd:kioskPairingToken") || "";
  if (!token) {
    token = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem("bd:kioskPairingToken", token);
  }

  const showError = (message) => {
    const render = () => {
      const topbar = document.querySelector(".terminal-topbar");
      if (!topbar || document.getElementById("directTestHandoffError")) return;
      const box = document.createElement("div");
      box.id = "directTestHandoffError";
      box.className = "test-mode-panel";
      box.innerHTML = `<span class="test-mode-badge">Testmodus</span><strong>Kunne ikke koble skiva automatisk</strong><small class="muted"></small><button type="button" class="ghost-button">Tilbake til PROD</button>`;
      box.querySelector("small").textContent = message || "Ukjent feil";
      box.querySelector("button")?.addEventListener("click", () => {
        const saved = localStorage.getItem(TEST_RETURN_URL_KEY) || "";
        if (saved) window.location.replace(saved);
      });
      topbar.insertAdjacentElement("afterend", box);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render, { once: true });
    else render();
  };

  fetch("../api/kiosk-test-mode.php", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Kiosk-Pairing-Token": token,
    },
    body: JSON.stringify({ kiosk_id: physicalId, source: "physical" }),
    cache: "no-store",
  })
    .then(async (response) => {
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error?.message || `Kunne ikke starte testmodus (${response.status})`);
      }
      const data = payload.data || {};
      if (!data.kiosk?.code) throw new Error("TEST returnerte ingen kiosk-kode.");
      localStorage.setItem("bd:kioskCode", data.kiosk.code);
      localStorage.setItem(TEST_MODE_KEY, "1");
      localStorage.setItem(TEST_BOARD_ID_KEY, String(data.source_board?.id || data.physical_board?.id || physicalId));
      localStorage.setItem(
        TEST_BOARD_LABEL_KEY,
        `${data.kiosk.name || `Skive ${data.kiosk.board_number || ""}`}${data.physical_board?.scoring_mode === "scolia" ? " · Scolia" : ""}`,
      );
      localStorage.removeItem("bd:kioskPairingRequestCode");
      localStorage.removeItem("bd:kioskPairingExpires");
      window.location.replace(clean.href);
    })
    .catch((error) => {
      console.error("Direkte TEST-handoff feilet:", error);
      showError(error?.message || "Ukjent feil");
    });
})();
