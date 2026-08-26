(() => {
  const BRAND_VERSION = "3.1";
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
      sponsor.setAttribute("aria-label", "Board sponsor");
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
    };
  }

  document.body.classList.add("kiosk-brand-v3");
  document.body.dataset.kioskBrand = BRAND_VERSION;
  strengthenTopClubLogo();
  renderTopSponsorStable();
  renderIdleIdentity();
})();
