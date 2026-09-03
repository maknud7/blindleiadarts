(() => {
  if (typeof renderPlayoff !== "function" || typeof render !== "function") return;

  const baseRender = render;
  const baseRenderBoards = renderBoards;

  function nodeStatusClass(node) {
    const status = String(node?.status || "waiting").replace(/[^a-z0-9_-]/gi, "-");
    return `status-${status}`;
  }

  function sourceWinner(rounds, roundIndex, node, slot) {
    if (roundIndex <= 0) return null;
    const previous = rounds[roundIndex - 1]?.nodes || [];
    const sourcePosition = ((Number(node.position || 1) - 1) * 2) + (slot === "a" ? 1 : 2);
    const source = previous.find((candidate) => Number(candidate.position) === sourcePosition);
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
    if (id && name) return { id: Number(id), name: String(name), advanced: false };
    return sourceWinner(rounds, roundIndex, node, slot);
  }

  function playerRow(rounds, roundIndex, node, slot) {
    const player = participant(rounds, roundIndex, node, slot);
    const score = slot === "a" ? Number(node.legs_a || 0) : Number(node.legs_b || 0);
    const isWinner = player && Number(node.winner_player_id) === Number(player.id);
    const hasScore = Boolean(node.match_id) && player;
    return `<div class="live-bracket-player${isWinner ? " winner" : ""}${player?.advanced ? " advanced" : ""}">
      <span class="live-bracket-player-name">${player ? esc(player.name) : "Venter …"}</span>
      ${hasScore ? `<strong class="live-bracket-score">${score}</strong>` : `<span class="live-bracket-score pending">–</span>`}
    </div>`;
  }

  function matchFooter(node) {
    const status = String(node.status || "");
    const score = `${Number(node.legs_a || 0)}–${Number(node.legs_b || 0)}`;
    if (status === "completed") return `<span class="playoff-match-result">Sluttresultat ${score}</span>`;
    if (status === "in_progress") return `<span class="playoff-match-result live">${score} · LIVE</span>`;
    return `<span>${esc(playoffStatus(node))}</span>`;
  }

  renderPlayoff = function renderPlayoffV5(data) {
    const active = Boolean(data?.playoff);
    document.body.classList.toggle("playoff-mode", active);
    if (!active) {
      el.playoffSection?.classList.add("hidden");
      return;
    }

    const rounds = Array.isArray(data.rounds) ? data.rounds : [];
    el.playoffSection?.classList.remove("hidden");
    el.playoffChampion.textContent = data.playoff.champion_name
      ? `🏆 ${data.playoff.champion_name}`
      : `${Number(data.entries?.length || 0)} kvalifiserte · Best av ${Number(data.playoff.best_of_legs || 3)}`;

    el.playoff.innerHTML = rounds.map((round, roundIndex) => {
      const nodes = Array.isArray(round.nodes) ? round.nodes : [];
      return `
      <section class="live-bracket-round" data-round="${roundIndex + 1}" style="--match-count:${Math.max(1, nodes.length)}">
        <div class="live-bracket-round-head"><span>Runde ${roundIndex + 1}</span><h3>${esc(round.label)}</h3></div>
        <div class="live-bracket-matches">${nodes.map((node) => `
          <article class="live-bracket-match ${nodeStatusClass(node)}${node.winner_player_id ? " decided" : ""}">
            <div class="live-bracket-match-top">
              <span class="playoff-match-number">${esc(round.label)}${nodes.length > 1 ? ` ${Number(node.position)}` : ""}</span>
              <span class="playoff-status-badge">${esc(playoffStatus(node))}</span>
            </div>
            ${playerRow(rounds, roundIndex, node, "a")}
            ${playerRow(rounds, roundIndex, node, "b")}
            <footer>${matchFooter(node)}</footer>
          </article>`).join("")}</div>
      </section>`;
    }).join("");
  };

  renderBoards = function renderPlayoffBoards(boards = []) {
    const inPlayoff = Boolean(state?.payload?.playoff?.playoff);
    if (!inPlayoff) {
      baseRenderBoards(boards);
      return;
    }
    const activeBoards = (Array.isArray(boards) ? boards : []).filter((board) => board?.live_match);
    if (!activeBoards.length) {
      el.boards.innerHTML = `<div class="playoff-no-live"><strong>Ingen kamp på skiven akkurat nå</strong><span>Bracketen viser hvem som er klar eller venter.</span></div>`;
      return;
    }
    baseRenderBoards(activeBoards);
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