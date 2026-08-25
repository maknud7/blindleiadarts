const API_ROOT = "../api/v1";

function esc(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function token() { return localStorage.getItem("bd:token") || ""; }
function clubId() { return Number(localStorage.getItem("bd:selectedClubId") || document.getElementById("clubSelect")?.value || 0); }
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (token()) headers.Authorization = `Bearer ${token()}`;
  const response = await fetch(`${API_ROOT}${path}`, { method: options.method || "GET", headers, body: options.body !== undefined ? JSON.stringify(options.body) : undefined, cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data;
}
function fmtDate(value) {
  if (!value) return "—";
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}
function statusLabel(value) {
  return ({ draft: "Utkast", active: "Aktiv", completed: "Avsluttet", archived: "Arkivert" })[value] || value || "Ukjent";
}
function ensureView() {
  const nav = document.querySelector(".portal-menu");
  const main = document.querySelector("main.main");
  if (!nav || !main || document.getElementById("seasons")) return;
  const link = document.createElement("a");
  link.href = "#seasons";
  link.dataset.portalNav = "1";
  link.textContent = "Sesonger";
  const tournamentsLink = nav.querySelector('a[href="#tournaments"]');
  tournamentsLink?.after(link);

  const section = document.createElement("section");
  section.id = "seasons";
  section.dataset.portalSection = "seasons";
  section.className = "panel";
  section.innerHTML = `
    <div class="panel-head"><div><p class="eyebrow">Serie og sesong</p><h2>Sesonger</h2><p class="muted">Samle turneringer i en sesong, følg tabellen og lås sesongvinneren når serien er ferdig.</p></div></div>
    <div class="kiosk-layout season-layout">
      <form id="seasonForm" class="create-card">
        <h3>Ny sesong</h3>
        <label><span>Navn</span><input name="name" maxlength="150" placeholder="Mandagsserien Høst 2026" required></label>
        <div class="claim-two-columns"><label><span>Fra</span><input name="starts_on" type="date"></label><label><span>Til</span><input name="ends_on" type="date"></label></div>
        <label><span>Sesongtabell</span><select name="ranking_method"><option value="match_points">Kamp-poeng</option><option value="elo">ELO</option></select></label>
        <div id="seasonPointsFields" class="claim-two-columns"><label><span>Seier</span><input name="points_win" type="number" min="0" step="0.5" value="2"></label><label><span>Uavgjort</span><input name="points_draw" type="number" min="0" step="0.5" value="1"></label></div>
        <label><span>Tap</span><input name="points_loss" type="number" min="0" step="0.5" value="0"></label>
        <label class="inline-check"><input name="activate" type="checkbox"><span>Gjør til aktiv sesong med én gang</span></label>
        <button type="submit" class="button">Opprett sesong</button>
        <div id="seasonMessage" class="message hidden"></div>
      </form>
      <div><div class="subsection-head"><h3>Sesonger</h3><span id="seasonCount" class="pill">0</span></div><div id="seasonList" class="list"><div class="empty">Laster sesonger …</div></div></div>
    </div>
    <div id="seasonStandingsCard" class="claim-admin-card hidden"><div class="panel-head"><div><p class="eyebrow">Sesongtabell</p><h3 id="seasonStandingsTitle">Tabell</h3></div><button id="seasonStandingsClose" type="button" class="button quiet">Lukk</button></div><div id="seasonStandings"></div></div>`;
  document.getElementById("tournaments")?.after(section);

  const form = section.querySelector("#seasonForm");
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = clubId();
    if (!id) return;
    const data = new FormData(form);
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      await api(`/clubs/${id}/seasons`, { method: "POST", body: {
        name: data.get("name"), starts_on: data.get("starts_on"), ends_on: data.get("ends_on"),
        ranking_method: data.get("ranking_method"), points_win: Number(data.get("points_win") || 0),
        points_draw: Number(data.get("points_draw") || 0), points_loss: Number(data.get("points_loss") || 0), activate: data.get("activate") === "on",
      }});
      form.reset(); form.querySelector('[name="points_win"]').value = "2"; form.querySelector('[name="points_draw"]').value = "1"; form.querySelector('[name="points_loss"]').value = "0";
      message("Sesongen er opprettet.", "success");
      await load();
    } catch (error) { message(error.message, "error"); }
    finally { button.disabled = false; }
  });
  section.querySelector("#seasonStandingsClose")?.addEventListener("click", () => section.querySelector("#seasonStandingsCard")?.classList.add("hidden"));
}
function message(text, tone = "info") {
  const node = document.getElementById("seasonMessage");
  if (!node) return;
  node.textContent = text;
  node.className = `message ${tone}`;
}
function render(seasons) {
  const list = document.getElementById("seasonList");
  const count = document.getElementById("seasonCount");
  if (!list || !count) return;
  count.textContent = `${seasons.length} stk`;
  if (!seasons.length) { list.innerHTML = `<div class="empty">Ingen sesonger opprettet ennå.</div>`; return; }
  list.innerHTML = seasons.map((season) => `<article class="list-row season-row">
    <div><strong>${esc(season.name)}</strong><div class="row-meta"><span>${esc(fmtDate(season.starts_on))} – ${esc(fmtDate(season.ends_on))}</span><span>${Number(season.completed_tournament_count || 0)}/${Number(season.tournament_count || 0)} turneringer ferdig</span></div>${season.champion_name ? `<div class="row-meta"><strong>Sesongvinner: ${esc(season.champion_name)}</strong></div>` : ""}</div>
    <div class="board-controls"><span class="badge ${season.status === "active" ? "good" : season.status === "completed" ? "neutral" : "warning"}">${esc(statusLabel(season.status))}</span><button type="button" class="button secondary season-table" data-season="${Number(season.id)}">Tabell</button>${season.status !== "active" && season.status !== "completed" ? `<button type="button" class="button secondary season-activate" data-season="${Number(season.id)}">Aktiver</button>` : ""}${season.status === "active" ? `<button type="button" class="button season-complete" data-season="${Number(season.id)}">Avslutt sesong</button>` : ""}</div>
  </article>`).join("");
  list.querySelectorAll(".season-table").forEach((button) => button.addEventListener("click", () => showStandings(Number(button.dataset.season))));
  list.querySelectorAll(".season-activate").forEach((button) => button.addEventListener("click", async () => { button.disabled = true; try { await api(`/seasons/${Number(button.dataset.season)}/activate`, { method: "POST", body: {} }); await load(); } catch (e) { message(e.message, "error"); } finally { button.disabled = false; } }));
  list.querySelectorAll(".season-complete").forEach((button) => button.addEventListener("click", async () => { if (!confirm("Avslutte sesongen og låse sesongvinneren fra gjeldende tabell?")) return; button.disabled = true; try { await api(`/seasons/${Number(button.dataset.season)}/complete`, { method: "POST", body: {} }); await load(); await showStandings(Number(button.dataset.season)); } catch (e) { message(e.message, "error"); } finally { button.disabled = false; } }));
}
async function showStandings(seasonId) {
  try {
    const data = await api(`/seasons/${seasonId}/standings`);
    const card = document.getElementById("seasonStandingsCard");
    const title = document.getElementById("seasonStandingsTitle");
    const table = document.getElementById("seasonStandings");
    if (!card || !title || !table) return;
    title.textContent = data.season.name;
    const elo = data.season.ranking_method === "elo";
    table.innerHTML = data.items.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Spiller</th><th>Turn.</th><th>K</th><th>V</th><th>U</th><th>T</th><th>Leg +/-</th><th>${elo ? "ELO" : "Poeng"}</th></tr></thead><tbody>${data.items.map((row) => `<tr><td>${Number(row.position)}</td><td><strong>${esc(row.display_name)}</strong></td><td>${Number(row.tournaments)}</td><td>${Number(row.matches_played)}</td><td>${Number(row.wins)}</td><td>${Number(row.draws)}</td><td>${Number(row.losses)}</td><td>${Number(row.leg_diff) >= 0 ? "+" : ""}${Number(row.leg_diff)}</td><td><strong>${elo ? Number(row.elo_rating).toFixed(0) : Number(row.points).toLocaleString("nb-NO", { maximumFractionDigits: 2 })}</strong></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Ingen resultater i denne sesongen ennå.</div>`;
    card.classList.remove("hidden");
  } catch (error) { message(error.message, "error"); }
}
async function load() {
  ensureView();
  const id = clubId();
  if (!id || !token()) return;
  try { const data = await api(`/clubs/${id}/seasons`); render(data.items || []); } catch (error) { message(error.message, "error"); }
}

ensureView();
document.getElementById("clubSelect")?.addEventListener("change", () => setTimeout(load, 50));
window.addEventListener("storage", load);
window.addEventListener("bd:portal-view", (event) => { if (event.detail?.target === "seasons") load(); });
setTimeout(load, 500);