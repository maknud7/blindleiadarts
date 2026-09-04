// Deprecated compatibility shim.
//
// Older cached tournament-loader versions may still import this module. It must
// therefore remain safe to execute even after the active loader has stopped
// importing it. Do not add polling, MutationObservers or DOM ownership here.
// The canonical tournament modules own attendance state and rendering.

const attendanceHost = document.getElementById("tournaments");

if (attendanceHost) {
  function normalizeLegacyCopy() {
    const stageCountLabel = document.querySelector("#tcStageCheckin .tc-stage-count span");
    if (stageCountLabel && stageCountLabel.textContent !== "sjekket inn") {
      stageCountLabel.textContent = "sjekket inn";
    }

    const finishButton = document.querySelector('#tcLeaderNext [data-leader-action="finish-checkin"]');
    if (finishButton && finishButton.textContent !== "Avslutt innsjekk") {
      finishButton.textContent = "Avslutt innsjekk";
      finishButton.title = "Avslutt innsjekken. Bare spillere som er sjekket inn går videre.";
    }

    document.querySelectorAll("#tcLeaderNext *").forEach((node) => {
      if (node.children.length) return;
      const text = String(node.textContent || "").trim();
      if (text === "Klar til å låse startfelt") node.textContent = "Oppmøtet er klart";
    });
  }

  normalizeLegacyCopy();
  window.addEventListener("bd:tournament-tools-ready", normalizeLegacyCopy);
  window.addEventListener("bd:tournament-context", () => window.requestAnimationFrame(normalizeLegacyCopy));
}
