const isTestEnvironment = document.documentElement.dataset.appEnv === "test"
  || document.body?.dataset.appEnv === "test"
  || /(^|[.-])test([.-]|$)/i.test(window.location.hostname)
  || /\/test(?:\/|$)/i.test(window.location.pathname);

if (isTestEnvironment) {
  const readonlyMessage = "Fysiske skiver administreres kun i PROD. TEST viser samme skiver, men kan bare bruke dem til test-runtime og pairing.";

  function ensureStyles() {
    if (document.getElementById("testHardwareReadonlyStyles")) return;
    const style = document.createElement("style");
    style.id = "testHardwareReadonlyStyles";
    style.textContent = `
      #kiosks.test-hardware-readonly #kioskForm,
      #kiosks.test-hardware-readonly #newBoardButton,
      #kiosks.test-hardware-readonly #boardCreateReveal,
      #kiosks.test-hardware-readonly .board-edit-button,
      #kiosks.test-hardware-readonly .equipment-delete-button[data-kind='board'] {
        display: none !important;
      }
      #kiosks.test-hardware-readonly .kiosk-layout {
        grid-template-columns: minmax(0, 1fr) !important;
      }
      #kiosks.test-hardware-readonly .scoring-mode:disabled {
        opacity: 1;
        cursor: default;
      }
    `;
    document.head.appendChild(style);
  }

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

  function lockMasterControls() {
    const section = document.getElementById("kiosks");
    if (section && !section.classList.contains("test-hardware-readonly")) {
      section.classList.add("test-hardware-readonly");
    }

    document.querySelectorAll("#kioskList .scoring-mode").forEach((select) => {
      if (!select.disabled) select.disabled = true;
    });

    const generalForm = document.getElementById("scoliaGeneralForm");
    const advancedForm = document.getElementById("scoliaAdvancedForm");
    [generalForm, advancedForm].forEach((form) => {
      if (!form) return;
      form.querySelectorAll("input, select, textarea, button[type='submit']").forEach((control) => {
        if (!control.disabled) control.disabled = true;
      });
    });

    const prodBanner = document.querySelector("#scoliaEquipmentPanel .prod-scope-banner p");
    if (prodBanner && prodBanner.dataset.testReadonlyApplied !== "1") {
      prodBanner.dataset.testReadonlyApplied = "1";
      prodBanner.innerHTML = `<strong>Canonical PROD-konfigurasjon · kun lesing i TEST.</strong><br><span class="muted">${readonlyMessage}</span>`;
    }
  }

  function applyReadonlyUi() {
    ensureStyles();
    ensureNotice();
    lockMasterControls();
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

  let applyScheduled = false;
  function scheduleApply() {
    if (applyScheduled) return;
    applyScheduled = true;
    window.requestAnimationFrame(() => {
      applyScheduled = false;
      applyReadonlyUi();
    });
  }

  const observer = new MutationObserver(scheduleApply);
  observer.observe(document.body, { childList: true, subtree: true });
  applyReadonlyUi();
}