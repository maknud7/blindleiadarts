const watched = [
  document.getElementById("authSummary"),
  document.getElementById("registrationList"),
].filter(Boolean);

let timer = 0;
let primed = false;

function notify(reason) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent("bd:player-state-changed", { detail: { reason } }));
  }, 80);
}

if (watched.length) {
  const observer = new MutationObserver(() => {
    if (!primed) {
      primed = true;
      return;
    }
    notify("portal_dom_updated");
  });
  watched.forEach((node) => observer.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] }));
}

document.getElementById("clubSelect")?.addEventListener("change", () => notify("club_changed"));
document.getElementById("refreshButton")?.addEventListener("click", () => notify("manual_refresh"));