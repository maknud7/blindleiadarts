const API_ROOT = "../api/v1";
const TOKEN_KEY = "bd:screenToken";

const ui = {
  stage: document.getElementById("stageLabel"),
  progressText: document.getElementById("progressText"),
  progressBar: document.getElementById("progressBar"),
  liveCount: document.getElementById("liveCount"),
  boards: document.getElementById("boardsGrid"),
  contextTitle: document.getElementById("contextTitle"),
  contextSubtitle: document.getElementById("contextSubtitle"),
  context: document.getElementById("contextContent"),
  results: document.getElementById("recentResults"),
  pulse: document.getElementById("pulseMetrics"),
  elo: document.getElementById("phase3EloList"),
  clock: document.getElementById("screenClock"),
};

const phase3State = {
  busy: false,
  timer: null,
  resultIds: new Set(),
  resultHistoryReady: false,
  stageKey: null,
};

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function fmt(value, decimals = 2) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(decimals) : "—";
}

function fmtTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("nb-NO", { hour: "2-digit", minute: "2-digit" }).format(date);
}

async function api(path) {
  const response = await fetch(`${API_ROOT}${path}`, { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || "Kunne ikke hente live-data.");
  return payload.data;
}

function roundLabel(match) {
  return String(match?.round_label || match?.bracket_label || "Kamp");
}

function normalizeRound(value) {
  const raw = String(value || "").trim();
  const lower = raw.toLowerCase();
  if (lower.includes("quarter") || lower.includes("kvart")) return "Kvartfinale";
  if (lower.includes("semi")) return "Semifinale";
  if (lower === "final" || lower.includes("finale")) return "Finale";
  return raw || "Sluttspill";
}

function resolveStage(screen, venue) {
  const tournament = screen?.tournament || venue?.tournament;
  if (!tournament) return { key: "idle", kind: "idle", label: "Venter", detail: "Ingen aktiv turnering" };
  if (String(tournament.status) === "completed") return { key: "completed", kind: "completed", label: "Ferdig", detail: "Turneringen er ferdig" };

  const matches = [];
  for (const board of Array.isArray(screen?.live_boards) ? screen.live_boards : []) {
    if (board?.match) matches.push(board.match);
  }
  matches.push(...(Array.isArray(screen?.next_matches) ? screen.next_matches : []));
  const playoffMatch = matches.find((match) => /quarter|kvart|semi|final|playoff|sluttspill/i.test(`${roundLabel(match)} ${match?.bracket_label || ""}`));
  if (playoffMatch) {
    const label = normalizeRound(roundLabel(playoffMatch));
    return { key: `playoff:${label}`, kind: "playoff", label, detail: "Sluttspill" };
  }

  const rounds = Array.isArray(venue?.playoff?.rounds) ? venue.playoff.rounds : [];
  for (const round of rounds) {
    const nodes = Array.isArray(round?.nodes) ? round.nodes : [];
    const open = nodes.some((node) => ["pending", "assigned", "in_progress", "ready"].includes(String(node?.match?.status || node?.status || "")));
    if (open) {
      const label = normalizeRound(round?.label || round?.round_label);
      return { key: `playoff:${label}`, kind: "playoff", label, detail: "Sluttspill" };
    }
  }

  if (Array.isArray(venue?.tables?.groups) && venue.tables.groups.length) {
    return { key: "group", kind: "group", label: "Gruppespill", detail: "Round robin" };
  }
  return { key: "tournament", kind: "tournament", label: "Turnering", detail: "Pågår" };
}

function progressFor(screen, venue) {
  if (venue?.progress) {
    const total = number(venue.progress.total);
    const completed = number(venue.progress.completed);
    const percent = Number.isFinite(Number(venue.progress.percent))
      ? number(venue.progress.percent)
      : total > 0 ? (completed / total) * 100 : 0;
    return { total, completed, percent: Math.max(0, Math.min(100, percent)) };
  }
  const total = number(screen?.tournament?.match_count);
  const completed = number(screen?.tournament?.completed_match_count);
  return { total, completed, percent: total > 0 ? (completed / total) * 100 : 0 };
}

function groupTable(group) {
  const rows = Array.isArray(group?.rows) ? group.rows.slice(0, 6) : [];
  return `<section class="phase3-group-table">
    <div class="phase3-group-title">${esc(group?.name || "Tabell")}</div>
    <div class="phase3-table-head"><span>#</span><span>Spiller</span><span>P</span><span>LD</span><span>3DA</span></div>
    ${rows.map((row, index) => `<div class="phase3-table-row">
      <span>${row.position || index + 1}</span><strong>${esc(row.display_name)}</strong><span>${number(row.points)}</span>
      <span>${number(row.leg_diff) >= 0 ? "+" : ""}${number(row.leg_diff)}</span><span>${fmt(row.three_dart_average)}</span>
    </div>`).join("")}
  </section>`;
}

function playoffNode(node) {
  const match = node?.match || node || {};
  const a = match.player_a_name || node?.player_a_name || "—";
  const b = match.player_b_name || node?.player_b_name || "—";
  const scoreA = match.player_a_legs ?? node?.player_a_legs;
  const scoreB = match.player_b_legs ?? node?.player_b_legs;
  const score = scoreA !== undefined && scoreA !== null && scoreB !== undefined && scoreB !== null ? `${scoreA}–${scoreB}` : "vs";
  return `<div class="phase3-bracket-node"><strong>${esc(a)}</strong><span>${esc(score)}</span><strong>${esc(b)}</strong></div>`;
}

function playoffStrip(playoff) {
  const rounds = Array.isArray(playoff?.rounds) ? playoff.rounds : [];
  if (!rounds.length) return "";
  return `<div class="phase3-bracket-strip">${rounds.slice(-3).map((round) => {
    const nodes = Array.isArray(round?.nodes) ? round.nodes.slice(0, 4) : [];
    return `<section class="phase3-bracket-round"><div class="phase3-group-title">${esc(normalizeRound(round?.label || round?.round_label))}</div>${nodes.map(playoffNode).join("")}</section>`;
  }).join("")}</div>`;
}

function renderContext(stage, screen, venue) {
  const bracket = stage.kind === "playoff" ? playoffStrip(venue?.playoff) : "";
  if (bracket) {
    ui.contextTitle.textContent = stage.label;
    ui.contextSubtitle.textContent = "Sluttspill · veien videre";
    ui.context.innerHTML = bracket;
    return;
  }

  const groups = Array.isArray(venue?.tables?.groups) ? venue.tables.groups : [];
  if (groups.length) {
    ui.contextTitle.textContent = groups.length > 1 ? "Gruppetabeller" : (groups[0].name || "Tabell");
    ui.contextSubtitle.textContent = "Poeng → leg differanse → 3DA → innbyrdes";
    ui.context.innerHTML = `<div class="phase3-groups-grid">${groups.slice(0, 2).map(groupTable).join("")}</div>`;
    return;
  }

  const rows = Array.isArray(screen?.standings) ? screen.standings.slice(0, 6) : [];
  ui.contextTitle.textContent = "Tabell";
  ui.contextSubtitle.textContent = "Status akkurat nå";
  ui.context.innerHTML = rows.length
    ? `<section class="phase3-group-table"><div class="phase3-table-head simple"><span>#</span><span>Spiller</span><span>P</span><span>LD</span></div>${rows.map((row, index) => `<div class="phase3-table-row simple"><span>${index + 1}</span><strong>${esc(row.display_name)}</strong><span>${number(row.match_points)}</span><span>${number(row.leg_diff) >= 0 ? "+" : ""}${number(row.leg_diff)}</span></div>`).join("")}</section>`
    : `<div class="phase3-empty">Tabellen fylles når kampene starter.</div>`;
}

function renderResult(result) {
  const meta = [roundLabel(result), result.board_number ? `Skive ${result.board_number}` : "", fmtTime(result.finished_at)].filter(Boolean).join(" · ");
  return `<article class="phase3-result-item"><div class="phase3-result-score"><strong>${number(result.legs_a)}</strong><span>–</span><strong>${number(result.legs_b)}</strong></div><div class="phase3-result-copy"><strong>${esc(result.player_a_name)} <span>vs</span> ${esc(result.player_b_name)}</strong><small>${esc(meta)}</small></div></article>`;
}

function renderElo(entry, index) {
  const rating = entry.rating ?? entry.elo_rating ?? entry.points;
  return `<article class="phase3-elo-row"><span>${entry.position || index + 1}</span><strong>${esc(entry.display_name)}</strong><em>${fmt(rating, 1)}</em></article>`;
}

function showEvent(title, player, detail) {
  let overlay = document.getElementById("liveEventOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "liveEventOverlay";
    overlay.innerHTML = `<div class="live-event-card"><div class="live-event-kicker">Blindleia Live</div><div class="live-event-title"></div><div class="live-event-player"></div><div class="live-event-detail"></div></div>`;
    document.body.appendChild(overlay);
  }
  overlay.querySelector(".live-event-title").textContent = title;
  overlay.querySelector(".live-event-player").textContent = player || "";
  overlay.querySelector(".live-event-detail").textContent = detail || "";
  overlay.classList.add("show");
  window.setTimeout(() => overlay.classList.remove("show"), 3800);
}

function detectPhase3Events(stage, venue) {
  const results = Array.isArray(venue?.recent_results) ? venue.recent_results : [];
  const ids = new Set(results.map((row) => number(row?.id)).filter((id) => id > 0));
  let shown = false;

  if (venue && !phase3State.resultHistoryReady) {
    phase3State.resultIds = ids;
    phase3State.resultHistoryReady = true;
  } else if (phase3State.resultHistoryReady) {
    const fresh = results.find((row) => number(row?.id) > 0 && !phase3State.resultIds.has(number(row.id)));
    if (fresh) {
      showEvent("KAMP FERDIG", fresh.winner_name || "Resultat registrert", `${fresh.player_a_name} ${number(fresh.legs_a)}–${number(fresh.legs_b)} ${fresh.player_b_name}`);
      shown = true;
    }
    if (venue) phase3State.resultIds = ids;
  }

  if (!shown && phase3State.stageKey && phase3State.stageKey !== stage.key && stage.kind === "playoff" && !String(phase3State.stageKey).startsWith("playoff:")) {
    showEvent("SLUTTSPILLET STARTER", stage.label, "Gruppespillet er ferdig");
  }
  phase3State.stageKey = stage.key;
}

function renderPhase3(screen, venue) {
  if (!screen) return;
  document.body.classList.toggle("phase3-has-tournament", Boolean(screen.tournament));
  const stage = resolveStage(screen, venue);
  const progress = progressFor(screen, venue);
  const liveCount = (Array.isArray(screen.live_boards) ? screen.live_boards : []).filter((board) => board.state === "in_progress").length;
  const results = Array.isArray(venue?.recent_results) ? venue.recent_results : [];
  const highlights = venue?.highlights || {};
  const elo = Array.isArray(venue?.elo) && venue.elo.length ? venue.elo : (Array.isArray(screen?.stats?.elo) ? screen.stats.elo : []);

  ui.stage.textContent = stage.label;
  ui.stage.dataset.kind = stage.kind;
  ui.progressText.textContent = progress.total > 0 ? `${progress.completed} / ${progress.total} kamper · ${Math.round(progress.percent)} %` : "Venter på kamper";
  ui.progressBar.style.width = `${progress.percent}%`;
  ui.liveCount.textContent = `${liveCount} live`;
  if (ui.boards) {
    const boardCount = Array.isArray(screen.live_boards) ? screen.live_boards.length : 0;
    ui.boards.dataset.count = String(Math.min(boardCount, 6));
    ui.boards.classList.toggle("many", boardCount > 4);
  }
  ui.results.innerHTML = results.length ? results.slice(0, 4).map(renderResult).join("") : `<div class="phase3-empty">Resultatene dukker opp her fortløpende.</div>`;

  renderContext(stage, screen, venue);

  ui.pulse.innerHTML = `
    <div class="phase3-pulse-card"><span>180 i kveld</span><strong>${number(highlights.score_180)}</strong></div>
    <div class="phase3-pulse-card"><span>Beste 3DA</span><strong>${fmt(highlights.best_average)}</strong></div>
    <div class="phase3-pulse-card"><span>Pågår nå</span><strong>${liveCount}</strong></div>
    <div class="phase3-pulse-card"><span>Ferdig</span><strong>${progress.completed}/${progress.total || 0}</strong></div>`;
  ui.elo.innerHTML = elo.length ? elo.slice(0, 3).map(renderElo).join("") : `<div class="phase3-empty compact">Ingen ELO-data ennå.</div>`;

  detectPhase3Events(stage, venue);
}

async function refreshPhase3() {
  const token = localStorage.getItem(TOKEN_KEY) || "";
  if (!token || phase3State.busy) return;
  phase3State.busy = true;
  try {
    const screen = await api(`/public/screen?screen_token=${encodeURIComponent(token)}`);
    let venue = null;
    const slug = String(screen?.club?.slug || "").trim();
    if (slug && screen?.tournament) {
      try { venue = await api(`/public/clubs/${encodeURIComponent(slug)}/live`); }
      catch { venue = null; }
    }
    renderPhase3(screen, venue);
  } catch {
    // Base screen runtime owns pairing/error handling. Keep the last phase-3 snapshot.
  } finally {
    phase3State.busy = false;
  }
}

function updateClock() {
  if (!ui.clock) return;
  ui.clock.textContent = new Intl.DateTimeFormat("nb-NO", { hour: "2-digit", minute: "2-digit" }).format(new Date());
}

updateClock();
window.setInterval(updateClock, 15000);
refreshPhase3();
phase3State.timer = window.setInterval(refreshPhase3, 2000);
window.addEventListener("storage", (event) => {
  if (event.key === TOKEN_KEY) {
    phase3State.resultIds.clear();
    phase3State.resultHistoryReady = false;
    phase3State.stageKey = null;
    refreshPhase3();
  }
});
window.addEventListener("beforeunload", () => {
  if (phase3State.timer) window.clearInterval(phase3State.timer);
});