(() => {
  const BRAND_VERSION = "3.2";
  let stableSnapshotSignature = "";
  let topSponsorSignature = "";
  let idleIdentitySignature = "";

  function kioskNow() {
    try {
      return typeof currentKiosk === "function" ? currentKiosk() : null;
    } catch {
      return null;
    }
  }

  function resolveAssetUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      return new URL(raw, window.location.href).toString();
    } catch {
      return raw;
    }
  }

  function fallbackClubLogo(club) {
    const name = String(club?.name || "").toLowerCase();
    if (name.includes("blindleia")) {
      return resolveAssetUrl("../static/club-logos/blindleia-dartklubb-logo.svg");
    }
    return "";
  }

  function preferredClubLogo(club) {
    return resolveAssetUrl(club?.logo_url) || fallbackClubLogo(club);
  }

  function setImageStable(image, url, fallbackUrl = "") {
    if (!image) return;
    const resolved = resolveAssetUrl(url);
    const fallback = resolveAssetUrl(fallbackUrl);
    const current = image.dataset.loadedSrc || "";

    if (!resolved) {
      image.removeAttribute("src");
      image.dataset.loadedSrc = "";
      image.classList.add("hidden");
      return;
    }

    if (current === resolved && image.getAttribute("src")) {
      image.classList.remove("hidden");
      return;
    }

    image.onload = () => {
      image.dataset.loadedSrc = image.src;
      image.classList.remove("hidden");
    };
    image.onerror = () => {
      if (fallback && image.src !== fallback) {
        image.dataset.loadedSrc = "";
        image.src = fallback;
        return;
      }
      image.classList.add("hidden");
    };
    image.src = resolved;
  }

  function ensureIdleIdentity() {
    const hero = document.querySelector("#idleState .board-hero");
    if (!hero) return null;

    let clubLogo = document.getElementById("idleClubLogo");
    if (!clubLogo) {
      const wrap = document.createElement("div");
      wrap.className = "idle-club-logo-wrap";
      wrap.innerHTML = '<img id="idleClubLogo" class="idle-club-logo hidden" alt="Klubblogo">';
      const clubName = document.getElementById("idleClub");
      hero.insertBefore(wrap, clubName || hero.firstChild);
      clubLogo = document.getElementById("idleClubLogo");
    }

    let sponsor = document.getElementById("idleSponsorShowcase");
    if (!sponsor) {
      sponsor = document.createElement("section");
      sponsor.id = "idleSponsorShowcase";
      sponsor.className = "idle-sponsor-showcase hidden";
      sponsor.setAttribute("aria-label", "Skivesponsor");
      sponsor.innerHTML = `
        <img id="idleSponsorLogo" class="idle-sponsor-logo hidden" alt="Sponsorlogo">
        <div class="idle-sponsor-copy">
          <span>Presentert av</span>
          <strong id="idleSponsorLabel"></strong>
        </div>`;
      const mode = document.getElementById("idleMode");
      if (mode?.nextSibling) hero.insertBefore(sponsor, mode.nextSibling);
      else hero.appendChild(sponsor);
    }

    return { clubLogo, sponsor };
  }

  function renderIdleIdentity() {
    const kiosk = kioskNow();
    if (!kiosk) return;
    const nodes = ensureIdleIdentity();
    if (!nodes) return;

    const club = kiosk.club || {};
    const clubLogo = preferredClubLogo(club);
    const sponsorLabel = String(kiosk.sponsor_label || "").trim();
    const sponsorLogo = resolveAssetUrl(kiosk.sponsor_logo_url);
    const signature = JSON.stringify([club?.name || "", clubLogo, sponsorLabel, sponsorLogo]);
    if (signature === idleIdentitySignature) return;
    idleIdentitySignature = signature;

    setImageStable(nodes.clubLogo, clubLogo, fallbackClubLogo(club));

    const sponsor = nodes.sponsor;
    const labelNode = document.getElementById("idleSponsorLabel");
    const logoNode = document.getElementById("idleSponsorLogo");
    if (!sponsorLabel && !sponsorLogo) {
      sponsor.classList.add("hidden");
      return;
    }

    if (labelNode) labelNode.textContent = sponsorLabel || "Sponsor";
    setImageStable(logoNode, sponsorLogo);
    sponsor.classList.remove("hidden");
  }

  function renderTopSponsorStable() {
    if (typeof ensureSponsorBadge !== "function") return;
    const badge = ensureSponsorBadge();
    if (!badge) return;
    const kiosk = kioskNow();
    const label = String(kiosk?.sponsor_label || "").trim();
    const logoUrl = resolveAssetUrl(kiosk?.sponsor_logo_url);
    const signature = JSON.stringify([label, logoUrl]);
    if (signature === topSponsorSignature) return;
    topSponsorSignature = signature;

    const logo = document.getElementById("boardSponsorLogo");
    const labelNode = document.getElementById("boardSponsorLabel");
    if (!label && !logoUrl) {
      badge.classList.add("hidden");
      return;
    }

    if (labelNode) labelNode.textContent = label || "Sponsor";
    setImageStable(logo, logoUrl);
    badge.classList.remove("hidden");
  }

  function strengthenTopClubLogo() {
    const kiosk = kioskNow();
    if (!kiosk || !el?.brandLogo) return;
    const club = kiosk.club || {};
    const preferred = preferredClubLogo(club);
    if (!preferred) return;
    setImageStable(el.brandLogo, preferred, fallbackClubLogo(club));
    el.brandFallback?.classList.add("hidden");
  }

  function replaceText(node, replacer) {
    if (!node) return;
    const current = String(node.textContent || "");
    const next = replacer(current);
    if (next !== current) node.textContent = next;
  }

  function localizeSkiveTerms() {
    document.title = "Blindleia Darts · Skiveterminal";
    const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (appleTitle && appleTitle.content !== "Blindleia Skive") appleTitle.content = "Blindleia Skive";

    replaceText(document.getElementById("brandTitle"), (text) => text === "Board Terminal" ? "Skiveterminal" : text.replace(/^Board\s+(\d+)/, "Skive $1"));
    replaceText(document.getElementById("connectionText"), (text) => text.replace(/^Board\s+(\d+)/, "Skive $1"));
    replaceText(document.getElementById("pairingMessage"), (text) => text.replace("velger board", "velger skive"));
    replaceText(document.getElementById("idleBoard"), (text) => text.replace(/^Board\s+/, "Skive "));
    replaceText(document.getElementById("idleMessage"), (text) => text.replace("dette boardet", "denne skiva"));
    replaceText(document.getElementById("assignedBoard"), (text) => text.replace(/^Board\s+/, "Skive "));
    replaceText(document.getElementById("matchBoard"), (text) => text.replace(/^Board(?:\s+|$)/, "Skive ").trim());

    const setupIntro = document.querySelector("#setupState .setup-copy > .muted");
    replaceText(setupIntro, (text) => text.replace("velg board", "velg skive"));
    document.querySelectorAll("#setupState .claim-steps p").forEach((node) => {
      replaceText(node, (text) => text.replace("Velg riktig board", "Velg riktig skive"));
    });
    const settingsEyebrow = document.querySelector("#settingsDialog .dialog-head .eyebrow");
    replaceText(settingsEyebrow, (text) => text === "Board Terminal" ? "Skiveterminal" : text);
    const scoliaCopy = document.querySelector("#scoliaScoring .muted");
    replaceText(scoliaCopy, (text) => text.replace("Board Terminal følger kampen", "Skiveterminalen følger kampen"));

    const operationStatus = document.querySelector("#idleState .post-match-status, #idleState [data-operations-status]");
    replaceText(operationStatus, (text) => text.replace(/^Boardet/, "Skiva").replace(/boardet/g, "skiva"));

    document.querySelectorAll(".test-mode-panel option").forEach((node) => {
      replaceText(node, (text) => text.replace(" · Board ", " · Skive "));
    });
    document.querySelectorAll(".test-mode-panel button").forEach((node) => {
      replaceText(node, (text) => text.replace("Bruk valgt board", "Bruk valgt skive"));
    });
    document.querySelectorAll(".test-mode-panel small").forEach((node) => {
      replaceText(node, (text) => text
        .replace(/boardregisteret/g, "skiveregisteret")
        .replace(/fysiske boards/g, "fysiske skiver")
        .replace(/fysisk board/g, "fysisk skive")
        .replace(/boardet/g, "skiva"));
    });
  }

  if (typeof renderBoardSponsor === "function") {
    renderBoardSponsor = renderTopSponsorStable;
  }

  if (typeof applyBranding === "function") {
    const previousApplyBranding = applyBranding;
    applyBranding = function applyBrandingV3() {
      previousApplyBranding();
      strengthenTopClubLogo();
      renderTopSponsorStable();
      renderIdleIdentity();
      localizeSkiveTerms();
    };
  }

  if (typeof render === "function") {
    const previousRender = render;
    render = function renderBrandV3() {
      const signature = state?.snapshot ? JSON.stringify(state.snapshot) : `setup:${state?.kioskCode || ""}:${state?.pairingRequestCode || ""}`;
      const mustRender = !state?.renderedView || signature !== stableSnapshotSignature;
      if (mustRender) {
        stableSnapshotSignature = signature;
        previousRender();
      } else {
        strengthenTopClubLogo();
        renderTopSponsorStable();
        if (state?.renderedView === "idle") renderIdleIdentity();
      }
      localizeSkiveTerms();
    };
  }

  const languageObserver = new MutationObserver(() => localizeSkiveTerms());
  languageObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

  document.body.classList.add("kiosk-brand-v3");
  document.body.dataset.kioskBrand = BRAND_VERSION;
  strengthenTopClubLogo();
  renderTopSponsorStable();
  renderIdleIdentity();
  localizeSkiveTerms();
})();
