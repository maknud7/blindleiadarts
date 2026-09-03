const watched = [
  document.getElementById("authSummary"),
  document.getElementById("registrationList"),
].filter(Boolean);

let timer = 0;
let primed = false;
let lastSignature = "";
let liveLinkTimer = 0;
let clubSlugMap = null;

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

async function loadClubSlugMap() {
  if (clubSlugMap) return clubSlugMap;
  const response = await fetch("../api/v1/clubs", { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  const items = response.ok && payload?.ok ? payload?.data?.items || [] : [];
  clubSlugMap = new Map(items.map((club) => [Number(club.id), String(club.slug || "").trim()]).filter(([, slug]) => slug));
  return clubSlugMap;
}

async function syncPlayerLiveLinks() {
  const clubId = Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:playerClubId") || 0);
  if (!clubId) return;

  try {
    const slugs = await loadClubSlugMap();
    const slug = slugs.get(clubId) || "";
    if (!slug) return;
    const href = `../live/?club=${encodeURIComponent(slug)}`;
    document.querySelectorAll('a[href="../live/"], a[href^="../live/?club="]').forEach((link) => {
      if (link.getAttribute("href") !== href) link.setAttribute("href", href);
    });
  } catch {
    // A missing club lookup must not disturb the rest of the player portal.
  }
}

function scheduleLiveLinkSync() {
  window.clearTimeout(liveLinkTimer);
  liveLinkTimer = window.setTimeout(() => syncPlayerLiveLinks(), 50);
}

lastSignature = signature();
primed = true;

if (watched.length) {
  const observer = new MutationObserver(() => notify("portal_dom_updated"));
  watched.forEach((node) => observer.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "disabled"] }));
}

const liveLinkObserver = new MutationObserver(() => scheduleLiveLinkSync());
liveLinkObserver.observe(document.body, { childList: true, subtree: true });
window.addEventListener("bd:player-state-changed", scheduleLiveLinkSync);

document.getElementById("clubSelect")?.addEventListener("change", () => {
  lastSignature = "";
  notify("club_changed");
  scheduleLiveLinkSync();
});
document.getElementById("refreshButton")?.addEventListener("click", () => {
  lastSignature = "";
  notify("manual_refresh");
  clubSlugMap = null;
  scheduleLiveLinkSync();
});

scheduleLiveLinkSync();
