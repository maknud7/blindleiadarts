# Phase 3 – konto, identitet og mobilapp

## Konto og eksisterende spiller

Spillerkontoen er en innlogging til den canonical spilleren – ikke en ny spilleridentitet. Dersom et medlem eller en spiller allerede finnes, skal onboarding koble brukerkontoen til eksisterende `member_id`/`player_id` slik at kamper, ELO og statistikk beholdes.

Selvregistrering via generell invitasjon går derfor til godkjenning hos klubbadmin. Admin velger eksplisitt hvilket medlem registreringen skal kobles til. En spesifikk medlemsinvitasjon kobles direkte til medlemmet som invitasjonen ble opprettet for.

UX-prinsipp: spilleren skal aldri måtte forstå interne ID-er eller velge mellom duplikate spillerprofiler. Teksten i spillerportal og onboarding skal eksplisitt fortelle tidligere spillere at historikken følger med.

## PWA

Spillerportalen er installérbar som PWA med Blindleia Dartklubbs faktiske logo. Manifestet starter på spillerportalens Hjem-visning og bruker standalone display. På iOS vises veiledning for Safari → Del → Legg til på Hjem-skjerm; støttede nettlesere bruker `beforeinstallprompt`.

Service worker cacher kun app-shell og statiske ressurser. API-kall og forespørsler med Authorization-header går alltid til nettverket og lagres ikke i PWA-cachen.

## Neste fase-3-bolk

Konto/PWA er fundamentet for neste liveflyt: spillerens «Akkurat nå», kampoppkalling til mobil, kiosk og venue-skjerm, samt samme kø i turneringsadmin. Fase 4 kan deretter automatisere denne kjeden hendelsesdrevet.
