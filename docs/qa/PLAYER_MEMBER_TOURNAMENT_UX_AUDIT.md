# Blindleia UX-verifikasjon: medlemmer, spillere og turneringsleder

Oppdatert 03.11.2026. **Dette er en konkret, rollebasert revisjons- og testplan, ikke en påstand om at reell brukertest allerede er fullført.**

## Bakgrunn og dagens UX-risiko

- Medlems- og spillerportalen har mange historiske tilpasningslag (spiller-hjem, registrering, turneringsdetaljer, betalingsstatus, historikk og statistikk). Dermed må vi teste *hele forløp* – ikke bare at en enkelt visning åpnes.
- Klubbadmin har både legacy Utstyr og en nyere /v2/equipment-side. Lasting av Scolia-/pairingstatus må ikke blokkere administrasjonsmenyen. Den nye implementasjonen har 12s deadline og bevarer sist viste utstyr ved GET-feil; legacy listeobservatør reagerer kun på faktisk nye utstyrsrader.
- Turneringsdrift har egen skive- og kampliste. Tidligere kunne valgt skive bli nullstilt ved oppfriskning, og første ledige skive var implisitt valgt. Endringen innfører *eksplisitt valg*, oppbevaring av valgt skive over oppdateringer og tydelige tilstander Ledig/Pågår/Reservert.
- Brukerflyt for innsjekk/påmelding er forbedret i åpen PR #384, men krever samlet TEST UAT før utrulling. Ingen PROD-mutasjoner som en del av visuell UX-review.

## 1. Medlem og spiller: 12 tilstander

| Scenario | Brukerens spørsmål | Foreslått primærhandling / kriterium |
|---|---|---|
| P01 Uinnlogget | Hvordan kommer jeg i gang? | Én tydelig «Logg inn / Bli medlem» med forståelig forskjell |
| P02 Ny konto | Hva skjer med profilen min? | Bekreft identitet, klubbtilknytning og neste steg uten å hoppe frem og tilbake |
| P03 Medlem, kontingent OK | Kan jeg spille? | «Meld meg på» når åpen, synlig turneringsdato og status |
| P04 Forfalt kontingent | Er jeg blokkert? | Oppgi *faktisk* tilgang og betalingshandling, ikke bare rød generell feil |
| P05 Påmelding venter | Gikk trykket gjennom? | Busy på knappen, ingen doble POST; bekreft suksess før «Påmeldt» |
| P06 Venteliste | Må jeg gjøre noe? | Venteliste med status og «ingen handling» i stedet for aktiv innsjekk |
| P07 Påmeldt – innsjekk stengt | Når kan jeg sjekke inn? | Tydelig tidspunkt og deaktivert innsjekk med forklaring |
| P08 Innsjekk åpen | Hvor gjør jeg det? | Hjem og turneringsdetalj åpner **samme** kode/admin-port, inline feil på feil kode |
| P09 Innsjekket | Hva gjør jeg nå? | Én tydelig status «Innsjekket – vent på oppkalling» uten ny innsjekkknapp |
| P10 Kamp tildelt | Hvilken skive? | Skive, motstander, runde og om kampen er klar/pågår |
| P11 Kamp ferdig | Hvordan gikk det? | Resultat fra canonical DB, statistikk og ELO med forståelig oppdateringsstatus |
| P12 Nettfeil / mobil Safari | Mistet jeg handlingen? | Behold token og forrige status ved GET-timeout; avklar usikker mutation uten automatisk retry |

For hver tilstand: vurder **forståelighet (0–2)**, **antall trykk (0–2)**, **tilbakemelding (0–2)**, **mobil layout (0–2)** og **tilgjengelighet (0–2)**, maks 10. Dokumentér skjermbilde, handling, faktiske API-statuskoder og friksjon. Prioritér ingen P0 eller score under 8/10 før PROD.

## 2. Turneringsleder: 12 driftsforløp

| Scenario | Hva må oppleves |
|---|---|
| T01 Klargjøre | Oversikt over innmeldte, ikke sjekket inn, venteliste og gjester |
| T02 Kontrollere innsjekk | Umiddelbar status, admin-only/kode og avmeldinger tydelig |
| T03 Trekke grupper | Enkelt se format, antall spillere, grupper og forhåndsvisning |
| T04 Velge skiver | Fysisk skiveidentitet, manuell/Scolia, tilgjengelig/defekt |
| T05 Start turnering | Bekreft før endelig start, tydelige forutsetninger |
| T06 Opprop | Kamp i kø, opptatt skive, ledig skive, neste kamp og ventende |
| T07 Flytt **ikke påbegynt** kamp | Eksplisitt velg målskive → se «fra → til» → flytt → serverbekreftet ny plassering |
| T08 Flytt **pågående** kamp | Bekreft spillerne, gammel/ny skive, at legs/kast beholdes |
| T09 Opptatt/reservert målskive | Må ikke kunne velges; forklar hva som må frigjøres |
| T10 Samtidig oppdatering | Valgt skive beholdes mens turneringsstatus hentes; ved konflikt kreves nytt valg |
| T11 Nettfeil etter POST | Ikke si «flytting feilet» hvis POST var bekreftet og bare etterfølgende GET feilet |
| T12 Kampresultat og neste | Canonical resultat → Live/kiosk/spillerportal konsistent, aldri dobbeltkall |

Spesielt T06–T11 skal gjentas på **mobil (375/412 px), iPad/nettbrett (768/820 px) og desktop (1440 px)**. Touch-mål minst 44px. Utfør minst én flytting med *alle fire skiver opptatt eller reservert*, én med bare én ledig skive, og én med aktiv kamp der bekreftelse avbrytes.

### UX-prinsipp for kampflytting

**Bruk eksplisitt velg-skive → forhåndsvisning → bekreft**, fremfor obligatorisk drag-and-drop. Det er mer presist på mobil/nettbrett og lar oss verifisere busy/reservation på serveren. Eventuell dra-og-slipp på desktop kan komme senere som et alternativ, men må dele samme backend-validering og kunne angres kontrollert.

## 3. Realistisk testarena og bevis

Bruk isolert `bd_test_`-turnering med to autoriserte spillere, én turneringsleder og to nettlesere. TEST identitet/hardware leses fra `bd_prod_` kun lesing. Ingen skriving til PROD equipment, kontingent eller spilleridentitet.

**Automatisk:**
- `Admin Equipment Browser QA` kjører faktisk Equipment React-komponent med mockede API-svar på 375, 768 og 1440px, tester dialog, navigasjon og delvis API-feil. Dette er *visuell/funksjonell mock-test*, ikke PROD-dataverifikasjon.
- Backend `admin-equipment-move-ux.test.mjs` verifiserer skivevalg/eksakt ID, bevaring ved refresh, reservert/busy og feil etter POST.
- Eksisterende kiosk-testpakke PR #387 og spillerportal-/Live-pakke PR #386 gir supplerende skjermbilder, men er ikke PROD signoff.

**Reell UAT på TEST:**
1. P01–P12 på mobil med minst én virkelig innlogget konto og forhåndsavklart medlems-/betalingsstatus.
2. T01–T12 med faktiske TEST-turneringsdata og en admin som flytter kamper mellom ulike skiver.
3. Observer API-tid, tidspunkt for serverkvittering og oppdatering i kiosk/Live/player. Test avbrutt WebSocket og 502.
4. Ta screenshots i riktig rekkefølge. Sladd persondata, tokens, kontingentdetaljer og innsjekkkoder før deling.
5. Prioriter P0 blokkerende feil og P1 distraherende feil; lag separate issues med *reproduksjon, forventet/faktisk, video/screenshot, API-status og release SHA*.

**Status akkurat nå:** kodegjennomgang + konkret Utstyr- og kampflyttingsendring i egen PR. Den endelige spiller-/medlem-UX-dom krever browser UAT og får ikke «bestått» ut fra kildekode alene.
