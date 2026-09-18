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

Longer term, the same platform should also support player/member self-service and broader club operations such as registrations, personal statistics, membership payments, grasrotandel follow-up, and bookkeeping-related workflows.

## Current Deployment Shape

- Domeneshop hosts frontend/static assets, canonical MySQL and domain/DNS.
- Render hosts backend-v2 Node/TypeScript runtime.
- `develop` is the canonical development branch.
- The migration target is zero PHP application logic while keeping canonical MySQL on Domeneshop.

## Recommended Next Steps

1. Stabilize kiosk match lifecycle.
2. Ensure match completion transitions to idle or next match.
3. Confirm averages and countdown overlay on win.
4. Clean API response contracts.
5. Build admin pages for club logo and kiosk sponsor logo.
6. Add upload and storage conventions for images.
7. Continue moving active PHP application routes into backend-v2 or delete them when the surface is retired.
8. Keep external providers optional and bounded; do not add a provider runtime without an active product need.
9. Continue member login and registration work without coupling shared identity writes to TEST runtime.
10. Continue club-operations support for payments and bookkeeping without coupling it to kiosk runtime.

## Working Rules For Future Contributors

- Keep optional external integrations bounded and outside canonical runtime truth.
- Do not reintroduce retired Challonge runtime without an explicit active product requirement.
- Write migrations separately from application code.
- Keep API responses stable and versionable.
- Prefer small, reviewable commits.
