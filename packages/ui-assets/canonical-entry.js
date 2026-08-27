(() => {
  const pathname = window.location.pathname;
  const match = pathname.match(/^(.*\/)(player|admin)\/(?:index\.html)?$/i);
  if (!match) return;

  const rootPath = match[1] || "/";
  const surface = match[2].toLowerCase();
  const currentHash = window.location.hash.replace(/^#/, "").trim();
  const target = new URL(window.location.href);
  target.pathname = rootPath;

  if (surface === "admin") {
    const raw = currentHash.replace(/^admin\//, "") || "overview";
    const routes = {
      overview: "club",
      tournaments: "tournament-admin",
      seasons: "seasons",
      playerbase: "playerbase",
      players: "members",
      kiosks: "equipment",
      integrations: "settings",
      superadmin: "superadmin",
    };
    target.hash = `#${routes[raw] || "club"}`;
  } else {
    target.hash = currentHash ? `#${currentHash.replace(/^admin\//, "")}` : "";
  }

  window.location.replace(target.href);
})();
