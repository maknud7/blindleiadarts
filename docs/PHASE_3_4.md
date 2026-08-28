# Plattformløft – fase 3 og 4

## Fase 3 – Live & lokalopplevelse v2

Målet er at turneringslederen, skiveterminalene, live-skjermen og spillerne opplever én sammenhengende turnering. Blindleia Core er canonical; skjermene er sanntidsprojeksjoner av samme kamp- og turneringsstatus.

### Første leveranse: Venue Screen v2

- Én 16:9-visning uten scrolling på vanlige venue-skjermer.
- «Nå» først: aktive skiver, score, legs og hvem som kaster.
- «Neste opp»: kampkø med tydelig skive når kampen er kalt opp.
- Turneringens fase og fremdrift i headeren.
- Offisiell gruppetabell med poeng → leg differanse → 3DA → innbyrdes.
- Sluttspill erstatter gruppetabellen som hovedkontekst når turneringen går over i playoff.
- Siste resultater og kompakt livepuls nederst.
- Event-overlay for 180, checkout, ferdig kamp og overgang til sluttspill.
- Venue Screen henter den rike canonical live-modellen som allerede brukes av Blindleia Live i tillegg til den board-spesifikke screen-modellen.

### Neste leveranser i fase 3

1. Skiveterminal: tydeligere call-up/etter-kamp-flyt, og automatisk overgang fra «ferdig» til neste tildelte kamp.
2. Spillerportal «Akkurat nå»: skive, motstander, køstatus og spillerpause i samme live-kort.
3. Turneringsadmin ↔ venue: samme kø/status/varsler på tvers av admin, skjerm og kiosk.
4. Robusthet: offline-/stale-indikator, screen/kiosk-smokes og bedre recover ved nettverksbrudd.
5. Eventmodus: finalemodus, vinnerpresentasjon og kontrollert visning av relevante live-highlights.

## Fase 4 – Automatisering & orkestrering

Fase 4 skal redusere behovet for at turneringsleder må «trykke systemet videre». Automatiseringene skal være hendelsesdrevne, idempotente og auditerbare, med menneskelig godkjenning der en handling er vanskelig å reversere.

### Automatiseringer vi sikter mot

- **Før turnering:** preflight av skiver, kiosker og venue screen; åpne check-in etter regel; varsle om manglende utstyr eller oppsett.
- **Kampflyt:** når en skive blir ledig, velg neste gyldige kamp ut fra kø, check-in, spillerpause og om spillerne er opptatt; kall spillerne opp og oppdater alle flater samtidig.
- **Faseovergang:** når siste gruppespillkamp er ferdig, valider tabellen, marker eventuelle tie-breaks, opprett sluttspill og gjør bracket klar. Automatisk publisering kan kreve godkjenning fra turneringsleder.
- **Etter kamp:** oppdater tabell, 3DA/statistikk, ELO og spillerhistorikk; frigjør skiven; generer relevante live-events; hent neste kamp.
- **Etter turnering:** valider at alle kamper/legs er komplette, ferdigstill turneringen, fryse sluttresultat, oppdatere sesong, og lage utkast til oppsummering/Facebook-post.
- **Drift:** oppdag skiver som er offline, kamper som står fast, score/ELO-inkonsistens eller en skjerm som ikke har oppdatert seg, og løft bare reelle avvik til admin.
- **Integrasjoner:** Scolia blir en score-provider inn i samme hendelsesmodell. Resync og duplikatbeskyttelse skal skje automatisk uten å endre canonical match-ID.
- **Klubbadmin:** senere kan samme motor brukes til medlems-/betalingsoppfølging og andre repeterende klubboppgaver, men turneringsautomatisering prioriteres først.

### Guardrails

- Én canonical eventlogg for alle automatiske handlinger.
- Idempotency-key per trigger/handling, slik at samme event ikke kjøres to ganger.
- Dry-run/simulering for nye regler.
- Tydelig «automatisk» vs «manuelt» i audit-loggen.
- Undo/reconcile der det er mulig.
- Godkjenning før irreversible eller sportslig sensitive overganger, særlig publisering av sluttspill hvis tie-break ikke er entydig.
