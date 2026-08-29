const attendanceHost = document.getElementById("tournaments");

if (attendanceHost) {
  let polishing = false;

  function polishAttendanceCopy() {
    if (polishing) return;
    const next = document.getElementById("tcLeaderNext");
    if (!next) return;
    polishing = true;
    try {
      const lockButton = next.querySelector('[data-leader-action="finish-checkin"]');
      if (!lockButton) return;

      lockButton.textContent = "Lås startfelt";

      [...next.querySelectorAll("*")].forEach((node) => {
        const text = String(node.textContent || "").trim();
        if (!text || node.children.length) return;
        if (text === "Oppmøtet ser klart ut") {
          node.textContent = "Klar til å låse startfelt";
          return;
        }
        const readyMatch = text.match(/^(\d+) spillere blir med$/);
        if (readyMatch) {
          node.textContent = `${readyMatch[1]} spillere er sjekket inn`;
          return;
        }
        const pendingMatch = text.match(/^(\d+) påmeldte er ikke sjekket inn og blir markert som ikke møtt\.$/);
        if (pendingMatch) {
          node.textContent = `${pendingMatch[1]} påmeldte er ikke sjekket inn og blir markert som ikke møtt. Kun sjekket inn går videre til trekning og puljer.`;
          return;
        }
        if (text === "Alle med bekreftet plass er sjekket inn.") {
          node.textContent = "Alle med bekreftet plass er sjekket inn. Når startfeltet låses, er dette spillerne som går videre til trekning og puljer.";
        }
      });
      lockButton.title = "Lås oppmøtet. Bare sjekket inn tas med i trekning og puljer.";
    } finally {
      polishing = false;
    }
  }

  const observer = new MutationObserver(polishAttendanceCopy);
  observer.observe(attendanceHost, { childList: true, subtree: true });
  polishAttendanceCopy();
  window.addEventListener("bd:tournament-context", polishAttendanceCopy);
}
