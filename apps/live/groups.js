const LIVE_URL = "../api/dartsatlas-live.php";
const GROUPS_URL = "../api/dartsatlas-public-groups.php";

const groupState = {
  timer: null,
  lastTournamentId: null,
};

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

function createGroupsPanel() {
  let panel = document.getElementById("groupsPanel");
  if (panel) return panel;

  panel = document.createElement("section");
  panel.id = "groupsPanel";
  panel.className = "panel groups-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <div class="panel-heading">
      <div>
        <p class="eyebrow">PULJESPILL</p>
        <h2>Gruppetabeller</h2>
      </div>
      <span class="soft-pill">DartsAtlas</span>
    </div>
    <div id="groupsGrid" class="groups-grid"></div>
    <p class="groups-note">Tabellene hentes direkte fra DartsAtlas sin gruppevisning.</p>`;

  const contentGrid = document.querySelector(".content-grid");
  if (contentGrid?.parentNode) {
    contentGrid.parentNode.insertBefore(panel, contentGrid);
  }
  return panel;
}

function signed(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number > 0 ? `+${number}` : String(number);
}

function decimal(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2).replace(/\.00$/, "") : "—";
}

function renderGroup(group) {
  const rows = Array.isArray(group?.standings) ? group.standings : [];
  return `
    <article class="group-card">
      <h3>${escapeHtml(group?.label || "Gruppe")}</h3>
      <table class="group-table">
        <thead>
          <tr>
            <th class="position">#</th>
            <th>Spiller</th>
            <th>AVG</th>
            <th>W</th>
            <th>L</th>
            <th>LA</th>
            <th>LD</th>
            <th>Pts</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td class="position">${escapeHtml(row.position)}</td>
              <td><strong>${escapeHtml(row.player_name)}</strong></td>
              <td>${escapeHtml(decimal(row.average))}</td>
              <td>${escapeHtml(row.wins)}</td>
              <td>${escapeHtml(row.losses)}</td>
              <td>${escapeHtml(signed(row.la))}</td>
              <td>${escapeHtml(signed(row.leg_diff))}</td>
              <td class="points">${escapeHtml(row.points)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </article>`;
}

async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload?.error?.message || `HTTP ${response.status}`);
  }
  return payload.data;
}

function applyGroups(groups) {
  const panel = createGroupsPanel();
  const grid = document.getElementById("groupsGrid");
  const standingsPanel = document.querySelector(".standings-panel");

  if (!Array.isArray(groups) || groups.length === 0) {
    panel.hidden = true;
    if (standingsPanel) standingsPanel.hidden = false;
    return;
  }

  grid.innerHTML = groups.map(renderGroup).join("");
  panel.hidden = false;

  // A single combined table is misleading during a round-robin group stage.
  // When DartsAtlas exposes real groups, prefer those tables instead.
  if (standingsPanel) standingsPanel.hidden = true;
}

async function refreshGroups() {
  try {
    const live = await getJson(`${LIVE_URL}?groups_probe=${Date.now()}`);
    const tournamentId = Number(live?.tournament?.id || 0);
    if (!Number.isFinite(tournamentId) || tournamentId <= 0) {
      groupState.lastTournamentId = null;
      applyGroups([]);
      return;
    }

    groupState.lastTournamentId = tournamentId;
    const data = await getJson(`${GROUPS_URL}?tournament_id=${encodeURIComponent(tournamentId)}&_=${Date.now()}`);
    applyGroups(data?.groups || []);
  } catch (_) {
    // Keep the last good group tables on screen if DartsAtlas has a transient error.
  } finally {
    if (groupState.timer) window.clearTimeout(groupState.timer);
    groupState.timer = window.setTimeout(refreshGroups, 20000);
  }
}

window.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshGroups();
});

refreshGroups();
