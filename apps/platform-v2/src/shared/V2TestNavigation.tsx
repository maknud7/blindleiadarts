import "./v2-test-navigation.css";

function isTestHost(): boolean {
  return /^test\./i.test(window.location.hostname) || /(^|\.)test\./i.test(window.location.hostname);
}

export function V2TestNavigation({ active }: { active: "equipment" | "kiosk" }) {
  if (!isTestHost()) return null;

  return <nav className="v2-test-nav" aria-label="TEST-plattform">
    <span className="pill warn">TEST · Plattform v2</span>
    <a className={`button small ${active === "equipment" ? "" : "secondary"}`} href="/v2/equipment/">Utstyr</a>
    <a className={`button small ${active === "kiosk" ? "" : "secondary"}`} href="/v2/kiosk/?testmode=1">Kiosk</a>
    <a className="button secondary small" href="/admin/#overview">Administrasjon</a>
    <a className="button secondary small" href="/admin/#tournaments">Turneringer</a>
  </nav>;
}
