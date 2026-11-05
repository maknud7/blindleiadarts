# Blindleia – plattformdekkende UI/UX- og konfliktanalyse

Dato: 2026-11-05  
Status: **Kodegjennomgang og prioriterte rettelser**. Dette er ikke en signert visuell gjennomgang på innlogget TEST med ekte medlemmer og fysisk Scolia.

## Mål og metode

Blindleia skal oppleves som **én plattform**: lik navigasjon og begrepsbruk, handlinger og feilmeldinger; mobil først for spiller, mobil/desktop for medlem, desktop/nettbrett for turneringsleder, stor skjerm for Live, adaptivt nettbrett for kiosk.

Gjennomgått kildekode for canonical root, admin, medlemsregister, spiller, turneringsledelse, Live, kiosk og felles CSS/meny; lagt til Chromium-smoketester for medlemsregister i 375/768/1440 px, klubbbytterace og retry. Sammenlignet lastestruktur og faktisk CSS-ansvar. QA uten innlogging kjører med mock API og **ingen mutasjoner**. Verifikasjon av ekte innlogget TEST og visuelle snapshots på tvers av alle flyter kreves før full sign-off.

## Brukerreise og datagrense

| Flate | Primært mål | Skal være lett synlig | Viktig skille |
|---|---|---|---|
| Spiller / mobil | Se neste aktivitet; påmelding; innsjekk; neste kamp; egen statistikk | Én primær handling, forståelig tilstand, tilbakeknapp | Påmeldt ≠ innsjekket ≠ aktiv kamp |
| Medlemmer / admin | Medlemsregister, aktivering, rolle, betalingsoverblikk | Aktive, krever handling, nye registreringer, inaktive | Medlem ≠ konto ≠ dartspiller |
| Spillerdatabase / admin | Identitets-/spillerkobling og dubletter | Avklart ansvar, eksplisitt bekreftelse ved sammenslåing | Spiller-ID/ELO/historikk må beholdes |
| Turneringsleder | Oppmøte, minimum 4, skiver, kø, kamper, resultat | Pågår/neste/ledig, mulighet for trygge handlinger | Bekreftet mutasjon skal ikke retries automatisk |
| Kiosk / nettbrett | Riktig skive, aktiv spiller, kast, bekreftelse | Tydelig status, touch-mål, failsafe for skjermstørrelse | TEST skal aldri styre PROD hardware |
| Live / TV | Oppmøte før start; kamper/resultater når i gang | Tilstand, oppdatert tidspunkt, stale-varsel | Delvis API-feil skal ikke gi feil skjermmodus |
| Innstillinger / admin | Betalingsinformasjon og klubbvalg | Hva styres her, hva ligger eksternt | Stripe-status ≠ full betalingsavstemming |

**Medlemsmodulen** (`apps/admin/member-onboarding-admin.js`) tilbyr invitasjon, aktivering, deaktivering, rolle, filter, status og *indikativ* betalingssituasjon. Dette er ikke full Stripe-/kontingentoppfølging. Skjermtekst er presisert. Kobling til spillerhistorikk er en separat admin-kapabilitet. Roller og backendgrenser må gjennomgås før slik kobling eksponeres bredere.

## Funn, risiko, tiltak og test

### P0 / P1 – kodefeil som kan fremstå som «siden låser seg»

1. **P0 – Foreldede medlemskall ved klubbbytte (rettet i denne PR).** `member-onboarding-admin.js` hadde én `state.loading`-lås som avviste alle nye lesekall. Et sent, gammelt svar kunne bli vist som nytt klubbresultat. Nå avbrytes forrige GET og resultat beskyttes med revisjonsnummer. Ved klubbbytte blankes gammel liste først. GET tidsavgrenses til 12 sekunder. POST-mutasjoner får ikke automatisk retry/abort-semantikk.
2. **P0 – Manglende recovery ved API/importfeil (rettet).** Medlemsregister fikk tidligere en enkel feiltekst, mens importfeil kunne etterlate «Laster». Nå vises retry, og `admin-section-loader.js` kan importere feilende modul med nytt cache-suffiks uten å laste allerede vellykkede moduler på nytt.
3. **P1 – To eiere av menyens DOM (delvis rettet).** `portal-menu.js` eier hash/aktive seksjoner. `unified-portal-shell.js` bygde samtidig hele navigasjonen på nytt for hvert `bd:portal-view`. Dette ble deaktivert; rolle-/sesjonsendringer oppdaterer fortsatt menyen. Gjenværende observatører og historiske menylag bør konsolideres videre.
4. **P1 – Medlemsoppsummeringen skjult på mobil (rettet).** `admin-ux.css` hadde `.member-access-summary{display:none!important}` samtidig som medlemsmodulen tilbød fire interaktive kort. Ny eksplisitt mobilgrid viser dem igjen.

### P1 – systemisk UI-overlapp, ikke ferdig refaktorert

5. **Medlemmer har konkurrerende stilkilder.** `member-onboarding-admin.css` og en stor CSS-streng injisert av `member-onboarding-admin.js` definerer overlappende selektorer. `admin-ux.css`, `blindleia-system.css`, `unified-portal-shell.css` og dynamiske stilregler bygger på. Et fremtidig arbeid må konsolidere *ett* autoritativt medlemsstylesheet og fjerne runtime-injeksjon etter visuell sammenligning. Ikke fjern CSS blindt; skjulte avhengigheter kan være årsaken til tidligere regressjoner.
6. **Live har mange historiske «v2/v3/v...v10»-stylesheets.** `apps/live/index.html` laster rundt tjue CSS-kilder. Senere regler kan utilsiktet overstyre eldre komponenter. Konsolider i felles Live-komponenttokens, sjekk TV-formater og standby/innsjekk/bracket med visuelle snapshots.
7. **Kiosk v1 har mange lag av «fix»-CSS og synkrone scripts.** `apps/kiosk/index.html` laster rundt seksten CSS-filer og en lang rekke scripts. Kiosk v2 har egne responsive regler. Definer én aktiv runtime per kioskvisning og eksplisitt test/PROD-grense; ikke mix på en måte som overtar skiver. Verifiser flere nettbrett i stående og liggende orientering med faktiske mål.
8. **Flere adminseksjoner har egne render-/eventsystemer.** `app.js` skriver ut hele lister og binder hendelser på nytt etter render; andre moduler dekorere/observerer de samme nodene. Bruk konsekvent «én DOM-eier per komponent», eventdelegasjon og bare avgrensede `MutationObserver` der den faktisk trengs.
9. **Spillerdatabase og medlemsregister er ikke en enhetlig brukerreise.** `admin-section-loader.js` har `playerbase`-moduler, men canonical adminmeny / HTML gir ikke en tilsvarende synlig, komplett seksjon. Dette bør løses med eksplisitt rute, rollebasert tilgang og en tydelig flyt for medlem ↔ brukerkonto ↔ spillerprofil, *uten* å åpne identitetsmerge ukritisk for klubbadmin.
10. **Duplicert Utstyr-rutemål.** `apps/admin/index.html` har både `#kiosks` og et skjult `#screens` med `data-portal-section="kiosks"`. Avklar én visuell eier og plasser venue-skjermer eksplisitt under Utstyr i stedet for å dele ruten mellom to noder.
11. **Felles begreps- og statuskontrakt mangler.** Noen flater skriver «Board», «skive», «pairing», «parret», «klar», «ready». Velg norsk medlemsspråk: *skive*, *nettbrett koblet til*, *sjekket inn*, *i kø*, *kamp pågår*, *krever handling*; tekniske felter kun i avansert visning.
12. **Skjermbilder/visuell regresjon dekker ikke hele kanoniske plattformen.** Eksisterende nettlesertester dekker enkelte UI-flyter, men ikke en komplett innlogget runde med ekte Stripe-status, medlemspassasje og fysiske terminaler. Ingen QA basert bare på CSS-grep kan bekrefte full visuell konsistens.

## Designkontrakt for videre arbeid

- **Én navigasjonsansvarlig:** `portal-menu.js` setter aktiv rute, `unified-portal-shell.js` bygger bare nav-ramme ved oppstart/rollebytte, og modulene reagerer bare på endret aktiv seksjon. Ingen `window.location.reload` inne i en lokal handling hvis visningen kan oppdateres trygt.
- **Én stilautoritet per komponent:** `brand-tokens.css` og `blindleia-system.css` eier grunnverdier; hver modul eier scoped CSS; færre nye `!important`-patcher. Ikke injiser CSS på hver modulopprettelse.
- **Responsiv matrise:** 375/390, 768, 1024/1280/1440 desktop, 16:9 Live-TV, 4:3 og 16:10 kiosk. Test både touch og tastatur; ingen horisontal overflow av vesentlig innhold.
- **Handling/tilstand:** konsistent lasting, tom liste, nettverksfeil, tilgangsfeil, bekreftet mutasjon, konflikt (409), stale data og retry. GET kan avbrytes/tidsavgrenses. POST skal ikke automatisk sendes to ganger.
- **Roller og datasikkerhet:** normal spiller, klubbadmin, superadmin og kiosk. Aktivitet knyttet til konto/medlem må ikke blandes med spilleridentitet. TEST skriving bare til `bd_test_`; PROD identity/hardware leses etter eksisterende grenser.
- **Semantikk:** riktige `button`, `aria-live`, fokus/ESC i modaler, synlig fokus og avklaring av tabellrad som «button» på desktop når raden ikke har handling.

## Testmatrise og release-gate

| Test | Automatisk | Manuell akseptanse |
|---|---|---|
| Medlemmer i 375/768/1440 px med søk, aktive/inaktive og kort | Ny Chromium test | Fullt medlemsregister, ekte roller |
| Raskt klubbbytte / sent GET-svar / API-feil | Ny Chromium test | Sjekk at gammel klubb aldri vises |
| Importfeil og «Prøv igjen» | Ny statisk kontrakt + UI-kode | Simulert midlertidig nettfeil |
| Navigasjon / mobile drawer | Ny kodekontrakt + eksisterende testsuite | Alle seksjoner, tilbake, mobil/desktop-overgang |
| Spiller påmelding → innsjekk → kamp | Eksisterende browser tests | Fire personer i TEST ved neste klubbtest |
| Turneringsleder flytt kamp / avslutt oppmøte | Eksisterende browser/Node tester | Praktisk turneringskveld |
| Live oppmøte/feil/stale, TV-bracket | Eksisterende tester for delmengde | Stor skjerm i Sjøbua |
| Kiosk ulike nettbrett/Scolia/hardware | Eksisterende kiosk responsive tester | Onsite uten PROD sideeffekter |
| Betaling / medlemskobling / Stripe | Ikke ferdig e2e-dekket | Separate data- og tilgangstester |

**Status:** De tre avgrensede UI/UX-rettelsene og regrestestene leveres i egen PR. Punktene om designkonsolidering, medlem-/spillerreise og full visuell verifikasjon er **funn og videre arbeid**, ikke påstått løst. Ingen automatisk produksjonspublisering.
