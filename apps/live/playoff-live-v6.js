(() => {
  if (typeof renderPlayoff !== "function" || typeof render !== "function") return;

  const baseRender = render;
  const baseRenderBoards = renderBoards;

  function cleanStatus(value) {
    return String(value || "waiting").replace(/[^a-z0-9_-]/gi, "-");
  }

  function nodeStatusClass(node) {
    return `status-${cleanStatus(node?.status)}`;
  }

  function sourceNode(rounds, roundIndex, node, slot) {
    if (roundIndex <= 0) return null;
    const previous = rounds[roundIndex - 1]?.nodes || [];
    const sourcePosition = ((Number(node.position || 1) - 1) * 2) + (slot === "a" ? 1 : 2);
    return previous.find((candidate) => Number(candidate.position) === sourcePosition) || null;
  }

  function sourceWinner(rounds, roundIndex, node, slot) {
    const source = sourceNode(rounds, roundIndex, node, slot);
    if (!source?.winner_player_id || !source?.winner_name) return null;
    return {
      id: Number(source.winner_player_id),
      name: String(source.winner_name),
      advanced: true,
    };
  }

  function participant(rounds, roundIndex, node, slot) {
    const id = slot === "a" ? node.player_a_id : node.player_b_id;
    const name = slot === "a" ? node.player_a_name : node.player_b_name;
    if (id && name) {
      const source = sourceWinner(rounds, roundIndex, node, slot);
      return {
        id: Number(id),
        name: String(name),
        advanced: Boolean(source && Number(source.id) === Number(id)),
      };
    }
    return sourceWinner(rounds, roundIndex, node, slot);
  }

  function liveBoardForNode(node) {
    const matchId = Number(node?.match_id || 0);
    if (!matchId) return null;
    const boards = Array.isArray(state?.payload?.boards) ? state.payload.boards : [];
    for (const board of boards) {
      const match = board?.live_match;
      if (Number(match?.id || 0) === matchId) {
        return { board, match };
      }
    }
    return null;
  }

  function livePlayer(match, playerId) {
    if (!match || !playerId) return null;
    if (Number(match.player_a?.id) === Number(playerId)) return match.player_a;
    if (Number(match.player_b?.id) === Number(playerId)) return match.player_b;
    return null;
  }

  function statusLabel(node, liveInfo) {
    const status = String(node?.status || "");
    if (status === "completed") return "Ferdig";
    if (status === "in_progress") return "Live";
    if (status === "assigned" || liveInfo) return "Klar";
    if (status === "bye") return "Bye";
    const hasBoth = Boolean(node?.player_a_id && node?.player_b_id);
    return hasBoth ? "Klar" : "Venter";
  }

  function playerRow(rounds, roundIndex, node, slot, liveInfo) {
    const player = participant(rounds, roundIndex, node, slot);
    const status = String(node.status || "");
    const isWinner = player && Number(node.winner_player_id) === Number(player.id);
    const live = livePlayer(liveInfo?.match, player?.id);
    const active = Boolean(liveInfo?.match?.current_player_id && player && Number(liveInfo.match.current_player_id) === Number(player.id));
    const score = slot === "a" ? Number(node.legs_a || 0) : Number(node.legs_b || 0);
    const showLiveScore = Boolean(live && (status === "in_progress" || status === "assigned"));
    const showMatchScore = Boolean(node.match_id) && player;

    if (!player) {
      return `<div class="live-bracket-player pending-player">
        <span class="playoff-throw-marker" aria-hidden="true"></span>
        <span class="live-bracket-player-name">Venter …</span>
        <span class="playoff-leg-score pending">–</span>
        <span class="playoff-remaining-score pending">–</span>
      </div>`;
    }

    return `<div class="live-bracket-player${isWinner ? " winner" : ""}${player.advanced ? " advanced" : ""}${active ? " active-throw" : ""}">
      <span class="playoff-throw-marker" aria-hidden="true">${active ? "▶" : ""}</span>
      <span class="live-bracket-player-name">${esc(player.name)}</span>
      <strong class="playoff-leg-score">${showMatchScore ? score : "–"}</strong>
      ${showLiveScore
        ? `<strong class="playoff-remaining-score">${Number(live.remaining)}</strong>`
        : `<span class="playoff-remaining-score${status === "completed" ? " final" : " pending"}">${status === "completed" ? "" : "–"}</span>`}
    </div>`;
  }

  function boardNumber(node, liveInfo) {
    return Number(liveInfo?.board?.board_number || node?.board_number || 0);
  }

  function matchFooter(node, liveInfo) {
    const status = String(node.status || "");
    const score = `${Number(node.legs_a || 0)}–${Number(node.legs_b || 0)}`;
    const board = boardNumber(node, liveInfo);
    const boardChip = board > 0 ? `<span class="playoff-board-chip">Skive ${board}</span>` : "";

    if (status === "completed") {
      return `<span class="playoff-match-result">Sluttresultat ${score}</span>`;
    }
    if (status === "bye") {
      return `<span class="playoff-match-note">Videre på bye</span>`;
    }
    if (status === "in_progress" && liveInfo?.match) {
      const leg = Number(liveInfo.match.leg_number || 0);
      const bestOf = Number(liveInfo.match.best_of_legs || 0);
      const currentId = Number(liveInfo.match.current_player_id || 0);
      const current = currentId === Number(liveInfo.match.player_a?.id)
        ? liveInfo.match.player_a
        : currentId === Number(liveInfo.match.player_b?.id)
          ? liveInfo.match.player_b
          : null;
      const meta = leg > 0 ? `Leg ${leg}${bestOf > 0 ? ` av ${bestOf}` : ""}` : "Kamp pågår";
      const throwing = current?.display_name ? `${esc(current.display_name)} kaster` : "Live";
      return `${boardChip}<span class="playoff-match-note">${meta}</span><span class="playoff-throwing">${throwing}<i></i></span>`;
    }
    if (status === "assigned" || liveInfo) {
      return `${boardChip}<span class="playoff-match-note">Klar til kamp</span>`;
    }
    if (node.player_a_id && node.player_b_id) {
      return `<span class="playoff-match-note">Klar til kamp</span>`;
    }
    return `<span class="playoff-match-note">Venter på motstander</span>`;
  }

  function matchCard(rounds, roundIndex, round, node) {
    const nodes = Array.isArray(round.nodes) ? round.nodes : [];
    const liveInfo = liveBoardForNode(node);
    const status = String(node.status || "");
    const hasLiveScore = Boolean(liveInfo?.match && (status === "in_progress" || status === "assigned"));
    const label = nodes.length > 1 ? `${round.label} ${Number(node.position)}` : round.label;
    return `<article class="live-bracket-match ${nodeStatusClass(node)}${node.winner_player_id ? " decided" : ""}${hasLiveScore ? " has-live-score" : ""}">
      <div class="live-bracket-match-top">
        <span class="playoff-match-number">${esc(label)}</span>
        <div class="playoff-match-top-right">
          ${hasLiveScore ? `<span class="playoff-score-columns"><span>Legs</span><span>Score</span></span>` : ""}
          <span class="playoff-status-badge">${esc(statusLabel(node, liveInfo))}</span>
        </div>
      </div>
      ${playerRow(rounds, roundIndex, node, "a", liveInfo)}
      ${playerRow(rounds, roundIndex, node, "b", liveInfo)}
      <footer>${matchFooter(node, liveInfo)}</footer>
    </article>`;
  }

  renderPlayoff = function renderPlayoffV6(data) {
    const active = Boolean(data?.playoff);
    document.body.classList.toggle("playoff-mode", active);
    if (!active) {
      el.playoffSection?.classList.add("hidden");
      return;
    }

    const rounds = Array.isArray(data.rounds) ? data.rounds : [];
    const bestOf = Number(data.playoff.best_of_legs || 3);
    el.playoffSection?.classList.remove("hidden");
    el.playoffChampion.textContent = data.playoff.champion_name
      ? `🏆 ${data.playoff.champion_name}`
      : `${Number(data.entries?.length || 0)} kvalifiserte · Best av ${bestOf}`;

    el.playoff.innerHTML = rounds.map((round, roundIndex) => {
      const nodes = Array.isArray(round.nodes) ? round.nodes : [];
      return `<section class="live-bracket-round" data-round="${roundIndex + 1}" style="--match-count:${Math.max(1, nodes.length)}">
        <div class="live-bracket-round-head"><h3>${esc(round.label)}</h3><span>Best av ${bestOf}</span></div>
        <div class="live-bracket-matches">${nodes.map((node) => matchCard(rounds, roundIndex, round, node)).join("")}</div>
      </section>`;
    }).join("");
  };

  renderBoards = function renderPlayoffBoards(boards = []) {
    const inPlayoff = Boolean(state?.payload?.playoff?.playoff);
    if (!inPlayoff) {
      baseRenderBoards(boards);
      return;
    }
    // In playoff mode the bracket itself owns all live score information.
    // Keep the legacy board node empty so group-stage behavior remains intact.
    el.boards.innerHTML = "";
  };

  render = function renderWithPlayoffMode(payload) {
    baseRender(payload);
    const active = Boolean(payload?.playoff?.playoff);
    document.body.classList.toggle("playoff-mode", active);
    if (active && el.tournamentMeta) {
      const status = String(payload?.tournament?.status || "");
      const statusText = status === "completed" ? "Ferdig" : status === "ready" ? "Klar" : "Pågår";
      const when = payload?.tournament?.start_at ? ` · ${formatDateTime(payload.tournament.start_at)}` : "";
      el.tournamentMeta.textContent = `Sluttspill · ${statusText}${when}`;
    }
  };
})();
