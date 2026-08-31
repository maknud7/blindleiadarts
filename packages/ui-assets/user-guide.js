const SURFACE = document.body.dataset.bdSurface === "admin" || document.body.dataset.portalDefault === "overview" ? "admin" : "player";
const GUIDE_VERSION = "31.08.2026";

const GUIDES = Object.freeze({
  player: {
    eyebrow: "Spillerguide",
    title: "Slik bruker du Blindleia Darts",
    intro: "En kort guide til konto, turneringer, kampdetaljer, statistikk og medlemskap.",
    sections: [
      ["Kom i gang", [
        "Bruk aktiveringslenken du får fra klubben for å knytte innloggingen til riktig spillerprofil.",
        "Logg inn under Min profil. Kampene, ELO-en og statistikken følger spillerprofilen din – ikke en ny, separat bruker.",
        "På Hjem får du først det som krever handling, for eksempel påmelding, innsjekk eller medlemsbetaling.",
      ]],
      ["Turneringer", [
        "Kommende viser turneringer du kan forholde deg til nå. Tidligere er historikken med resultater.",
        "Meld deg på fra turneringen. Innsjekk blir tilgjengelig når innsjekkvinduet åpner. Bare spillere som er sjekket inn når turneringen startes blir med videre.",
        "I en pågående eller ferdig turnering kan du bruke Oversikt, Deltakere, Grupper og Kamper for å følge hele turneringen.",
      ]],
      ["Grupper og kamper", [
        "Grupper viser tabellen, hvem som går videre og kampene i valgt gruppe.",
        "Trykk på en kamp for det felles kampkortet. Det viser ELO, 3DA, First 9, vinnende checkout, 100+, 140+, 180, legs og registrerte kast når data finnes.",
        "Trykk på et spillernavn for å gå til spillerprofilen. Samme spillerlenke og samme kampkort skal brukes på tvers av plattformen.",
      ]],
      ["Statistikk", [
        "Sesong gir totalbildet. Turnering viser tabell og resultater for én turnering. Spillere åpner spillerprofilene, og Mine kamper viser din egen historikk.",
        "ELO- og statistikklister viser bare spillere som faktisk har spilt minst én kamp. Nye spillere ligger derfor ikke i ranking med en kunstig startplassering.",
        "3-dart average vises på nivåene der vi har nok kampdata til å beregne det.",
      ]],
      ["Medlemskap og betaling", [
        "Min profil viser medlemsstatus og betalingsinformasjon når det er relevant.",
        "Fast månedlig betaling går via Stripe. Vipps brukes til enkeltbetaling når klubben tilbyr det.",
        "Manglende betaling varsles før eventuell sperre for ny påmelding slår inn.",
      ]],
      ["Under dartkvelden", [
        "Live-skjermen i lokalet viser aktive skiver, neste kamper, tabeller, sluttspill og relevante høydepunkter.",
        "Hvis spillerpause er tilgjengelig for deg under en aktiv turnering, finner du den på Hjem.",
        "Hvis noe ser feil ut i kamp- eller spillerdata, gi turneringsleder beskjed før historikken brukes videre i statistikken.",
      ]],
    ],
  },
  admin: {
    eyebrow: "Adminguide",
    title: "Slik drifter du Blindleia Darts",
    intro: "Arbeidsflyten for medlemmer, turneringer, skiver, Live og kontroll av data.",
    sections: [
      ["Klubboversikt", [
        "Oversikten er startpunktet for klubbdriften. Bruk helsesjekken når noe ser feil ut i data, identiteter eller portal.",
        "Du ser bare funksjonene rollen din har tilgang til. Superadmin-funksjoner holdes adskilt fra vanlig klubbadmin.",
      ]],
      ["Medlemmer og aktivering", [
        "Opprett eller finn riktig medlem/spiller før du sender aktiveringslenke. Målet er én canonical spilleridentitet per person.",
        "Aktiveringslenken knytter brukerinnloggingen til eksisterende spillerhistorikk, ELO og statistikk.",
        "Rydd identitetskonflikter i stedet for å opprette parallelle spillere med samme person.",
      ]],
      ["Opprett turnering", [
        "Sett starttid, påmeldingsoppsett, tidspunkt for når innsjekk åpner og kampformat før turneringen starter.",
        "Velg startscore, gruppeoppsett, Best av og sluttspillregler i formatdelen. Lagre formatet før start.",
        "Turneringsdata i Blindleia Darts er canonical. Eksterne kilder skal ikke være runtime-fasit.",
      ]],
      ["Innsjekk og start", [
        "Admin kan ikke sjekke inn en spiller før innsjekkvinduet er åpnet. Samme regel håndheves i backend og UI.",
        "En innsjekket spiller kan sjekkes ut igjen før turneringen starter.",
        "Når du starter turneringen, er det de sjekket inn spillerne som tas med. Registrerte spillere som ikke møtte skal ikke snike seg inn i trekningen.",
      ]],
      ["Turneringsdrift", [
        "Bruk den vanlige turneringsvisningen som hovedflate også som admin der adminfanen er tilgjengelig.",
        "Følg grupper, kampkø, skiver og resultater. Ved mer avansert drift kan egne adminverktøy fortsatt være tilgjengelige der funksjonen ikke er flyttet inn ennå.",
        "Kampdetaljer skal bruke det samme canonical kampkortet som spillerportalen.",
      ]],
      ["Skiver, nettbrett og Scolia", [
        "Skiva er den faste enheten. Opprett skivenummeret én gang og velg manuell eller Scolia-scoring på skiva.",
        "Nettbrett pares separat til riktig skive. Bytt eller nullstill paring når en terminal erstattes.",
        "Scolia er en scorekilde/integrasjon; Blindleia Darts beholder egne kamp-, spiller- og resultat-ID-er som canonical.",
      ]],
      ["Live, ELO og statistikk", [
        "Live-skjermen skal vise det som er relevant for dartkvelden: aktive kamper, kø, tabeller, sluttspill, ELO og høydepunkter.",
        "Ranking- og statistikklister skal bare inneholde spillere som har spilt minst én kamp. Operative lister som påmelding og innsjekk er unntaket.",
        "ELO-innstilling for en turnering bør avklares før kampene spilles; historiske resultater skal ikke få nye regler i etterkant uten en bevisst migrering.",
      ]],
      ["Ferdigstilling og kontroll", [
        "Kontroller resultater, tabeller og sluttspill før turneringen ferdigstilles og brukes som historikk.",
        "Ved migrert historikk skal format og metadata rekonstrueres fra faktiske data – ikke fylles med tilfeldige standardverdier.",
        "Hvis du oppdager feil i spilleridentitet, kampresultat eller kastdata, rett canonical data slik at alle flater får samme fasit.",
      ]],
    ],
  },
});

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function ensureStyles() {
  if (document.getElementById("bdUserGuideStyles")) return;
  const style = document.createElement("style");
  style.id = "bdUserGuideStyles";
  style.textContent = `
    .bd-guide-open{appearance:none;-webkit-appearance:none;width:100%;display:flex;align-items:center;gap:9px;padding:11px 12px;border:0;border-radius:10px;background:transparent;color:inherit;font:inherit;font-weight:760;text-align:left;cursor:pointer}
    .bd-guide-open::before{content:"?";display:grid;place-items:center;width:22px;height:22px;flex:0 0 22px;border:1px solid currentColor;border-radius:50%;font-size:13px;font-weight:900;opacity:.7}
    .bd-guide-open:hover,.bd-guide-open:focus-visible{background:rgba(47,111,237,.09);outline:none}
    .bd-user-guide{width:min(820px,calc(100vw - 24px));max-height:min(88dvh,920px);padding:0;border:0;border-radius:22px;background:#f4f7fa;color:#0b2b50;box-shadow:0 28px 90px rgba(8,29,54,.38);overflow:hidden}
    .bd-user-guide::backdrop{background:rgba(7,25,47,.58);backdrop-filter:blur(2px)}
    .bd-guide-shell{max-height:min(88dvh,920px);overflow:auto;padding:22px}
    .bd-guide-head{position:sticky;top:-22px;z-index:2;display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin:-22px -22px 18px;padding:22px;background:rgba(244,247,250,.96);border-bottom:1px solid #dbe5ef;backdrop-filter:blur(16px)}
    .bd-guide-head p{margin:0}.bd-guide-eyebrow{text-transform:uppercase;letter-spacing:.11em;font-size:12px;font-weight:900;color:#2f6fed}.bd-guide-head h2{margin:4px 0 5px;font-size:clamp(24px,4vw,34px);line-height:1.05}.bd-guide-intro{color:#6f8296;max-width:62ch;line-height:1.45}
    .bd-guide-close{appearance:none;width:42px;height:42px;flex:0 0 42px;border:1px solid #d6e1ec;border-radius:50%;background:#fff;color:#536b83;font-size:25px;line-height:1;cursor:pointer}
    .bd-guide-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.bd-guide-card{padding:16px;border:1px solid #dbe5ef;border-radius:16px;background:#fff}.bd-guide-card h3{margin:0 0 10px;font-size:18px}.bd-guide-card ul{margin:0;padding-left:19px;display:grid;gap:8px;color:#536b83;line-height:1.45}.bd-guide-version{margin:18px 2px 0;color:#8192a4;font-size:12px}
    @media(max-width:700px){.bd-user-guide{width:100vw;max-width:100vw;height:100dvh;max-height:100dvh;border-radius:0}.bd-guide-shell{max-height:100dvh;padding:18px 14px 28px}.bd-guide-head{top:-18px;margin:-18px -14px 14px;padding:18px 14px}.bd-guide-grid{grid-template-columns:1fr}.bd-guide-open{min-height:44px}}
  `;
  document.head.appendChild(style);
}

function ensureDialog() {
  let dialog = document.querySelector("dialog.bd-user-guide");
  if (dialog) return dialog;
  const guide = GUIDES[SURFACE];
  dialog = document.createElement("dialog");
  dialog.className = "bd-user-guide";
  dialog.innerHTML = `<div class="bd-guide-shell">
    <header class="bd-guide-head"><div><p class="bd-guide-eyebrow">${esc(guide.eyebrow)}</p><h2>${esc(guide.title)}</h2><p class="bd-guide-intro">${esc(guide.intro)}</p></div><button type="button" class="bd-guide-close" aria-label="Lukk brukerguide">×</button></header>
    <div class="bd-guide-grid">${guide.sections.map(([title, items]) => `<section class="bd-guide-card"><h3>${esc(title)}</h3><ul>${items.map(item => `<li>${esc(item)}</li>`).join("")}</ul></section>`).join("")}</div>
    <p class="bd-guide-version">Guide sist gjennomgått ${esc(GUIDE_VERSION)}.</p>
  </div>`;
  document.body.appendChild(dialog);
  dialog.querySelector(".bd-guide-close")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
  return dialog;
}

function openGuide() {
  const dialog = ensureDialog();
  if (!dialog.open) dialog.showModal();
}

function ensureMenuButton() {
  const nav = document.querySelector(".portal-menu");
  if (!nav || nav.querySelector(".bd-guide-open")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "bd-guide-open";
  button.textContent = "Hjelp og brukerguide";
  button.addEventListener("click", openGuide);
  const account = nav.querySelector(".unified-sidebar-account");
  if (account) nav.insertBefore(button, account);
  else nav.appendChild(button);
}

function initialize() {
  ensureStyles();
  ensureDialog();
  ensureMenuButton();
  const nav = document.querySelector(".portal-menu");
  if (!nav) return;
  const observer = new MutationObserver(() => ensureMenuButton());
  observer.observe(nav, { childList: true });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
else initialize();

window.BlindleiaUserGuide = Object.freeze({ open: openGuide, surface: SURFACE, version: GUIDE_VERSION });
