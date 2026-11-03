# Blindleia – reell ende-til-ende-test og kiosk-UI/UX-gjennomgang

**Status (03.11.2026):** planlagt og kildekode-gjennomgått, **ikke** fullført i faktisk nettleser. Ikke bruk grønn HTTP-smoke som bevis på at spillerreisen eller kioskinteraksjoner fungerer.

## Omfang og kilde til sannhet

- V1/kiosk i PROD er fortsatt aktivt utgangspunkt og gir **Innstillinger → Start testmodus**. TEST åpner da **v2/kiosk i en beskyttet iframe** (engangs-parametre `testmode=1`, `embedded=1` og gyldig PROD-`return_url`). Direkte navigasjon til TEST v2 uten testøkt skal gå tilbake til PROD; **ikke** forsøk å omgå denne barrieren.
- Skivetest velger en fysisk skive i TEST-velgeren, men score og turneringsruntime skrives **kun i `bd_test_`**. Fysisk skivereferanse og innlogging leses fra `bd_prod_`; aldri skriv hardware, bruker eller auth-identitet tilbake.
- Backend-HTTP- og kontrakttester finnes allerede. Denne testpakken supplerer dem med faktiske nettleserskjermbilder, og den manuelle testen nedenfor med virkelige turneringsmutasjoner.
- Scolia-abonnement mangler; faktisk hardware/API-støtte kan ikke kvitteres ut. Test manuell scoring og kun simulerte Scolia-hendelser. Integrasjonsforbedringen ligger i PR #380, kildesporing/WebSocket i PR #382 og spillerinnsjekk/Live i PR #384; **ingen av disse er godkjent for PROD bare av denne testpakken**.
- Stabilitet i TEST må kontrollere #381 (428 gjestekamper i ELO-ledger). Ikke manipuler disse for å få en grønn test.

## A. Automatisk nettleserbevis: etter hver relevant TEST-deploy

Kjør GitHub Actions **TEST UI Browser QA** etter bekreftet TEST-release-SHA. Den bruker Chromium/Playwright med ekte TEST-nettsider, tar bilder på følgende viewportstørrelser:

| Overflate | Viewports | Grunnkontroll |
| --- | --- | --- |
| Spillerportal mobil | 375×812, 412×915 | Anonym innlasting, feil i JS, horisontal overflow, påloggingsnavigasjon |
| Spillerportal nettbrett/desktop | 768×1024, 1440×900 | Layout og navigasjon uten klipping |
| Live | 1280×720 | Innlasting, status/phase uten feil |
| Kiosk v2 i test-launcher | 600×960, 768×1024, 1440×900 | **PROD kiosk → Start testmodus → TEST iframe**; TEST-banner/velger, klipping, desktop beholdt nettbrettformat |
| Kiosk v1 PROD | 768×1024 | Kun visning/innstillingsinngang, ingen PROD-kast eller pairingmutasjoner |

Dette er en **read-only visuell smoke** som standard: spillerportal og Live hentes fra TEST, ingen score, påmelding, innsjekk eller TEST-lease. **Viktig sikkerhetsdetalj:** Bare det å åpne en *uparret PROD-kiosk* kan automatisk opprette en pairing request i PROD. Derfor er de automatiserte kiosk-iframe-testene eksplisitt **skippet** i den read-only workflowen. De må kjøres under en overvåket, særskilt godkjent test med `ALLOW_PROD_KIOSK_BOOT=1` og etter oppklaring av denne sideeffekten. Ikke slå på denne variabelen i automatisk CI. Vi trenger etter hvert en egen sikker TEST-UI/visual-harness uten PROD-muteringer. Ved feil lagres trace og screenshot som GitHub-artifact.

Automatisk TEST UI QA gir dermed **faktiske browser-screenshots av spillerportalen og Live**. Kioskens K01–K20 bekreftes i første omgang ved den separate, manuelle TEST-kiosk-sesjonen under. Ingen av de automatiserte testene kan i seg selv bevise kiosk-scoring.

**Viktig:** Browser QA som blir grønn er *ikke* nok. Den kan ikke bevise registrering/innsjekk/kamp uten autentiserte testbrukere og aktiv testturnering.

## B. Funksjonell E2E – faktisk spillerreise, ikke mock

Forbered en isolert TEST-turnering merket `BD E2E QA <dato>` via TEST admin. Fyll den med to eksisterende, autoriserte test-/medlemsidentiteter (A og B) og eventuelt to ekstra fiktive **TEST turneringsgjester** der backend tillater det. Unngå å opprette nye canonical brukerkontoer under TEST; innlogging/identitet kommer fra `bd_prod_`. Bruk en egen admin. Testturneringen, kamper, scoring og registreringer skrives bare til `bd_test_`.

1. **Spiller A – mobil:** Logg inn i `/player/`; gå fra Hjem til åpen QA-turnering; meld på. Kontroller at knappen får «Melder på …», at ett trykk gir én påmelding, og at status vises som «Påmeldt» både på Hjem og i Turneringer.
2. **Spiller B – annen mobil/nettleser:** Meld på samme turnering. Simuler tregt nett (Chrome/Playwright throttling), dobbelttrykk og oppfrisking. Registrering må være idempotent/forutsigbar, og feil må forklare *om* mutasjonen er lagret.
3. **Innsjekkvindu:** Før åpning skal begge få tidspunkt og ingen kode-dialog. Ved åpning skal «Sjekk inn» på Hjem og i turneringsdetaljene åpne **samme** dialog. Feil kode gir inline feilmelding; riktig kode lagrer én `checked_in`, uten siden lastes på nytt.
4. **Admin-only, venteliste og medlemslås:** Test egne QA-tilfeller med korrekte backend-regler; ventelistede kan ikke sjekke inn, og betalingslås skal ikke se ut som en mislykket teknisk forespørsel.
5. **Turneringsleder:** Avslutt innsjekk, trekk grupper/sett opp kamper og tildel **TEST skive**. Både A, B og admin må se samme motstander, kampstatus og skive.
6. **Kiosk:** Åpne PROD `/kiosk/` → Innstillinger → **Start testmodus** → velg en **manuell** skive. Ikke pare om PROD-kiosken og ikke skru på Scolia-leasen. Start kampen i TEST.
7. **Scoring:** Før sumscore (100, 140, 0), per-pil score, bust og checkout; test spillerbytte, samme aktiv spiller i kiosk/Live, en undo, redigering av de fire nyeste kastene og korrekt leg/checkout. Verifiser `bd_test_visits` og `source=manual` når PR #382 er rullet ut.
8. **To kiosker:** La en annen TEST-skive ha egen kamp. Gjør ett kast på hver, og kontroller at oppdateringer ikke blandes og at DB-concurrency holder seg stabil.
9. **Live og spillerportal parallelt:** Ha `/live/` og begge spillerportaler åpne. Mål `input → bekreftet canonical commit → WS-publish → visning på andre kiosk → Live → spillermobil`. Start deretter en simulert WS-frakobling og bekreft polling-fallback. Live sin separate skiverotasjon (6s) og gruppe/ELO (20s) må **ikke** nullstilles av 3s datapoll.
10. **Kampavslutning:** Kontroller **serverbekreftet** resultat før kiosken går videre, holdetid, reservert neste kamp, og at ingen feilvisning eller ekstra visits dannes ved reload/nettfall.
11. **Avslutning:** Bruk «Avslutt testmodus», bekreft tilbakegang til PROD uten endret skive-pairing/hardware. Behold TEST QA-turneringen til resultatet er kontrollert, og slett/arkiver først med korrekt TEST-only-prosedyre.

Dersom bruker A/B ikke har separate legitime TEST-innloggingsmuligheter, kan vi *ikke* kalle dette reell tobruker-E2E ennå. Opprett/autoriser dedikerte testidentiteter via ordinær identitetsprosess separat; **ikke** omgå auth eller skrive til `bd_prod_` fra TEST.

## C. Kiosk UI/UX-matrise – hver eneste tilstand må faktisk sees på skjerm

| ID | Tilstand | Verifiser med faktisk skjerm/handling |
| --- | --- | --- |
| K01 | Uparret | Paring/QR, utløpt kode, nettverksfeil, klare instruksjoner |
| K02 | TEST-velger | Tydelig TEST, skive 1–4, riktig manuell/Scolia-merking, trygg utgang |
| K03 | Ingen turnering | Ikke låst/spinner; forståelig tomtilstand |
| K04 | Tildelt kamp | Begge navn, skive, runde, best-of, **Start kamp** stor og entydig |
| K05 | Aktiv kamp | Aktiv spiller, score, legs og pilstatus med tydelig kontrast |
| K06 | Sumscore | Tastatur, 0, 100, 140, 180, del, invalid score, 44px+ trykkflater |
| K07 | Per pil | S/D/T, 1–20, 25, bull, miss; pil 1/2/3; riktig sum |
| K08 | Bust / checkout | Samme regler som backend, korrekt antall piler, riktig leg/spillerbytte |
| K09 | Avbryte/undo | Riktig siste kast, busy-lås, ingen duplikater eller slette feil spiller |
| K10 | Fire siste kast | Alle fire vises, riktig kronologi, redigering åpner riktig kast |
| K11 | Korrigering av gammelt kast | Test feil midt i undo/replay; ingen tap av senere visits |
| K12 | Lagreventer | Vis «venter på bekreftelse», ingen falsk «lagret» |
| K13 | Timeout/502/reload | Bevar pending request ID og gjenopprett canonical status, ikke ny score |
| K14 | Kamp fullført | Resultat **bekreftet av server**, riktig vinner, holdetid og neste kamp |
| K15 | Scolia uten abonnement | Umiddelbart manuell scoring; ikke 30s «venter på Scolia» |
| K16 | Scolia fallback | Tapte events, ingen duplikater, eksplisitt scoreavstemming før resume |
| K17 | Innstillinger | Tilbake/oppdater/tilbakestill tydelig; forhindrer utilsiktet destruktiv handling |
| K18 | Ulike skjermer | 500×800, 600×960, 768×1024, 820×1180; skjult/klippet knapper, zoom, softkeyboard, iPad Safari |
| K19 | Desktop-test | Nettbrettformat bevares uten å brettes ut; ingen scroll som flytter scoringen |
| K20 | Fire parallelle kiosker | Uavhengige resultater, moderat polling/DB, null mismatch etter 20+ kast |

## D. Kildekodefunn som krever risikobasert oppfølging (ikke bekreftede browser-feil)

**P0 – funksjonell/dataintegritet**
- Kiosk v2, `saveVisitEdit()`: korrigering av ett av de siste fire kastene utføres som flere separate kall `undo` + ny `visit` + replays. Ved avbrudd midt i sekvensen kan kampstatus bli stående halvveis. Ønsket: én serverstyrt, atomisk korrigering, eller sikker rollback/recovery. Ref. åpen PR #196.
- Kiosk v2, `completion` teller ned lokalt og kaller `finishCompletion()` ved 0. Initielt er `confirmed=false`; timeren sjekker ikke `confirmed` før `next-match` kan kalles. Verifiser at ingen overgang skjer før canonical resultat/forrige post-match er bekreftet.

**P1 – stabilitet/paritet**
- Kiosk v2 bruker `Number(match.id)`, `Number(player.id)` og talltyper for flere sentrale DB-ID-er, mot prosjektets BIGINT/decimal-string-regel. Gå gjennom identifikatorer og sammenlign med eksakt streng for å unngå avrundede store ID-er.
- `manualQueueRef` er minnebasert; test uventet reload/crash mens serverbekreftelsen er usikker. Ikke autosend med ny request-id.
- `visitEditingAllowed` baseres på fysisk `scoring_mode`, ikke alltid effektiv `manual`-fallback. Scolia-merket skive uten API kan dermed få manuell scoring men ikke samme manuelt redigerings-UX.
- V1 og v2 har forskjellige funksjoner. V1 laster mange lag med CSS-/JS-overstyringer, mens v2 har egen React/CSS. Enkeltstående grønn test av v2 kvalifiserer **ikke** en PROD cutover.

**P2 – visuell/tilgjengelighet**
- Fast én-skjerms layout bruker `overflow:hidden`. Test reelle små nettbrett, dialoger og feilmeldinger med lange norske navn. En knapp som er usynlig uten scrolling er en funksjonsfeil.
- Noen interaksjoner er 34–42px høye (modusvalg, angring/innstillinger og små knapper); mål faktisk trefflate. Mål >=44×44px for de viktige kontrollene.
- Mobil <480px skjuler de siste kastene med `.visits{display:none}`; definér mobil nødmodus eksplisitt, inkludert hvordan korrigering/undo skal fungere.
- Kiosk viser optimistiske kast før databasekvittering. Vis tydelig forskjell mellom «sendt», «bekreftet», «kan ikke bekrefte» og «krever avstemming».

## E. Objektive godkjenningskriterier

- Ingen uavklarte P0-problemer.
- 100 % av K01–K20 dokumentert med screenshot/video, faktisk API-svar og PASS/FAIL (eller kontrollert «ikke testbar – Scolia API»).
- Minst én reell kamp fullført på TEST fra mobilpåmelding via innsjekk, admin og kiosk til Live/portal.
- Null dobbeltsendte visits/registreringer og null feil spillerbytter.
- Browser Console uten ubehandlede JS-feil, null overlapp/klipping ved definerte nettbrettstørrelser.
- Ingen TEST-skriving til PROD hardware/identity. Ingen PROD-deploy uten eksplisitt godkjent UAT.
