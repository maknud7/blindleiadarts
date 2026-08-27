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
    const adminTarget = currentHash.replace(/^admin\//, "") || "overview";
    target.hash = `#admin/${adminTarget}`;
  } else {
    target.hash = currentHash ? `#${currentHash.replace(/^admin\//, "")}` : "";
  }

  window.location.replace(target.href);
})();
