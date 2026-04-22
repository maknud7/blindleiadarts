# Project Handover

## Goal

Build a production-ready dart tournament platform for Blindleia Dartklubb with three main surfaces:

- kiosk tablets at each board
- public screen / venue display
- club admin backoffice

The runtime must work locally inside the venue without depending on Challonge or Darts Atlas. External systems should be treated as integrations, not core dependencies.

## Product Vision

The platform should support the full venue match flow:

- assign matches to boards and kiosks
- let players register visits on a kiosk
- keep live match state in sync
- show current and upcoming matches on a public screen
- maintain ELO and Order of Merit rankings
- support club branding, sponsor branding, and future multi-club usage

## Current Deployment Shape

- `ingenting.org/BD/` -> main project root
- `ingenting.org/BD/api/` -> PHP API
- `kiosk.ingenting.org` -> `/www/BD/kiosk/`
- `screen.ingenting.org` -> `/www/BD/screen/`

If hosting remains PHP-first, preserve that operational reality while still separating app surfaces, domain rules, connectors, and infrastructure.

## Recommended Next Steps

1. Stabilize kiosk match lifecycle.
2. Ensure match completion transitions to idle or next match.
3. Confirm averages and countdown overlay on win.
4. Clean API response contracts.
5. Build admin pages for club logo and kiosk sponsor logo.
6. Add upload and storage conventions for images.
7. Build the generic provider framework.
8. Implement Challonge as the first provider.

## Working Rules For Future Contributors

- Preserve generic provider boundaries.
- Avoid direct Challonge coupling in UI or core domain logic.
- Write migrations separately from application code.
- Keep API responses stable and versionable.
- Prefer small, reviewable commits.
