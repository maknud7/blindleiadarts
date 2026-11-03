# Kiosk v2 – failsafe layout for mixed club tablets

## Contract

Kiosk v2 aims to fit the familiar portrait tablet view, but **saving a visit must never depend on a keypad that is cropped or inaccessible**. The new last-loaded `kiosk-responsive-failsafe.css` and `useKioskViewportSafety.ts` provide the following behavior:

- **Fit** layout is preserved when viewport and content fit the tablet. Desktop test retains the 3:4 portrait canvas.
- **Scroll-safe** mode is activated automatically for a narrow/short/landscape viewport, or whenever card/scoreboard content is detected beyond available height. It is stable under frequent canonical updates, not toggled on each 1.5-s poll. It lets the match grow and scrolls **inside the kiosk**, not the browser page.
- In **Innstillinger**, **Vis alle knapper (sikker visning)** forces scroll-safe layout and **Bruk automatisk visning** restores automatic detection. Preference is saved only in this terminal's localStorage (`bd:kioskSafeLayout`), not in a DB or club setting.
- Four latest visits remain accessible even on narrow devices. Core score keys have >=44 CSS px minimum hit areas; scroll mode uses larger 52px keys.
- Error messages, pairing chooser, Scolia status, check-out dialog and visit editor may scroll; they should not obscure buttons.
- Pending visit requests visibly say **Lagrer … ikke bekreftet**; completion UI says **AVVENTER RESULTAT** while server confirmation is absent. No next-match mutation is issued before `completion.confirmed`, and post-match status is rechecked every 2 seconds while unconfirmed.
- Initial boot also waits for an authoritative `/state` response before polling `/next-match`, avoiding premature canonical mutations while the first request is still in flight.

## PROD and TEST boundary

PROD `/kiosk/` **remains the launcher only**: Innstillinger → Start testmodus loads `https://test.blindleiadarts.ingenting.org/v2/kiosk/` in a protected iframe and selects a TEST alias for one physical board. New kiosk v2 CSS and React changes are deployed to TEST via canonical `develop`/Deploy Test, **not** PROD. Changes to PROD kiosk launcher are neither necessary nor intended.

TEST uses `bd_test_` for tournament/canonical scoring, reads physical board identity/hardware from `bd_prod_` without writing back. Production kiosk unpaired boot can create a pairing request, so do not automate PROD loading without reviewed authorization. Use the normal supervised entry from a paired kiosk.

## Required visual and behavior sign-off on TEST

| Viewport | Expected |
| --- | --- |
| 500 × 720 CSS px | Internal safe scroll; every scoring button and undo accessible |
| 600 × 960 | Preferred single-screen tablet if no warnings; fallback when extra notices appear |
| 768 × 1024 | Preferred tablet fit, four recent visits, 44px touch targets |
| 820 × 1180 | Tablet fit with correct player alignment |
| 1024 × 600 landscape | Automatic safe scroll; no keyboard or checkout clipped |
| 1440 × 900 desktop | 3:4 portrait kiosk canvas as before |
| Browser keyboard / shorter visualViewport | Switch to safe scroll without losing pending score |
| Scolia alert + pending queue + long player names | All alerts and action buttons remain reachable |

Within each viewport check **assigned → start → sum → per-dart → bust → checkout → edit of last four → pending save → confirmed completion → next match**. Verify the manual override and reload persistence. Also test the entire UI after switching back to automatic mode.

**Automated browser QA:** `Kiosk Responsive Browser QA` runs Chromium with actual kiosk React/CSS and **intercepts every `/api/*` request locally**; it tests six viewports plus the persistent manual safe layout, captures screenshots and requires no credentials/PROD/TEST DB. This verifies UI interaction and layout only, not true end-to-end scoring or physical tablets.

**Not yet done:** Real on-device/tablet UAT or an actual TEST rollout. Passing local browser QA is not PROD cutover approval. Track in #385; do not promote to PROD before sign-off.
