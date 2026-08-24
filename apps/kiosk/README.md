# Board Terminal / Kiosk

Fast nettbrett ved én fysisk dartskive.

## Flyt

1. Åpne samme `/kiosk/`-URL på alle nettbrett.
2. Tast klubbkoden fra Admin → Kiosker / boards.
3. Start pairing på nettbrettet.
4. Godkjenn pairing i admin og velg fysisk board.
5. Nettbrettet husker boardet lokalt og bruker pairing-token videre.
6. Når en kamp får samme boardnummer, vises kampen automatisk på terminalen.
7. Ved manuell scoring registreres sum eller hver pil på terminalen.
8. Ved `scolia` scoring mode er terminalen fortsatt board-/kampvisning, mens scoringinput skal komme fra Scolia-adapteren i fase 2.

## Funksjoner

- fast board-pairing
- pairing requests med admin-godkjenning
- DartsAtlas `board_number` → lokal `kiosk_id` mapping
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

Blindleia Core eier boardkoblingen. DartsAtlas/Scolia er datakilder og skal ikke eie nettbrettet direkte.
