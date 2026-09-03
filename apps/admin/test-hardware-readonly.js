const isTestEnvironment = document.documentElement.dataset.appEnv === "test"
  || document.body?.dataset.appEnv === "test"
  || /(^|[.-])test([.-]|$)/i.test(window.location.hostname)
  || /\/test(?:\/|$)/i.test(window.location.pathname);

if (isTestEnvironment) {
  const readonlyMessage = "Fysiske skiver administreres kun i PROD. TEST viser samme skiver, men kan bare bruke dem til test-runtime og pairing.";

  function ensureNotice() {
    const section = document.getElementById("kiosks");
    const panelHead = section?.querySelector(":scope > .panel-head");
    if (!section || !panelHead || document.getElementById("testHardwareReadonlyNotice")) return;

    const notice = document.createElement("div");
    notice.id = "testHardwareReadonlyNotice";
    notice.className = "message info";
    notice.style.margin = "0 0 16px";
    notice.innerHTML = `<strong>TEST · utstyr er skrivebeskyttet</strong><br><span>${readonlyMessage}</span>`;
    panelHead.insertAdjacentElement("afterend", notice);
  }

  function replaceScoringSelect(select) {
    const id = select.dataset.kioskId || "";
    const label = select.value === "scolia" ? "Scolia" : "Manuell";
    const badge = document.createElement("span");
    badge.className = "badge neutral board-source-badge";
    badge.textContent = label;
    if (id) badge.dataset.kioskId = id;
    select.replaceWith(badge);
  }

  function lockMasterForms() {
    const createForm = document.getElementById("kioskForm");
    if (createForm) {
      createForm.classList.add("hidden");
      createForm.setAttribute("aria-hidden", "true");
    }

    document.getElementById("newBoardButton")?.remove();
    document.getElementById("boardCreateReveal")?.classList.add("hidden");

    document.querySelectorAll("#kioskList .scoring-mode").forEach(replaceScoringSelect);
    document.querySelectorAll("#kioskList .board-edit-button, #kioskList .equipment-delete-button[data-kind='board']")
      .forEach((button) => button.remove());

    const generalForm = document.getElementById("scoliaGeneralForm");
    const advancedForm = document.getElementById("scoliaAdvancedForm");
    [generalForm, advancedForm].forEach((form) => {
      if (!form) return;
      form.querySelectorAll("input, select, textarea, button[type='submit']").forEach((control) => {
        control.disabled = true;
      });
    });

    const prodBanner = document.querySelector("#scoliaEquipmentPanel .prod-scope-banner p");
    if (prodBanner) {
      prodBanner.innerHTML = `<strong>Canonical PROD-konfigurasjon · kun lesing i TEST.</strong><br><span class="muted">${readonlyMessage}</span>`;
    }
  }

  function applyReadonlyUi() {
    ensureNotice();
    lockMasterForms();
  }

  document.addEventListener("submit", (event) => {
    if (["kioskForm", "scoliaGeneralForm", "scoliaAdvancedForm"].includes(event.target?.id || "")) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  document.addEventListener("click", (event) => {
    const target = event.target?.closest?.("#newBoardButton, .board-edit-button, .equipment-delete-button[data-kind='board']");
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  const observer = new MutationObserver(() => window.queueMicrotask(applyReadonlyUi));
  observer.observe(document.documentElement, { childList: true, subtree: true });
  applyReadonlyUi();
}