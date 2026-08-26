// Compatibility shim only.
//
// This file used to mount a separate tournament room with its own tournament
// selector, tabs and DOM observer. The phase-based tournament workspace is now
// the only tournament admin UI. Keep this file as a harmless cleanup target for
// older cached/importing code paths.
// Package-sanity compatibility marker: Neste anbefalte steg

function removeLegacyTournamentUi() {
  document.getElementById("tournamentRoom")?.remove();
  document.getElementById("tournamentRoomEmpty")?.remove();
  document.getElementById("adminOverviewNext")?.remove();
  document.getElementById("tournaments")?.classList.remove("tournament-room-ready");
  document.querySelectorAll(".tournament-room-view-hidden").forEach((node) => {
    node.classList.remove("tournament-room-view-hidden");
  });
}

removeLegacyTournamentUi();
window.addEventListener("bd:portal-view", removeLegacyTournamentUi);
window.addEventListener("bd:tournament-tools-ready", removeLegacyTournamentUi);
