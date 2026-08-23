# Blindleia Dartkiosk

Production-oriented tournament platform for Blindleia Dartklubb with three primary surfaces:

- kiosk tablets at each board
- public screen / venue display
- club admin backoffice

The platform is designed to run the venue locally without depending on external tournament systems at runtime. External systems are supported through generic provider connectors.

## Repository Shape

```text
/apps
  /api
  /kiosk
  /screen
  /admin
/packages
  /domain
  /connectors
  /ui-assets
/docs
  /architecture
  /handover
  /api
  /db
/infra
  /sql
  /deploy
```

## Core Principles

- API-first: all frontends talk to the internal API only.
- Internal domain first: local entities and rules are the source of truth.
- Provider boundaries: external systems plug in through generic adapters.
- Event-oriented design: state changes should align with explicit domain events.
- Venue runtime independence: local tournament operations must continue without external availability.

## Current Product Surfaces

- `apps/api`: internal API and domain orchestration, currently expected to stay PHP-friendly.
- `apps/kiosk`: match input UI for each board kiosk.
- `apps/screen`: public venue display for live boards and rankings.
- `apps/admin`: club admin backoffice.

## Priority Roadmap

1. Darts Atlas phase 1: tournament/match sync and Blindleia Live state.
2. Link Darts Atlas player identities to the existing `medlemmer` register.
3. Build the venue screen on the internal live-state API.
4. Import historical Darts Atlas data for rankings, records and statistics.
5. Scolia phase 2: ingest visit/dart events without changing the core identity model.
6. Add other provider adapters such as Challonge only where they add value.

## Key Rule

Keep the core match and identity model local. Connector logic must not leak provider-specific assumptions into UI or domain code.

## Deployment

GitHub-first deployment files are included for:

- automatic deploy from `develop` to test
- manual deploy from GitHub Actions to production
- manual database migrations for test and production using table prefixes in one shared database

Setup details are documented in `docs/handover/GITHUB_DEPLOY_SETUP.md`.
