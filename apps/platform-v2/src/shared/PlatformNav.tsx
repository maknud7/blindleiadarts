import { useEffect } from "react";
import "./platform-nav.css";

type Surface = "equipment" | "kiosk" | "tournament";

type GuideWindow = Window & {
  BlindleiaApp?: {
    session?: { resolve?: (options?: { force?: boolean }) => Promise<unknown> };
  };
  BlindleiaUserGuideAccess?: { refresh?: () => void };
};

const routes = Object.freeze({
  admin: "/#club",
  tournament: "/#tournament-admin",
  equipment: "/v2/equipment/",
  kiosk: "/v2/kiosk/",
});

function isTestHost(): boolean {
  return /(^|[.-])test([.-]|$)/i.test(window.location.hostname) || /\/test(?:\/|$)/i.test(window.location.pathname);
}

function prodKioskHref(): string {
  const url = new URL(window.location.href);
  url.hostname = url.hostname.replace(/^test\./i, "");
  url.pathname = "/kiosk/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function PlatformNav({ active }: { active: Surface }) {
  const testHost = isTestHost();
  const kioskHref = testHost ? prodKioskHref() : routes.kiosk;

  useEffect(() => {
    const body = document.body;
    body.dataset.portalDefault = "overview";
    let disposed = false;
    let previousToken = localStorage.getItem("bd:token") || "";

    const load = (url: string) => import(/* @vite-ignore */ url);
    async function loadGuide() {
      try {
        await load("/packages/ui-assets/app-core.js?v=20260910-v2-nav-01");
        await load("/packages/ui-assets/user-guide.js?v=20260831-1453");
        await load("/packages/ui-assets/user-guide-access.js?v=20260831-1453");
        if (disposed) return;
        await (window as GuideWindow).BlindleiaApp?.session?.resolve?.({ force: true });
        (window as GuideWindow).BlindleiaUserGuideAccess?.refresh?.();
      } catch (error) {
        console.warn("Brukerguide kunne ikke lastes i Plattform v2", error);
      }
    }

    void loadGuide();
    const tokenSync = window.setInterval(() => {
      const token = localStorage.getItem("bd:token") || "";
      if (token === previousToken) return;
      previousToken = token;
      void (window as GuideWindow).BlindleiaApp?.session?.resolve?.({ force: true });
    }, 1000);

    return () => {
      disposed = true;
      window.clearInterval(tokenSync);
    };
  }, []);

  return <nav className="platform-nav portal-menu" aria-label="Plattformmeny">
    <div className="platform-nav-brand"><strong>BD</strong><span>{testHost ? "TEST · Plattform v2" : "Plattform v2"}</span></div>
    <div className="platform-nav-links">
      <a href={routes.admin}>Administrasjon</a>
      <a href={routes.tournament} className={active === "tournament" ? "active" : ""}>Turneringer</a>
      <a href={routes.equipment} className={active === "equipment" ? "active" : ""} aria-current={active === "equipment" ? "page" : undefined}>Utstyr</a>
      <a href={kioskHref} className={active === "kiosk" ? "active" : ""} aria-current={active === "kiosk" ? "page" : undefined}>{testHost ? "Kiosk · start TEST" : "Kiosk"}</a>
    </div>
  </nav>;
}
