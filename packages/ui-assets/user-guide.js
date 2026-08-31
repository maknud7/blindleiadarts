const SURFACE = document.body.dataset.bdSurface === "admin" || document.body.dataset.portalDefault === "overview" ? "admin" : "player";
const GUIDE_VERSION = "31.08.2026";

const ELO_EXPLANATION = Object.freeze([
  "Alle starter på 1000 ELO i sesongen når den første tellende ELO-kampen registreres.",
  "Bare ferdige kamper i en turnering der «Denne turneringen teller på ELO» er aktivert inngår i beregningen.",
  "Systemet beregner hvor sannsynlig seier er ut fra forskjellen i ELO. En forventet seier gir derfor en liten endring, mens en overraskende seier gir en større endring.",
  "K-faktoren er 25 når spilleren har 0–10 tellende kamper før kampen, og 15 når spilleren allerede har minst 11 tellende kamper. I dagens implementasjon betyr det høyere bevegelse i de første 11 kampene og roligere rating fra kamp 12.",
  "To spillere på 1000 ELO har 50 % forventet score. Med K=25 gir en seier +12,5 og et tap −12,5. Med K=15 blir tilsvarende endring ±7,5.",
  "Hvis uavgjort brukes i et format, behandles det som 0,5 poeng til hver spiller i ELO-beregningen.",
  "Når spillere har ulik K-faktor, kan poengendringen være ulik på de to sidene. En ny spiller kan derfor vinne mer enn en etablert spiller taper, eller motsatt.",
  "En spiller vises ikke i ELO-rankingen før minst én tellende ELO-kamp er spilt.",
]);

const GUIDES = Object.freeze({
  player: {
    eyebrow: "Spillerguide",
    title: "Brukerguide for spillere",
    intro: "Finn oppgaven du skal gjøre og følg stegene. Guiden beskriver den faktiske arbeidsflyten i portalen.",
    topics: [
      {
        id: "activate",
        group: "Konto",
        title: "Aktiver kontoen din",
        summary: "Knytt innloggingen til spillerprofilen som allerede har kamper, ELO og statistikk.",
        steps: [
          "Åpne aktiveringslenken du har fått fra klubben.",
          "Kontroller at spillernavnet som vises er deg før du fortsetter.",
          "Fullfør registreringen og velg innloggingsinformasjon slik siden ber om.",
          "Logg inn og åpne Min profil.",
          "Kontroller at tidligere kamper og statistikk tilhører profilen din. Hvis noe mangler, kontakt klubbadmin i stedet for å opprette en ny spiller.",
        ],
        note: "Én person skal ha én canonical spilleridentitet. Innloggingen legges oppå eksisterende spillerhistorikk; den skal ikke lage en ny historikk.",
      },
      {
        id: "signup",
        group: "Turnering",
        title: "Meld deg på og sjekk inn",
        summary: "Fra kommende turnering til klar for trekning.",
        steps: [
          "Åpne Turneringer og velg Kommende.",
          "Åpne turneringen du vil delta i.",
          "Trykk Meld på hvis påmeldingen er åpen.",
          "Når innsjekkvinduet åpner, åpner du samme turnering og sjekker inn.",
          "Kontroller at statusen din viser at du er sjekket inn før turneringen starter.",
        ],
        note: "Bare spillere som er sjekket inn når turneringen startes tas med i trekningen. Innsjekk er derfor noe annet enn påmelding.",
      },
      {
        id: "follow-tournament",
        group: "Turnering",
        title: "Følg en pågående eller ferdig turnering",
        summary: "Se deltakere, grupper, kamper og resultater på samme sted.",
        steps: [
          "Åpne Turneringer og velg aktuell turnering. Ferdige turneringer ligger under Tidligere.",
          "Bruk Oversikt for format, tidspunkt og totalsituasjon.",
          "Bruk Deltakere for å se hvem som er med.",
          "Bruk Grupper for tabell, hvem som går videre og kampene i valgt gruppe.",
          "Bruk Kamper for kampoversikten på tvers av turneringen.",
          "Trykk på et spillernavn når du vil gå videre til spillerprofilen.",
        ],
      },
      {
        id: "match-card",
        group: "Kamper",
        title: "Se detaljene i en kamp",
        summary: "Det samme canonical kampkortet brukes på tvers av plattformen.",
        steps: [
          "Trykk på en kamp i gruppevisning, kamphistorikk eller en annen kampoversikt.",
          "Les resultat og ELO-endring øverst.",
          "Sammenlign 3DA, First 9, vinnende checkout, 100+, 140+ og 180 i statistikkdelen.",
          "Åpne legs for å se kastene i faktisk kasterekkefølge når visit-data finnes.",
          "Trykk på spillerens navn hvis du vil gå fra kampen til spillerprofilen.",
        ],
        note: "«Vinnende checkout» er checkouten som avgjør kampen. Checkout-prosent brukes ikke i plattformen.",
      },
      {
        id: "elo",
        group: "Statistikk",
        title: "Forstå ELO-ratingen",
        summary: "ELO måler resultater i forhold til hvor sterke motstanderne var forventet å være.",
        steps: ELO_EXPLANATION,
        note: "Formelen for forventet score er 1 / (1 + 10^((motstanders ELO − din ELO) / 400)). Ratingen lagres med full presisjon selv om grensesnittet kan vise færre desimaler.",
      },
      {
        id: "statistics",
        group: "Statistikk",
        title: "Finn statistikk og spillerprofiler",
        summary: "Gå fra sesongoversikt til enkeltspiller og kamp.",
        steps: [
          "Åpne Statistikk.",
          "Velg sesong- eller turneringsnivå avhengig av hva du vil sammenligne.",
          "Trykk på en spiller for å åpne spillerprofilen.",
          "Bruk kamphistorikken på profilen for å gå videre til canonical kampkort.",
          "Husk at ranking- og statistikklister bare tar med spillere som faktisk har spilt minst én relevant kamp.",
        ],
      },
      {
        id: "membership",
        group: "Konto",
        title: "Se medlemskap og betaling",
        summary: "Finn status og eventuell handling som kreves av deg.",
        steps: [
          "Åpne Hjem for å se om noe krever handling nå.",
          "Åpne Min profil for medlemsstatus og betalingsinformasjon.",
          "Bruk Stripe for fast månedlig betaling når klubben tilbyr det.",
          "Bruk Vipps for enkeltbetaling når dette vises som alternativ.",
          "Ta kontakt med klubben hvis betalingen er utført, men statusen fortsatt ikke stemmer.",
        ],
      },
    ],
  },
  admin: {
    eyebrow: "Adminguide",
    title: "Brukerguide for klubbadmin",
    intro: "Oppgavebaserte prosedyrer for å sette opp og drifte en dartklubb. Stegene skal kunne følges uten kjennskap til hvordan systemet er bygget.",
    topics: [
      {
        id: "board-setup-options",
        group: "Utstyr",
        title: "Velg hvordan en skive skal settes opp",
        summary: "Skiva opprettes én gang. Deretter velger du manuell scoring med eller uten fast nettbrett, eller Scolia som automatisk scorekilde.",
        steps: [
          "Åpne Klubbadmin → Utstyr og opprett den fysiske skiva med riktig skivenummer.",
          "For en vanlig skive velger du Manuell som scoringstype. Du kan opprette skiva først og koble et nettbrett til den senere.",
          "Skal skiva ha et fast nettbrett for manuell scoring, åpner du Blindleia Kiosk på nettbrettet og parer det til den eksisterende skiva. QR via adminmobil er hovedmetoden.",
          "Hvis QR-koden ikke kan brukes, kan pairingkoden fra nettbrettet skrives inn manuelt under Utstyr.",
          "For automatisk scoring velger du Scolia på skiva og kobler riktig Scolia-enhet til skivenummeret etter at klubbens Scolia Service Account er konfigurert.",
          "Hvis et nettbrett byttes ut, beholder du skiva og parer det nye nettbrettet til samme skive. Du skal ikke opprette skiva på nytt.",
        ],
        note: "Tenk på skiva som den permanente enheten i Blindleia Darts. Nettbrett og Scolia er måter å registrere scoring på rundt den samme skiva.",
      },
      {
        id: "normal-board",
        group: "Utstyr",
        title: "Sett opp en vanlig skive",
        summary: "Opprett en dartskive med manuell scoring. Nettbrett kan kobles til med en gang eller senere.",
        steps: [
          "Åpne Klubbadmin → Utstyr.",
          "Finn området Skiver og skjemaet Opprett skive.",
          "Skriv inn skivenummeret, for eksempel 1.",
          "Gi skiva et navn hvis du ønsker det. Hvis navnet står tomt, kan skivenummeret brukes som hovedidentifikasjon.",
          "Velg Manuell under Scoring.",
          "La Scolia-feltene være tomme.",
          "Trykk Opprett skive og kontroller at skiva ligger i listen Skiver.",
          "Hvis skiva skal ha fast nettbrett, åpner du Blindleia Kiosk på nettbrettet og følger QR-pairingen. Du kan også gjøre dette senere.",
        ],
        note: "Det er ikke nødvendig å opprette en ny skive når et nettbrett flyttes eller erstattes. Pairingen kan endres uavhengig av skiva.",
      },
      {
        id: "pair-tablet",
        group: "Utstyr",
        title: "Koble et nettbrett til en skive",
        summary: "Bruk QR-koden på nettbrettet som hovedmetode. Manuell pairingkode er reservealternativet.",
        steps: [
          "Åpne Blindleia Kiosk på nettbrettet. Et uparet nettbrett viser automatisk en QR-kode og en pairingkode.",
          "Ta opp mobilen din der du er innlogget som klubbadmin, og scan QR-koden med kameraet.",
          "Blindleia Darts åpner Utstyr og gjenkjenner nettbrettet automatisk.",
          "Velg skiva nettbrettet fysisk står ved.",
          "Trykk Koble. Nettbrettet går videre automatisk til den valgte skiva.",
          "Kontroller på nettbrettet at riktig skivenummer vises før første kamp startes.",
          "Hvis du ikke får scannet QR-koden, går du manuelt til Klubbadmin → Utstyr → Koble nettbrett til en skive og skriver inn pairingkoden som vises på nettbrettet.",
        ],
        note: "QR via adminmobil er normalflyten. Pairingkoden er der for situasjoner der kamera, QR eller lenkeåpning ikke fungerer.",
      },
      {
        id: "scolia",
        group: "Utstyr",
        title: "Sett opp Scolia-scoring",
        summary: "Bruk Scolia som automatisk scorekilde på en bestemt skive.",
        steps: [
          "Åpne Klubbadmin → Utstyr.",
          "Finn området Automatisk scoring → Scolia.",
          "Aktiver Scolia for klubben når klubben har gyldig Scolia Service Account.",
          "Legg inn Service Account access token og lagre klubboppsettet.",
          "Åpne eller opprett skiva som skal bruke automatisk scoring.",
          "Velg Scolia som scoringstype og legg inn riktig Scolia-ID/serienummer for akkurat den skiva.",
          "Kontroller at hver fysisk Scolia-enhet er koblet til riktig skivenummer før bruk.",
        ],
        note: "Scolia er en scorekilde. Blindleia Darts beholder kamp-, spiller- og resultatdata som canonical data.",
      },
      {
        id: "member-activation",
        group: "Medlemmer",
        title: "Legg til og aktiver et medlem",
        summary: "Knytt brukerkonto til riktig spilleridentitet uten å splitte historikken.",
        steps: [
          "Åpne Klubbadmin → Medlemmer eller Spilleroversikten og søk etter personen først.",
          "Hvis spilleren allerede finnes med kamphistorikk, bruk den eksisterende spilleridentiteten.",
          "Opprett medlemmet bare dersom personen faktisk mangler i registeret.",
          "Hent aktiveringslenken for medlemmet.",
          "Send lenken til personen. Aktiveringen skal knytte innlogging til eksisterende spillerprofil.",
          "Etter aktivering kontrollerer du at medlem, spillerprofil, ELO og historikk peker på samme person.",
        ],
        note: "Ikke løs identitetsproblemer ved å opprette en ny spiller. Rydd den canonical identiteten i stedet.",
      },
      {
        id: "create-tournament",
        group: "Turnering",
        title: "Opprett en turnering",
        summary: "Gjør turneringen klar før spillerne kommer.",
        steps: [
          "Åpne Turneringer og velg å opprette ny turnering.",
          "Angi navn, startdato og starttid.",
          "Sett påmeldingsreglene og når innsjekk skal åpne.",
          "Velg kampformat, startscore, antall grupper, trekning, Best av og hvor mange som går videre når disse valgene er relevante.",
          "Kontroller ELO-innstillingen før kampene starter. Slå av ELO for trening, generalprøve eller andre urangerte turneringer.",
          "Lagre turneringen og kontroller den i den vanlige turneringsvisningen.",
        ],
        note: "ELO-innstillingen låses når turneringen har fått en ferdig kamp. Det hindrer at en ferdigspilt turnering plutselig endrer ratinghistorikken.",
      },
      {
        id: "checkin-start",
        group: "Turnering",
        title: "Sjekk inn spillere og start turneringen",
        summary: "Fra påmeldingsliste til grupper og kamper.",
        steps: [
          "Åpne den aktuelle turneringen som admin.",
          "Vent til innsjekkvinduet har åpnet. Admin kan heller ikke sjekke inn spillere før dette tidspunktet.",
          "Sjekk inn spillerne som faktisk har møtt. En feilinnsjekket spiller kan sjekkes ut igjen før start.",
          "Kontroller formatet en siste gang: score, grupper, trekning, Best av og sluttspillregler.",
          "Kontroller at alle som skal delta står som sjekket inn.",
          "Start turneringen.",
          "Kontroller gruppetrekning og opprettede kamper før første kamp settes i gang.",
        ],
        note: "Påmelding reserverer plass; innsjekk bekrefter oppmøte. Bare de sjekket inn spillerne tas med når turneringen starter.",
      },
      {
        id: "run-tournament",
        group: "Turnering",
        title: "Drift en pågående turnering",
        summary: "Følg samme turneringsflate som spillerne, med adminfunksjoner der de trengs.",
        steps: [
          "Åpne turneringen og bruk Oversikt, Deltakere, Grupper og Kamper for å følge status.",
          "Bruk Admin-fanen for handlingene som er gjort tilgjengelige i den vanlige turneringsvisningen.",
          "Følg skivene og kampkøen slik at neste kamp kan gå i gang uten unødig venting.",
          "Trykk på kamper for canonical kampkort når du må kontrollere resultat, ELO, statistikk, legs eller kast.",
          "Rett feil i canonical kamp-/spillerdata i stedet for å lage en alternativ fasit i en enkelt visning.",
          "Kontroller grupper og sluttspill før turneringen ferdigstilles.",
        ],
      },
      {
        id: "elo",
        group: "ELO og statistikk",
        title: "Slik fungerer ELO-ratingen",
        summary: "Forstå hva som påvirker ratingen og hvordan du styrer om en turnering skal telle.",
        steps: ELO_EXPLANATION,
        note: "Forventet score = 1 / (1 + 10^((motstanders ELO − spillerens ELO) / 400)). ELO beregnes per spiller med egen K-faktor og bygges i logisk kamprekkefølge. Hvis historiske kampresultater rettes, kan senere ELO derfor endre seg ved ny beregning.",
      },
      {
        id: "live-finish",
        group: "Drift",
        title: "Kontroller Live og ferdigstill kvelden",
        summary: "Sørg for at offentlig visning og historikk bygger på riktig data.",
        steps: [
          "Åpne Live og kontroller at aktive kamper, kø, grupper/sluttspill og ELO viser det som faktisk skjer i lokalet.",
          "Husk at ranking- og statistikklister ikke skal vise spillere før de har spilt minst én relevant kamp.",
          "Når alle kamper er ferdige, kontroller turneringsresultat, gruppetabeller og sluttspill.",
          "Åpne stikkprøver av kampkort dersom noe ser feil ut i score eller statistikk.",
          "Ferdigstill turneringen når canonical data er kontrollert.",
        ],
      },
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
    .bd-guide-open{appearance:none!important;-webkit-appearance:none!important;width:100%!important;min-height:38px!important;display:flex!important;align-items:center!important;gap:9px!important;padding:8px 10px!important;border:0!important;border-radius:8px!important;background:transparent!important;color:inherit!important;box-shadow:none!important;font:inherit!important;font-size:13px!important;font-weight:650!important;text-align:left!important;cursor:pointer!important;opacity:.88}
    .bd-guide-open::before{content:"?";display:grid;place-items:center;width:18px;height:18px;flex:0 0 18px;border:1px solid currentColor;border-radius:50%;font-size:11px;font-weight:900;opacity:.65}
    .bd-guide-open:hover,.bd-guide-open:focus-visible{background:rgba(126,161,199,.12)!important;color:inherit!important;box-shadow:none!important;outline:none!important;opacity:1}
    .bd-user-guide{width:min(940px,calc(100vw - 24px));max-height:min(90dvh,940px);padding:0;border:0;border-radius:22px;background:#f4f7fa;color:#0b2b50;box-shadow:0 28px 90px rgba(8,29,54,.38);overflow:hidden}
    .bd-user-guide::backdrop{background:rgba(7,25,47,.58);backdrop-filter:blur(2px)}
    .bd-guide-shell{max-height:min(90dvh,940px);overflow:auto;padding:22px}
    .bd-guide-head{position:sticky;top:-22px;z-index:5;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;margin:-22px -22px 16px;padding:20px 22px 16px;background:rgba(244,247,250,.97);border-bottom:1px solid #dbe5ef;backdrop-filter:blur(16px)}
    .bd-guide-head p{margin:0}.bd-guide-eyebrow{text-transform:uppercase;letter-spacing:.11em;font-size:11px;font-weight:900;color:#2f6fed}.bd-guide-head h2{margin:4px 0 5px;font-size:clamp(24px,4vw,34px);line-height:1.08}.bd-guide-intro{color:#6f8296;max-width:70ch;line-height:1.45}
    .bd-guide-close{appearance:none;width:40px;height:40px;flex:0 0 40px;border:1px solid #d6e1ec;border-radius:50%;background:#fff;color:#536b83;font-size:24px;line-height:1;cursor:pointer}
    .bd-guide-search{grid-column:1/-1;display:flex;align-items:center;gap:8px;margin-top:4px;padding:0 12px;border:1px solid #d6e1ec;border-radius:12px;background:#fff}.bd-guide-search span{color:#7a8da0}.bd-guide-search input{width:100%;min-width:0;padding:11px 0;border:0;outline:0;background:transparent;color:#0b2b50;font:inherit}
    .bd-guide-layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:14px;align-items:start}.bd-guide-toc{position:sticky;top:126px;display:grid;gap:4px;padding:8px;border:1px solid #dbe5ef;border-radius:15px;background:#fff}.bd-guide-toc button{appearance:none;width:100%;padding:9px 10px;border:0;border-radius:9px;background:transparent;color:#50677f;font:inherit;font-size:13px;font-weight:720;text-align:left;cursor:pointer}.bd-guide-toc button small{display:block;margin-bottom:2px;color:#8a9bad;font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:.07em}.bd-guide-toc button.active{background:#edf4ff;color:#174f91}.bd-guide-toc button:hover{background:#f3f7fb}.bd-guide-toc-empty{padding:12px;color:#8091a4;font-size:13px}
    .bd-guide-article{min-width:0;padding:20px;border:1px solid #dbe5ef;border-radius:18px;background:#fff}.bd-guide-article .bd-guide-group{margin:0 0 4px;color:#2f6fed;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.09em}.bd-guide-article h3{margin:0;font-size:25px;line-height:1.15}.bd-guide-summary{margin:8px 0 18px;color:#657b91;line-height:1.5}.bd-guide-steps{margin:0;padding:0;list-style:none;counter-reset:guide-step;display:grid;gap:11px}.bd-guide-steps li{counter-increment:guide-step;display:grid;grid-template-columns:30px minmax(0,1fr);gap:10px;align-items:start;color:#405a73;line-height:1.5}.bd-guide-steps li::before{content:counter(guide-step);display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#edf4ff;color:#205ea8;font-size:12px;font-weight:900}.bd-guide-note{margin:18px 0 0;padding:13px 14px;border-left:3px solid #2f6fed;border-radius:0 10px 10px 0;background:#f3f7fc;color:#536b83;line-height:1.5}.bd-guide-version{margin:14px 2px 0;color:#8192a4;font-size:11px}
    @media(max-width:760px){.bd-user-guide{width:100vw;max-width:100vw;height:100dvh;max-height:100dvh;border-radius:0}.bd-guide-shell{max-height:100dvh;padding:16px 12px 24px}.bd-guide-head{top:-16px;margin:-16px -12px 12px;padding:16px 12px 12px}.bd-guide-layout{grid-template-columns:1fr}.bd-guide-toc{position:static;display:flex;overflow-x:auto;gap:6px;padding:5px;scrollbar-width:none}.bd-guide-toc::-webkit-scrollbar{display:none}.bd-guide-toc button{flex:0 0 auto;width:auto;max-width:210px;white-space:nowrap}.bd-guide-toc button small{display:none}.bd-guide-article{padding:16px}.bd-guide-article h3{font-size:22px}.bd-guide-open{min-height:40px!important}}
  `;
  document.head.appendChild(style);
}

function renderArticle(topic) {
  return `<p class="bd-guide-group">${esc(topic.group)}</p><h3>${esc(topic.title)}</h3><p class="bd-guide-summary">${esc(topic.summary)}</p><ol class="bd-guide-steps">${topic.steps.map(step => `<li><span>${esc(step)}</span></li>`).join("")}</ol>${topic.note ? `<p class="bd-guide-note">${esc(topic.note)}</p>` : ""}`;
}

function ensureDialog() {
  let dialog = document.querySelector("dialog.bd-user-guide");
  if (dialog) return dialog;
  const guide = GUIDES[SURFACE];
  dialog = document.createElement("dialog");
  dialog.className = "bd-user-guide";
  dialog.innerHTML = `<div class="bd-guide-shell">
    <header class="bd-guide-head"><div><p class="bd-guide-eyebrow">${esc(guide.eyebrow)}</p><h2>${esc(guide.title)}</h2><p class="bd-guide-intro">${esc(guide.intro)}</p></div><button type="button" class="bd-guide-close" aria-label="Lukk brukerguide">×</button><label class="bd-guide-search"><span aria-hidden="true">⌕</span><input type="search" placeholder="Søk: skive, innsjekk, ELO …" aria-label="Søk i brukerguiden"></label></header>
    <div class="bd-guide-layout"><nav class="bd-guide-toc" aria-label="Emner i brukerguiden"></nav><article class="bd-guide-article"></article></div>
    <p class="bd-guide-version">Guide sist gjennomgått ${esc(GUIDE_VERSION)}.</p>
  </div>`;
  document.body.appendChild(dialog);

  const toc = dialog.querySelector(".bd-guide-toc");
  const article = dialog.querySelector(".bd-guide-article");
  const search = dialog.querySelector(".bd-guide-search input");
  let selectedId = guide.topics[0]?.id || "";

  const selectTopic = (id) => {
    const topic = guide.topics.find(item => item.id === id) || guide.topics[0];
    if (!topic || !article) return;
    selectedId = topic.id;
    article.innerHTML = renderArticle(topic);
    toc?.querySelectorAll("button[data-topic]").forEach(button => button.classList.toggle("active", button.dataset.topic === selectedId));
  };

  const renderToc = () => {
    if (!toc) return;
    const query = String(search?.value || "").trim().toLocaleLowerCase("no");
    const visible = guide.topics.filter(topic => !query || `${topic.group} ${topic.title} ${topic.summary} ${topic.steps.join(" ")} ${topic.note || ""}`.toLocaleLowerCase("no").includes(query));
    if (!visible.length) {
      toc.innerHTML = `<p class="bd-guide-toc-empty">Ingen treff. Prøv et annet ord.</p>`;
      if (article) article.innerHTML = `<p class="bd-guide-group">Søk</p><h3>Ingen treff</h3><p class="bd-guide-summary">Prøv for eksempel «skive», «turnering», «innsjekk», «kamp» eller «ELO».</p>`;
      return;
    }
    if (!visible.some(topic => topic.id === selectedId)) selectedId = visible[0].id;
    toc.innerHTML = visible.map(topic => `<button type="button" data-topic="${esc(topic.id)}" class="${topic.id === selectedId ? "active" : ""}"><small>${esc(topic.group)}</small>${esc(topic.title)}</button>`).join("");
    toc.querySelectorAll("button[data-topic]").forEach(button => button.addEventListener("click", () => selectTopic(button.dataset.topic || "")));
    selectTopic(selectedId);
  };

  search?.addEventListener("input", renderToc);
  dialog.querySelector(".bd-guide-close")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
  renderToc();
  return dialog;
}

function openGuide() {
  const dialog = ensureDialog();
  if (!dialog.open) dialog.showModal();
}

function ensureMenuButton() {
  const nav = document.querySelector(".portal-menu");
  if (!nav) return;
  let button = nav.querySelector(".bd-guide-open");
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "bd-guide-open";
    button.textContent = "Brukerguide";
    button.addEventListener("click", openGuide);
  }
  const account = nav.querySelector(".unified-sidebar-account");
  if (account) {
    if (button.nextElementSibling !== account) nav.insertBefore(button, account);
  } else if (!button.isConnected) {
    nav.appendChild(button);
  } else if (button.parentElement !== nav) {
    nav.appendChild(button);
  }
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