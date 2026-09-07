const kioskSection = document.getElementById("kiosks");
const kioskList = document.getElementById("kioskList");
const boardSelect = document.getElementById("claimKioskBoard");
const codeInput = document.getElementById("claimKioskCode");

const pairingFromQr = Boolean(
  String(new URLSearchParams(window.location.search).get("pairing") || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
);

function setText(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

function ensureStyles() {
  if (document.getElementById("terminalPairingUxStyles")) return;
  const style = document.createElement("style");
  style.id = "terminalPairingUxStyles";
  style.textContent = `
    #kioskList .terminal-internal-code{display:none!important}
    #kioskList .terminal-quick-action{white-space:nowrap}
    #kioskList .terminal-quick-action.hidden{display:none!important}
    #kioskList .reset-pairing{font-size:12px;opacity:.82}
    #kioskList .board-controls{align-items:center}
    .pairing-from-qr .terminal-qr-note{display:block}
    .terminal-qr-note{display:none;margin:0 0 10px;padding:10px 12px;border:1px solid rgba(77,212,166,.35);border-radius:10px;background:rgba(77,212,166,.08);font-size:13px;line-height:1.45}
    @media(max-width:700px){#kioskList .terminal-quick-action{width:100%}}
  `;
  document.head.appendChild(style);
}

function replaceTechnicalPairingWords(root) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const before = node.nodeValue || "";
    const after = before
      .replace(/Pairingkoden/g, "Tilkoblingskoden")
      .replace(/pairingkoden/g, "tilkoblingskoden")
      .replace(/Pairingkode/g, "Tilkoblingskode")
      .replace(/pairingkode/g, "tilkoblingskode")
      .replace(/QR-pairing/g, "QR-kode")
      .replace(/Pairing påvirker/g, "Tilkoblingen påvirker")
      .replace(/pairing påvirker/g, "tilkoblingen påvirker");
    if (after !== before) node.nodeValue = after;
  }
}

function decoratePairingFlow() {
  setText(document.getElementById("pairTabletButton"), "Koble terminal");

  const reveal = document.getElementById("pairingReveal");
  if (reveal) {
    setText(reveal.querySelector(".equipment-reveal-head h3"), "Koble ny terminal");
    setText(
      reveal.querySelector(".equipment-reveal-head .muted"),
      pairingFromQr
        ? "Terminalen er gjenkjent fra QR-koden. Velg skiva den står ved og koble."
        : "Scan QR-koden fra Blindleia Kiosk, eller skriv tilkoblingskoden som vises på nettbrettet."
    );
  }

  const intro = kioskSection?.querySelector(".equipment-pairing-intro");
  if (intro) {
    setText(intro.querySelector(".eyebrow"), "Terminal");
    setText(intro.querySelector("h3"), "Koble terminal til en skive");
    setText(
      intro.querySelector(".muted"),
      pairingFromQr
        ? "Terminalen er allerede funnet. Velg skiva den står ved."
        : "Åpne Blindleia Kiosk på nettbrettet. Scan QR-koden med adminmobilen, eller skriv tilkoblingskoden under."
    );
  }

  setText(codeInput?.closest("label")?.querySelector("span"), "Tilkoblingskode");
  setText(document.querySelector('#claimAdminFlow [data-claim-step="1"] p'), "Finn terminalen");
  setText(document.querySelector("#claimDevicePreview div > span"), "Terminal funnet");

  const card = document.querySelector("#claimKioskForm")?.closest(".claim-admin-card");
  if (card && pairingFromQr && !card.querySelector(".terminal-qr-note")) {
    const note = document.createElement("div");
    note.className = "terminal-qr-note";
    note.textContent = "QR-koden er lest. Du trenger ikke skrive noen kode – velg bare riktig skive under.";
    document.getElementById("claimDevicePreview")?.insertAdjacentElement("beforebegin", note);
  }

  replaceTechnicalPairingWords(card);
}

function pairedRow(row) {
  return Boolean(row.querySelector(".reset-pairing"));
}

function boardId(row) {
  const source = row.querySelector("[data-kiosk-id]");
  return Number(row.dataset.kioskId || source?.dataset.kioskId || 0);
}

function openPairingForBoard(id) {
  const reveal = document.getElementById("pairingReveal");
  ["boardCreateReveal", "screenCreateReveal"].forEach((revealId) => document.getElementById(revealId)?.classList.add("hidden"));
  reveal?.classList.remove("hidden");
  if (boardSelect && id) {
    boardSelect.value = String(id);
    boardSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }
  reveal?.scrollIntoView({ behavior: "smooth", block: "start" });
  window.setTimeout(() => codeInput?.focus(), 120);
}

function waitForReplacementPanel(timeoutMs = 3500) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const backdrop = document.getElementById("boardEditorBackdrop");
      const actions = document.getElementById("boardTabletActions");
      const button = document.getElementById("replaceTabletButton");
      if (backdrop && !backdrop.classList.contains("hidden") && actions && !actions.classList.contains("hidden") && button) {
        resolve(button);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(null);
        return;
      }
      window.setTimeout(check, 60);
    };
    check();
  });
}

async function openReplacementForRow(row) {
  const edit = row.querySelector(".board-edit-button");
  if (!edit) return;
  edit.click();
  const replace = await waitForReplacementPanel();
  replace?.click();
}

function decorateBoardRows() {
  kioskList?.querySelectorAll(".board-row").forEach((row) => {
    const id = boardId(row);
    if (!id) return;
    const paired = pairedRow(row);
    const testHardwareReadonly = kioskSection?.classList.contains("test-hardware-readonly") === true;
    const meta = row.querySelector(".board-main .row-meta");
    const metaSpans = [...(meta?.querySelectorAll(":scope > span") || [])];

    if (metaSpans[0]) metaSpans[0].classList.add("terminal-internal-code");
    if (metaSpans[1]) {
      const raw = metaSpans[1].textContent || "";
      const wanted = paired ? raw.replace(/^Paret:\s*/i, "Terminal: ") : "Ingen terminal koblet til";
      setText(metaSpans[1], wanted);
    }

    const statusBadge = [...row.querySelectorAll(".board-controls .badge")]
      .find((badge) => ["paret", "ledig", "tilkoblet", "ingen terminal"].includes(String(badge.textContent || "").trim().toLowerCase()));
    setText(statusBadge, paired ? "Tilkoblet" : "Ingen terminal");

    const reset = row.querySelector(".reset-pairing");
    if (reset) {
      setText(reset, "Koble fra");
      if (reset.title !== "Koble fra dette nettbrettet. Skiva og historikken beholdes.") {
        reset.title = "Koble fra dette nettbrettet. Skiva og historikken beholdes.";
      }
    }

    const edit = row.querySelector(".board-edit-button");
    setText(edit, "Detaljer");

    const controls = row.querySelector(".board-controls") || row;
    let quick = row.querySelector(".terminal-quick-action");
    if (!quick) {
      quick = document.createElement("button");
      quick.type = "button";
      quick.className = "button secondary terminal-quick-action";
      controls.insertBefore(quick, edit || reset || null);
    }
    setText(quick, paired ? "Bytt nettbrett" : "Koble terminal");
    quick.classList.toggle("hidden", paired && testHardwareReadonly);
    quick.onclick = () => {
      if (paired) openReplacementForRow(row).catch(() => undefined);
      else openPairingForBoard(id);
    };
  });
}

function decorateBoardEditor() {
  const device = document.getElementById("boardEditorDevice");
  if (device && !device.classList.contains("test-terminal")) {
    const label = device.querySelector(":scope > span.muted");
    const strong = device.querySelector(":scope > strong");
    const small = device.querySelector(":scope > small");
    if (strong?.textContent?.trim() === "Ikke paret" || strong?.textContent?.trim() === "Ingen terminal") {
      setText(label, "Terminal");
      setText(strong, "Ingen terminal");
      setText(small, "Åpne Blindleia Kiosk på nytt nettbrett og bruk QR-koden eller tilkoblingskoden.");
    } else if (strong) {
      setText(label, "Terminal");
      const current = small?.textContent || "";
      setText(small, current.replace(/^Paret\s/i, "Tilkoblet "));
    }
  }

  const tabletActions = document.getElementById("boardTabletActions");
  setText(tabletActions?.querySelector("small"), "Nettbrettet er utskiftbart. Skive, Scolia-oppsett, kamp og historikk blir stående.");

  const replacement = document.getElementById("tabletReplacementPanel");
  replaceTechnicalPairingWords(replacement);
}

function decorateDynamicCopy() {
  decoratePairingFlow();
  decorateBoardRows();
  decorateBoardEditor();
  replaceTechnicalPairingWords(document.getElementById("claimKioskStatus"));
  replaceTechnicalPairingWords(document.getElementById("tabletReplacementStatus"));
}

function boot() {
  ensureStyles();
  decorateDynamicCopy();

  const observer = new MutationObserver(() => window.queueMicrotask(decorateDynamicCopy));
  if (kioskSection) {
    observer.observe(kioskSection, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  const editorRoot = document.getElementById("boardEditorBackdrop");
  if (editorRoot) {
    const editorObserver = new MutationObserver(() => window.queueMicrotask(decorateBoardEditor));
    editorObserver.observe(editorRoot, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"] });
  }
}

boot();
