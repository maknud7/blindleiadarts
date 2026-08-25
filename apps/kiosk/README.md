# Board Terminal / Kiosk

Fast nettbrett ved én fysisk dartskive.

## Førstegangsoppsett

1. Åpne samme `/kiosk/`-URL på alle nettbrett.
2. Terminalen oppretter automatisk en anonym, kortlivet pairingkode og viser QR-kode.
3. En klubbadmin scanner QR-koden med mobilen.
4. QR-en åpner Admin med pairingkoden ferdig utfylt. Innlogging kreves hvis admin ikke allerede er innlogget.
5. Admin velger fysisk board og trykker «Koble til board».
6. Først ved denne godkjenningen blir terminalen knyttet til klubb + board.
7. Nettbrettet husker boardet og bruker et sikkert device-token videre.

Ingen klubbkode skrives inn på nettbrettet. Klubbtilhørigheten bestemmes av den autentiserte adminen som claimer terminalen.

## Turneringsflyt

1. Blindleia oppretter kampene i egen turneringsmotor og lagrer lokale kamp-ID-er.
2. Kampen tildeles et lokalt `kiosk_id` / board i Blindleia.
3. Kampen dukker automatisk opp på riktig Board Terminal.
4. Ved manuell scoring registreres sum eller hver pil på terminalen.
5. Ved `scolia` scoring mode er terminalen fortsatt board-/kampvisning, mens scoringinput skal komme fra Scolia-adapteren i fase 2.

## Funksjoner

- permanent board-pairing
- QR/claim-basert førstegangsoppsett
- kortlivet 6-tegns pairingkode
- admin bestemmer klubb og board
- lokal kamp-ID → lokal `kiosk_id` / board-tildeling
- idle / assigned / in-progress tilstander
- start kamp
- 501 double-out
- sum-input
- per-pil-input
- bust-validering
- checkout med 1/2/3 piler
- undo siste visit
- siste visits i kampen
- SSE live-oppdatering med polling fallback
- manuell / Scolia scoring mode
- nullstilling og ny pairing fra admin

Blindleia Core eier kampene, boardkoblingen og scoringhistorikken. Eksterne scoringskilder er valgfrie adaptere og skal ikke eie nettbrettet, kamp-ID-en eller resultatet.
