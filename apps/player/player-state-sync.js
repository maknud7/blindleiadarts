const watched = [
  document.getElementById("authSummary"),
  document.getElementById("registrationList"),
].filter(Boolean);

let timer = 0;
let primed = false;
let lastSignature = "";

function signature() {
  return watched.map((node) => {
    const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
    const state = [...node.querySelectorAll("[data-checkin],[data-withdraw],[data-register]")]
      .map((el) => `${el.dataset.checkin || ""}:${el.dataset.withdraw || ""}:${el.dataset.register || ""}:${el.disabled ? 1 : 0}`)
      .join(",");
    return `${node.id}|${node.className}|${text}|${state}`;
  }).join("||");
}

function notify(reason) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    const next = signature();
    if (primed && next === lastSignature) return;
    primed = true;
    lastSignature = next;
    window.dispatchEvent(new CustomEvent("bd:player-state-changed", { detail: { reason } }));
  }, 180);
}

lastSignature = signature();
primed = true;

if (watched.length) {
  const observer = new MutationObserver(() => notify("portal_dom_updated"));
  watched.forEach((node) => observer.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "disabled"] }));
}

document.getElementById("clubSelect")?.addEventListener("change", () => {
  lastSignature = "";
  notify("club_changed");
});
document.getElementById("refreshButton")?.addEventListener("click", () => {
  lastSignature = "";
  notify("manual_refresh");
});