(() => {
  const codeNode = document.getElementById("pairingCode");
  const qr = document.getElementById("pairingQr");
  if (!codeNode || !qr) return;

  const PROD_ORIGIN = "https://blindleiadart.ingenting.org";
  const TEST_ORIGIN = "https://test.blindleiadart.ingenting.org";
  const TEST_MODE_KEY = "bd:kioskTestMode";

  function normalizeCode(value) {
    return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  }

  function canonicalAdminOrigin() {
    const testMode = localStorage.getItem(TEST_MODE_KEY) === "1";
    const hostname = String(window.location.hostname || "").toLowerCase();
    const deployedClubHost = hostname === "blindleiadart.ingenting.org"
      || hostname === "test.blindleiadart.ingenting.org"
      || hostname === "blindleiadarts.ingenting.org"
      || hostname === "test.blindleiadarts.ingenting.org";

    if (deployedClubHost) return testMode ? TEST_ORIGIN : PROD_ORIGIN;

    // Local/dev environments stay on their own origin so pairing remains usable
    // without sending development terminals to the real club installation.
    return window.location.origin;
  }

  function canonicalAdminUrl(code) {
    const url = new URL("/", canonicalAdminOrigin());
    url.searchParams.set("pairing", code);
    url.hash = "equipment";
    return url.toString();
  }

  function qrUrl(code) {
    return `https://quickchart.io/qr?size=420&margin=2&text=${encodeURIComponent(canonicalAdminUrl(code))}`;
  }

  function sync() {
    const code = normalizeCode(codeNode.textContent || localStorage.getItem("bd:kioskPairingRequestCode") || "");
    if (!code || code === "—") return;
    const expected = qrUrl(code);
    if (qr.src !== expected) qr.src = expected;
    qr.dataset.canonicalPairing = code;
    qr.dataset.pairingEnvironment = localStorage.getItem(TEST_MODE_KEY) === "1" ? "test" : "prod";
  }

  new MutationObserver(sync).observe(codeNode, { childList: true, characterData: true, subtree: true });
  window.addEventListener("storage", (event) => {
    if (event.key === TEST_MODE_KEY) sync();
  });
  window.setInterval(sync, 1200);
  sync();
})();
