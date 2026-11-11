// Keep public club discovery separate from the member's personal history.
// Registration alone is not proof of attendance after an event is finished.
export function belongsInMyCalendar({ finished, registrationStatus, hasCompletedMatch = false }) {
  const status = String(registrationStatus || "").toLowerCase();
  if (hasCompletedMatch) return true;
  if (finished) return ["checked_in", "eliminated", "paused", "completed"].includes(status);
  return ["registered", "checked_in", "waitlisted", "paused"].includes(status);
}

export function participationBadge({ finished, registrationStatus, hasCompletedMatch = false }) {
  if (finished) return hasCompletedMatch ? "Deltok" : "Sjekket inn";
  return ({
    registered: "Påmeldt",
    checked_in: "Sjekket inn",
    waitlisted: "På venteliste",
    paused: "Midlertidig pause",
  })[String(registrationStatus || "")] || "Min turnering";
}
