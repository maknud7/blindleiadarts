(() => {
  const codeNode = document.getElementById("pairingCode");
  const qr = document.getElementById("pairingQr");
  if (!codeNode || !qr) return;

  function normalizeCode(value) {
    return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  }

  function canonicalAdminUrl(code) {
    const url = new URL("../", window.location.href);
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
  }

  new MutationObserver(sync).observe(codeNode, { childList: true, characterData: true, subtree: true });
  window.setInterval(sync, 1200);
  sync();
})();
