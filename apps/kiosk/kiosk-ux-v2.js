(() => {
  const UX_VERSION = "2.0";
  let recentSignature = "";
  let matchBaseline = null;
  let snapshotSignature = "";
  let pendingThrow = null;
  let editSelection = null;
  let editValue = "";
  let editBusy = false;

  function matchSnapshot() {
    const match = currentMatch();
    if (!match) return null;
    return {
      id: Number(match.id || 0),
      status: String(match.status || ""),
      legNumber: Number(match.current_leg?.leg_number || 0),
      aLegs: Number(match.player_a?.legs_won || 0),
      bLegs: Number(match.player_b?.legs_won || 0),
      currentPlayerId: match.current_player_id == null ? null : Number(match.current_player_id),
      starterId: match.current_leg?.starting_player_id == null ? null : Number(match.current_leg.starting_player_id),
    };
  }

  function sameSnapshot(a, b) {
    return a && b && a.id === b.id && a.status === b.status && a.legNumber === b.legNumber && a.aLegs === b.aLegs && a.bLegs === b.bLegs && a.currentPlayerId === b.currentPlayerId && a.starterId === b.starterId;
  }

  function playerById(match, playerId) {
    if (!match || playerId == null) return null;
    if (Number(match.player_a?.id) === Number(playerId)) return match.player_a;
    if (Number(match.player_b?.id) === Number(playerId)) return match.player_b;
    return null;
  }

  function ensureUi() {
    document.body.classList.add("kiosk-ux-v2");
    document.body.dataset.kioskUx = UX_VERSION;

    const center = document.querySelector(".match-center");
    if (center && !document.getElementById("matchLegsScore")) {
      const label = document.createElement("span");
      label.id = "matchLegsLabel";
      label.className = "match-legs-label";
      label.textContent = "LEGS";

      const score = document.createElement("strong");
      score.id = "matchLegsScore";
      score.className = "match-legs-score";
      score.textContent = "0 – 0";
      score.setAttribute("aria-label", "Stilling i legs");

      const currentLegNode = document.getElementById("currentLeg");
      center.insertBefore(label, currentLegNode || null);
      center.insertBefore(score, currentLegNode || null);
    }

    const scoringCopy = document.querySelector(".scoring-head > div:first-child");
    if (scoringCopy && !document.getElementById("kioskLiveRemaining")) {
      const live = document.createElement("div");
      live.id = "kioskLiveRemaining";
      live.className = "live-remaining-preview";
      live.innerHTML = '<span>Gjenstår</span><strong>501</strong><small></small>';
      scoringCopy.appendChild(live);
    }

    const bull = document.querySelector('[data-special="bull"]');
    const dbull = document.querySelector('[data-special="dbull"]');
    const miss = document.querySelector('[data-special="miss"]');
    if (bull) bull.textContent = "BULL 25";
    if (dbull) dbull.textContent = "D-BULL 50";
    if (miss) miss.textContent = "MISS";

    const sumConfirm = document.querySelector('[data-key="ok"]');
    if (sumConfirm) {
      sumConfirm.textContent = "✓";
      sumConfirm.setAttribute("aria-label", "Lagre kast");
      sumConfirm.title = "Lagre kast";
    }

    if (el?.dartSubmitButton) {
      el.dartSubmitButton.textContent = "✓";
      el.dartSubmitButton.setAttribute("aria-label", "Lagre kast");
      el.dartSubmitButton.title = "Lagre kast";
    }

    ensureEditDialog();
    ensureLegWinOverlay();
  }

  function updateMatchUi() {
    const match = currentMatch();
    if (!match) return;

    const score = document.getElementById("matchLegsScore");
    if (score) score.textContent = `${Number(match.player_a?.legs_won || 0)} – ${Number(match.player_b?.legs_won || 0)}`;

    const currentId = match.current_player_id == null ? null : Number(match.current_player_id);
    const aId = Number(match.player_a?.id || 0);
    const bId = Number(match.player_b?.id || 0);
    el.playerABox?.classList.toggle("active", currentId !== null && currentId === aId);
    el.playerBBox?.classList.toggle("active", currentId !== null && currentId === bId);
    if (el.playerABox) el.playerABox.setAttribute("aria-current", currentId === aId ? "true" : "false");
    if (el.playerBBox) el.playerBBox.setAttribute("aria-current", currentId === bId ? "true" : "false");

    updateLiveRemaining();
  }

  function previewResult() {
    const match = currentMatch();
    if (!match) return { remaining: 501, label: "", bust: false, checkout: false };

    const before = Number(currentRemaining() || 0);
    const score = state.inputMode === "sum" ? Number(state.sumValue || 0) : Number(totalDarts() || 0);
    let after = before - score;
    let bust = false;
    let checkout = false;

    if (score > 180 || after < 0 || after === 1) bust = true;
    if (after === 0) {
      if (state.inputMode === "per_dart") checkout = isDoubleOut();
      else checkout = isCheckoutNumber(before);
      bust = !checkout;
    }

    if (bust) {
      return { remaining: before, label: "BUST", bust: true, checkout: false };
    }
    if (checkout) {
      return { remaining: 0, label: "CHECKOUT", bust: false, checkout: true };
    }
    return { remaining: Math.max(0, after), label: score > 0 ? `−${score}` : "", bust: false, checkout: false };
  }

  function updateLiveRemaining() {
    const live = document.getElementById("kioskLiveRemaining");
    if (!live) return;
    const preview = previewResult();
    const strong = live.querySelector("strong");
    const small = live.querySelector("small");
    if (strong) strong.textContent = String(preview.remaining);
    if (small) small.textContent = preview.label;
    live.classList.toggle("is-bust", preview.bust);
    live.classList.toggle("is-checkout", preview.checkout);
  }

  function visitMarkup(visit, index) {
    const bust = Number(visit.is_bust) === 1;
    const player = escapeHtml(visit.player_name || "Spiller");
    const score = Number(visit.score || 0);
    const after = Number(visit.remaining_after ?? 0);
    return `
      <button type="button" class="visit-row visit-editable" data-visit-index="${index}" aria-label="Rediger kast ${score} av ${player}">
        <div><strong>${player}</strong><span>#${Number(visit.visit_number || 0)}</span></div>
        <div><strong class="visit-score">${score}</strong><span>${bust ? "Bust" : `→ ${after}`}</span></div>
        <span class="visit-edit-icon" aria-hidden="true">✎</span>
      </button>`;
  }

  const baseRenderVisits = renderVisits;
  renderVisits = function renderVisitsUxV2() {
    const match = currentMatch();
    if (!match || !el?.recentVisits) {
      baseRenderVisits();
      return;
    }

    const visits = (match.recent_visits || []).slice(0, 4);
    const signature = JSON.stringify(visits.map((visit) => [visit.id, visit.score, visit.remaining_after, visit.is_bust, visit.player_id, visit.visit_number]));
    if (signature === recentSignature) return;
    recentSignature = signature;

    el.recentVisits.innerHTML = visits.length
      ? visits.map(visitMarkup).join("")
      : '<div class="empty-visits">Ingen kast registrert ennå.</div>';
  };

  const baseRenderInput = renderInput;
  renderInput = function renderInputUxV2() {
    baseRenderInput();
    ensureUi();
    updateLiveRemaining();
    if (el?.dartSubmitButton) el.dartSubmitButton.textContent = "✓";
    const sumConfirm = document.querySelector('[data-key="ok"]');
    if (sumConfirm) sumConfirm.textContent = "✓";
  };

  const baseRender = render;
  render = function renderUxV2() {
    const before = matchBaseline;
    const next = matchSnapshot();
    const rawSnapshotSignature = currentMatch() ? JSON.stringify(state.snapshot) : "";
    const canSkipStableMatch = Boolean(currentMatch() && state.renderedView === "match" && rawSnapshotSignature && rawSnapshotSignature === snapshotSignature);

    if (!canSkipStableMatch) baseRender();
    ensureUi();
    updateMatchUi();

    if (next && before && next.id === before.id && !sameSnapshot(next, before)) {
      const winner = next.aLegs > before.aLegs
        ? currentMatch()?.player_a
        : next.bLegs > before.bLegs
          ? currentMatch()?.player_b
          : null;
      if (winner && (next.aLegs + next.bLegs) > (before.aLegs + before.bLegs)) {
        showLegWin(winner, next.aLegs, next.bLegs, next.starterId, next.status === "completed");
      }
    } else if (!next && before && pendingThrow?.checkout && pendingThrow.matchId === before.id) {
      const aLegs = before.aLegs + (pendingThrow.playerId === pendingThrow.playerAId ? 1 : 0);
      const bLegs = before.bLegs + (pendingThrow.playerId === pendingThrow.playerBId ? 1 : 0);
      showLegWin({ display_name: pendingThrow.playerName }, aLegs, bLegs, null, true);
    }

    matchBaseline = next;
    if (rawSnapshotSignature) snapshotSignature = rawSnapshotSignature;
    pendingThrow = null;
  };

  function rememberPendingThrow() {
    const match = currentMatch();
    const player = currentPlayer();
    if (!match || !player || !isManual()) return;
    const preview = previewResult();
    pendingThrow = {
      matchId: Number(match.id || 0),
      playerId: Number(player.id || 0),
      playerName: player.display_name || "Spiller",
      playerAId: Number(match.player_a?.id || 0),
      playerBId: Number(match.player_b?.id || 0),
      checkout: preview.checkout,
    };
  }

  function ensureLegWinOverlay() {
    if (document.getElementById("legWinOverlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "legWinOverlay";
    overlay.className = "leg-win-overlay hidden";
    overlay.innerHTML = `
      <section class="leg-win-card" role="dialog" aria-modal="true" aria-labelledby="legWinTitle">
        <div class="leg-win-icon">✓</div>
        <p class="eyebrow">Leg ferdig</p>
        <h2 id="legWinTitle">Leg vunnet</h2>
        <strong id="legWinPlayer">—</strong>
        <div id="legWinScore" class="leg-win-score">0 – 0</div>
        <p id="legWinNext" class="muted"></p>
        <button id="legWinContinue" type="button">Start neste leg</button>
      </section>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#legWinContinue")?.addEventListener("click", () => overlay.classList.add("hidden"));
  }

  function showLegWin(winner, aLegs, bLegs, starterId, matchCompleted) {
    ensureLegWinOverlay();
    const overlay = document.getElementById("legWinOverlay");
    if (!overlay || !overlay.classList.contains("hidden")) return;
    const match = currentMatch();
    const starter = playerById(match, starterId);
    const winnerName = winner?.display_name || winner?.player_name || "Spiller";

    overlay.querySelector("#legWinPlayer").textContent = winnerName;
    overlay.querySelector("#legWinScore").textContent = `${Number(aLegs || 0)} – ${Number(bLegs || 0)}`;
    overlay.querySelector("#legWinNext").textContent = matchCompleted
      ? "Kampen er ferdig."
      : starter
        ? `Neste leg: ${starter.display_name} starter.`
        : "Neste leg er klart.";
    const button = overlay.querySelector("#legWinContinue");
    if (button) button.textContent = matchCompleted ? "Ferdig" : "Start neste leg";
    overlay.classList.remove("hidden");
  }

  function ensureEditDialog() {
    if (document.getElementById("visitEditDialog")) return;
    const dialog = document.createElement("dialog");
    dialog.id = "visitEditDialog";
    dialog.className = "visit-edit-dialog";
    dialog.innerHTML = `
      <div class="visit-edit-head">
        <div><p class="eyebrow">Rediger kast</p><h3 id="visitEditPlayer">—</h3></div>
        <button type="button" class="ghost-button" data-edit-action="cancel">Lukk</button>
      </div>
      <p id="visitEditMeta" class="muted"></p>
      <div id="visitEditDisplay" class="visit-edit-display">0</div>
      <div class="visit-edit-keypad">
        <button type="button" data-edit-key="1">1</button><button type="button" data-edit-key="2">2</button><button type="button" data-edit-key="3">3</button>
        <button type="button" data-edit-key="4">4</button><button type="button" data-edit-key="5">5</button><button type="button" data-edit-key="6">6</button>
        <button type="button" data-edit-key="7">7</button><button type="button" data-edit-key="8">8</button><button type="button" data-edit-key="9">9</button>
        <button type="button" data-edit-key="del" class="ghost-button">⌫</button><button type="button" data-edit-key="0">0</button><button type="button" data-edit-action="save" class="confirm-button">✓</button>
      </div>
      <p id="visitEditError" class="visit-edit-error" aria-live="polite"></p>
      <p class="visit-edit-note">Kastene etter dette regnes om automatisk.</p>`;
    document.body.appendChild(dialog);

    dialog.addEventListener("click", (event) => {
      const key = event.target.closest("[data-edit-key]")?.dataset.editKey;
      const action = event.target.closest("[data-edit-action]")?.dataset.editAction;
      if (key) editKey(key);
      if (action === "cancel" && !editBusy) dialog.close();
      if (action === "save") saveEditedVisit();
    });
  }

  function editKey(key) {
    if (editBusy) return;
    if (key === "del") editValue = editValue.slice(0, -1);
    else if (editValue.length < 3) editValue = editValue === "0" ? key : `${editValue}${key}`;
    updateEditDisplay();
  }

  function updateEditDisplay() {
    const display = document.getElementById("visitEditDisplay");
    if (display) display.textContent = editValue || "0";
    const error = document.getElementById("visitEditError");
    if (error) error.textContent = "";
  }

  function openVisitEditor(index) {
    if (!isManual() || state.mutating) return;
    const visits = (currentMatch()?.recent_visits || []).slice(0, 4);
    const visit = visits[index];
    if (!visit) return;

    editSelection = { index, visitId: Number(visit.id || 0) };
    editValue = String(Number(visit.score || 0));
    const dialog = document.getElementById("visitEditDialog");
    if (!dialog) return;
    dialog.querySelector("#visitEditPlayer").textContent = visit.player_name || "Spiller";
    dialog.querySelector("#visitEditMeta").textContent = `Kast #${Number(visit.visit_number || 0)} · ${Number(visit.score || 0)} poeng · gjenstod ${Number(visit.remaining_after ?? 0)}`;
    updateEditDisplay();
    dialog.showModal();
  }

  async function saveEditedVisit() {
    if (editBusy || !editSelection) return;
    const score = Number(editValue || 0);
    const error = document.getElementById("visitEditError");
    if (!POSSIBLE.has(score)) {
      if (error) error.textContent = "Denne summen kan ikke oppnås med tre piler.";
      return;
    }

    const match = currentMatch();
    const visits = (match?.recent_visits || []).slice(0, 4);
    const target = visits[editSelection.index];
    if (!match || !target || Number(target.id || 0) !== editSelection.visitId) {
      if (error) error.textContent = "Kampen har endret seg. Lukk og åpne kastet på nytt.";
      return;
    }

    const affected = visits.slice(0, editSelection.index + 1);
    const newerChronological = affected.slice(0, editSelection.index).reverse();
    const code = encodeURIComponent(currentKiosk()?.code || state.kioskCode || "");
    if (!code) return;

    editBusy = true;
    state.mutating = true;
    document.getElementById("visitEditDialog")?.classList.add("is-busy");
    if (error) error.textContent = "Oppdaterer kast …";

    try {
      for (let index = 0; index <= editSelection.index; index += 1) {
        state.snapshot = await api(`/kiosks/${code}/undo`, { method: "POST" });
      }

      state.snapshot = await api(`/kiosks/${code}/visit`, {
        method: "POST",
        body: { input_mode: "sum", score, darts_used: Number(target.darts_used || 3) },
      });

      for (const visit of newerChronological) {
        state.snapshot = await api(`/kiosks/${code}/visit`, {
          method: "POST",
          body: { input_mode: "sum", score: Number(visit.score || 0), darts_used: Number(visit.darts_used || 3) },
        });
      }

      editSelection = null;
      document.getElementById("visitEditDialog")?.close();
      resetInput();
      recentSignature = "";
      snapshotSignature = "";
      render();
      showToast("Kastet er oppdatert.");
    } catch (cause) {
      console.error("Klarte ikke redigere kast", cause);
      if (error) error.textContent = `${cause?.message || "Kunne ikke oppdatere kastet."} Kontroller siste kast før dere fortsetter.`;
      try { await loadState(); } catch (_) { /* keep visible error */ }
    } finally {
      editBusy = false;
      state.mutating = false;
      document.getElementById("visitEditDialog")?.classList.remove("is-busy");
    }
  }

  ensureUi();
  updateMatchUi();
  matchBaseline = matchSnapshot();
  if (currentMatch()) snapshotSignature = JSON.stringify(state.snapshot);

  el?.recentVisits?.addEventListener("click", (event) => {
    const row = event.target.closest("[data-visit-index]");
    if (!row) return;
    openVisitEditor(Number(row.dataset.visitIndex));
  });

  el?.dartSubmitButton?.addEventListener("click", rememberPendingThrow, { capture: true });
  document.querySelector('[data-key="ok"]')?.addEventListener("click", rememberPendingThrow, { capture: true });
})();
