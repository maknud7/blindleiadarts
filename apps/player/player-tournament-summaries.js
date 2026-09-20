const API_ROOT = "../api/v1";
const root = document.getElementById("summaryList");
let loadedClubId = 0;
let loading = false;

function clubId() {
  return Number(localStorage.getItem("bd:playerClubId") || document.getElementById("clubSelect")?.value || 0);
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(date.getTime())
    ? String(value)
    : new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

function summaryText(value) {
  return esc(String(value || "")).replace(/\n/g, "<br>");
}

async function load(force = false) {
  if (!root || loading) return;
  const id = clubId();
  if (!id || (!force && id === loadedClubId)) return;
  loading = true;
  try {
    const response = await fetch(`${API_ROOT}/clubs/${id}/summaries`, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    const items = payload.data?.items || [];
    loadedClubId = id;
    root.innerHTML = items.length
      ? items.map((summary, index) => `
        <article class="summary-card ${index > 2 ? "summary-collapsed" : ""}">
          <div class="section-head">
            <div><p class="eyebrow">${esc(formatDate(summary.start_at))}</p><h3>${esc(summary.title)}</h3></div>
            <span class="pill">${esc(summary.tournament_name)}</span>
          </div>
          <div class="summary-body">${summaryText(summary.body_text)}</div>
        </article>`).join("")
      : '<div class="mini-card"><p class="muted">Ingen oppsummeringer ennå.</p></div>';
  } catch (error) {
    root.innerHTML = `<div class="mini-card"><p class="muted">${esc(error.message)}</p></div>`;
  } finally {
    loading = false;
  }
}

document.getElementById("clubSelect")?.addEventListener("change", () => {
  loadedClubId = 0;
  if (document.body.dataset.portalActive === "tournaments") load(true);
});
document.getElementById("refreshButton")?.addEventListener("click", () => {
  if (document.body.dataset.portalActive === "tournaments") load(true);
});
window.addEventListener("bd:portal-view", (event) => {
  if (event.detail?.target === "tournaments") load();
});

load();
