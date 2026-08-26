(() => {
  const TEST_MODE_API = "../api/kiosk-test-mode.php";
  const TEST_MODE_KEY = "bd:kioskTestMode";
  const PRE_TEST_CODE_KEY = "bd:kioskPreTestCode";
  const TEST_BOARD_ID_KEY = "bd:kioskTestPhysicalBoardId";
  const TEST_BOARD_LABEL_KEY = "bd:kioskTestBoardLabel";

  async function jsonRequest(url, options = {}) {
    const response = await fetch(url, { cache: "no-store", ...options });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  }

  function ensureTestToken() {
    let token = localStorage.getItem("bd:kioskPairingToken") || "";
    if (!token) {
      token = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem("bd:kioskPairingToken", token);
    }
    return token;
  }

  function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  function active() {
    return localStorage.getItem(TEST_MODE_KEY) === "1";
  }

  function selected() {
    return active() && Boolean(localStorage.getItem(TEST_BOARD_ID_KEY)) && Boolean(localStorage.getItem("bd:kioskCode"));
  }

  function setActive(value) {
    if (value) localStorage.setItem(TEST_MODE_KEY, "1");
    else localStorage.removeItem(TEST_MODE_KEY);
  }

  function rememberNormalTerminal() {
    if (active()) return;
    const code = localStorage.getItem("bd:kioskCode") || "";
    if (code) localStorage.setItem(PRE_TEST_CODE_KEY, code);
    else localStorage.removeItem(PRE_TEST_CODE_KEY);
  }

  function clearTestSelection() {
    localStorage.removeItem(TEST_BOARD_ID_KEY);
    localStorage.removeItem(TEST_BOARD_LABEL_KEY);
  }

  function restoreNormalTerminal() {
    const code = localStorage.getItem(PRE_TEST_CODE_KEY) || "";
    if (code) localStorage.setItem("bd:kioskCode", code);
    else localStorage.removeItem("bd:kioskCode");
    localStorage.removeItem(PRE_TEST_CODE_KEY);
    clearTestSelection();
  }

  function styles() {
    if (document.getElementById("kioskTestModeStyles")) return;
    const style = document.createElement("style");
    style.id = "kioskTestModeStyles";
    style.textContent = `
      .test-mode-panel{margin:14px 18px 0;padding:12px 14px;border:2px solid rgba(245,197,66,.82);border-radius:14px;background:rgba(245,197,66,.13);display:grid;gap:8px;box-shadow:0 8px 24px rgba(133,93,0,.08)}
      .test-mode-panel strong{color:var(--text)}
      .test-mode-panel small{line-height:1.4}
      .test-mode-panel select{width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(181,132,0,.3);background:#fffdf5;color:var(--text)}
      .test-mode-row{display:flex;gap:8px;align-items:center}
      .test-mode-row select{flex:1}
      .test-mode-badge{font-size:12px;text-transform:uppercase;letter-spacing:.11em;font-weight:900;color:#9b6a00}
      .test-mode-row .ghost-button{border-color:#d9a918;background:#f5c542;color:#332500;font-weight:900}
      .test-mode-settings-card{margin-top:12px;padding:13px 14px;border:1px solid rgba(181,132,0,.34);border-radius:13px;background:rgba(245,197,66,.08);display:grid;gap:10px}
      .test-mode-settings-card strong{display:block;color:var(--text)}
      .test-mode-settings-card small{line-height:1.4}
      .test-mode-settings-card.active{border-color:rgba(181,132,0,.58);background:rgba(245,197,66,.18);box-shadow:inset 4px 0 0 #f5c542}
      .test-mode-settings-actions{display:flex;gap:8px;flex-wrap:wrap}
      .test-mode-settings-button{border-color:#d9a918!important;background:#f5c542!important;color:#332500!important;font-weight:900!important}
      .test-mode-change-button{border-color:rgba(181,132,0,.45)!important;color:#7a5600!important;background:#fffaf0!important;font-weight:800!important}
      body.kiosk-test-mode.test-mode-ready .terminal-shell{outline:2px solid rgba(245,197,66,.58);outline-offset:-2px}
      body.kiosk-test-mode.test-mode-ready .terminal-topbar{box-shadow:inset 0 5px 0 #f5c542,0 8px 24px rgba(9,44,69,.16)}
      body.kiosk-test-mode #settingsButton{border-color:rgba(245,197,66,.9);box-shadow:0 0 0 2px rgba(245,197,66,.16)}
      body.kiosk-test-mode::before{content:"TEST";position:fixed;left:10px;bottom:10px;z-index:9999;padding:5px 9px;border-radius:8px;background:#f5c542;color:#332500;font:900 12px/1 system-ui;letter-spacing:.12em;pointer-events:none;box-shadow:0 4px 14px rgba(116,79,0,.18)}
      @media(max-width:650px){.test-mode-row{display:grid}.test-mode-panel{margin:10px 10px 0}.test-mode-settings-actions{display:grid}}
    `;
    document.head.appendChild(style);
  }

  function reloadWithoutShortcut() {
    const url = new URL(window.location.href);
    url.searchParams.delete("testmode");
    window.location.replace(url.toString());
  }

  async function leaveTestMode(button = null) {
    if (button) button.disabled = true;
    const code = localStorage.getItem("bd:kioskCode") || "";
    const previousCode = localStorage.getItem(PRE_TEST_CODE_KEY) || "";
    const token = localStorage.getItem("bd:kioskPairingToken") || "";
    if (code && token && code !== previousCode) {
      try {
        await fetch(`../api/v1/kiosks/${encodeURIComponent(code)}/unpair`, {
          method: "POST",
          headers: { "X-Kiosk-Pairing-Token": token },
          cache: "no-store",
        });
      } catch {
        // Leaving test mode must still work if the isolated runtime is unavailable.
      }
    }
    setActive(false);
    restoreNormalTerminal();
    reloadWithoutShortcut();
  }

  function chooseAnotherTestBoard() {
    clearTestSelection();
    document.body.classList.remove("test-mode-ready");
    reloadWithoutShortcut();
  }

  function ensureAdminTestControl() {
    if (document.body?.dataset?.appEnv !== "test") return;
    const meta = document.getElementById("settingsMeta");
    if (!meta) return;

    let card = document.getElementById("kioskTestModeSettings");
    if (!card) {
      card = document.createElement("section");
      card.id = "kioskTestModeSettings";
      card.className = "test-mode-settings-card";
      card.innerHTML = `
        <div><strong>Testmodus</strong><small class="muted" id="kioskTestModeHelp"></small></div>
        <div class="test-mode-settings-actions">
          <button id="kioskTestModeChange" type="button" class="ghost-button test-mode-change-button hidden" data-kiosk-admin-control>Bytt testskive</button>
          <button id="kioskTestModeToggle" type="button" class="ghost-button test-mode-settings-button" data-kiosk-admin-control></button>
        </div>`;
      meta.appendChild(card);

      document.getElementById("kioskTestModeToggle")?.addEventListener("click", (event) => {
        if (active()) {
          leaveTestMode(event.currentTarget);
          return;
        }
        rememberNormalTerminal();
        clearTestSelection();
        setActive(true);
        reloadWithoutShortcut();
      });
      document.getElementById("kioskTestModeChange")?.addEventListener("click", chooseAnotherTestBoard);
    }

    const enabled = active();
    const hasSelection = selected();
    const unlocked = typeof isUnlocked === "function" ? isUnlocked() : false;
    const selectedLabel = localStorage.getItem(TEST_BOARD_LABEL_KEY) || "valgt skive";
    card.classList.toggle("active", enabled);

    const help = document.getElementById("kioskTestModeHelp");
    const toggle = document.getElementById("kioskTestModeToggle");
    const change = document.getElementById("kioskTestModeChange");
    const helpText = enabled
      ? (hasSelection
        ? `Aktiv nå på ${selectedLabel}. Kamp og scoring går mot isolert test-runtime. Gule markeringer viser at terminalen er i test.`
        : "Aktiv nå. Velg skiva du vil bruke i testfeltet på hovedskjermen.")
      : (unlocked
        ? "Bruk isolert test-runtime uten å påvirke ordinære kamp- og scoringdata."
        : "Lås opp admin-modus under for å starte testmodus.");
    const toggleText = enabled ? "Avslutt testmodus" : "Start testmodus";

    if (help && help.textContent !== helpText) help.textContent = helpText;
    if (toggle && toggle.textContent !== toggleText) toggle.textContent = toggleText;
    change?.classList.toggle("hidden", !hasSelection);
  }

  async function activateTestBoard(kioskId, source, label, button) {
    const token = ensureTestToken();
    button.disabled = true;
    try {
      const data = await jsonRequest(TEST_MODE_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Kiosk-Pairing-Token": token },
        body: JSON.stringify({ kiosk_id: Number(kioskId), source: source || "physical" }),
      });
      localStorage.setItem("bd:kioskCode", data.kiosk.code);
      localStorage.setItem(TEST_BOARD_ID_KEY, String(data.source_board?.id || data.physical_board?.id || kioskId));
      localStorage.setItem(TEST_BOARD_LABEL_KEY, label || data.kiosk.name || `Skive ${data.kiosk.board_number || ""}`);
      localStorage.removeItem("bd:kioskPairingRequestCode");
      localStorage.removeItem("bd:kioskPairingExpires");
      window.location.reload();
    } catch (error) {
      button.disabled = false;
      const old = button.textContent;
      button.textContent = error.message || "Kunne ikke velge skive";
      setTimeout(() => { button.textContent = old; }, 2600);
    }
  }

  function buildPanel(items, message = "") {
    const panel = document.createElement("div");
    panel.className = "test-mode-panel";
    const hasItems = items.length > 0;
    const options = hasItems
      ? items.map((item) => {
        const label = `${item.club_name} · Skive ${Number(item.board_number)}${item.name && item.name !== `Skive ${Number(item.board_number)}` ? ` · ${item.name}` : ""}${item.scoring_mode === "scolia" ? " · Scolia" : ""}`;
        return `<option value="${Number(item.id)}" data-source="${escapeHtml(item.source || "physical")}">${escapeHtml(label)}</option>`;
      }).join("")
      : `<option value="">Ingen skiver funnet</option>`;

    panel.innerHTML = `
      <span class="test-mode-badge">Testmodus aktiv</span>
      <strong>Velg skiva du vil teste på</strong>
      <small class="muted">${escapeHtml(message || "Testkamper og scoring lagres isolert. Når skiva er valgt forsvinner dette feltet, og kiosken ser normal ut med diskrete gule testmarkeringer.")}</small>
      <div class="test-mode-row" data-kiosk-admin-control>
        <select aria-label="Velg skive" ${hasItems ? "" : "disabled"}>${options}</select>
        <button type="button" class="ghost-button" ${hasItems ? "" : "disabled"}>Bruk valgt skive</button>
      </div>`;

    const select = panel.querySelector("select");
    const use = panel.querySelector(".test-mode-row button");
    if (hasItems) {
      use.addEventListener("click", () => {
        const option = select.options[select.selectedIndex];
        activateTestBoard(select.value, option?.dataset.source || "physical", option?.textContent || "", use);
      });
    }
    return panel;
  }

  function removePanel() {
    document.getElementById("kioskTestSelectorPersistent")?.remove();
  }

  function replacePanel(items, message = "") {
    const topbar = document.querySelector(".terminal-topbar");
    if (!topbar) return;
    const current = document.getElementById("kioskTestSelectorPersistent");
    const panel = buildPanel(items, message);
    panel.id = "kioskTestSelectorPersistent";
    if (current) current.replaceWith(panel);
    else topbar.insertAdjacentElement("afterend", panel);
  }

  async function bootTestMode() {
    if (document.body?.dataset?.appEnv !== "test") return;
    const query = new URLSearchParams(window.location.search).get("testmode");
    if (query === "1") {
      rememberNormalTerminal();
      clearTestSelection();
      setActive(true);
    }
    if (query === "0") {
      setActive(false);
      restoreNormalTerminal();
    }

    styles();
    ensureAdminTestControl();
    const observer = new MutationObserver(ensureAdminTestControl);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    document.body.classList.toggle("kiosk-test-mode", active());
    document.body.classList.toggle("test-mode-ready", selected());
    if (!active()) {
      removePanel();
      return;
    }

    if (selected()) {
      removePanel();
      ensureAdminTestControl();
      return;
    }

    replacePanel([], "Laster skiveregister …");
    try {
      const data = await jsonRequest(TEST_MODE_API);
      replacePanel(data.items || [], (data.items || []).length
        ? "Velg skiva du vil bruke. Når den er valgt forsvinner dette feltet, mens testdata fortsatt holdes isolert."
        : "Det finnes ingen aktive skiver i fysisk register eller test-admin.");
    } catch (error) {
      replacePanel([], `Kunne ikke laste skiveregister: ${error.message || "ukjent feil"}`);
      console.warn("Kiosk test mode unavailable", error);
    }
  }

  bootTestMode();
})();