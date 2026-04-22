# Blindleia Dartkiosk

Production-oriented tournament platform for Blindleia Dartklubb with three primary surfaces:

- kiosk tablets at each board
- public screen / venue display
- club admin backoffice
- future member portal for players and club members

The platform is designed to run the venue locally without depending on Challonge or other external systems at runtime. External systems are supported through generic provider connectors.

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
- Provider boundaries: Challonge and future systems plug in through generic adapters.
- Event-oriented design: state changes should align with explicit domain events.
- Venue runtime independence: local tournament operations must continue without external availability.

## Current Product Surfaces

- `apps/api`: internal API and domain orchestration, currently expected to stay PHP-friendly.
- `apps/kiosk`: match input UI for each board kiosk.
- `apps/screen`: public venue display for live boards and rankings.
- `apps/admin`: future club admin backoffice.
- future member-facing login area for registrations, stats, and member self-service.

## Priority Roadmap

1. Stabilize kiosk match lifecycle.
2. Ensure match completion transitions cleanly to idle or next assignment.
3. Confirm averages and countdown overlay on win.
4. Clean and version internal API contracts.
5. Add admin media upload flows for club and sponsor branding.
6. Introduce generic provider framework.
7. Implement Challonge as the first connector.
8. Add member login, tournament registration, and personal stats.
9. Expand the platform toward club operations such as payments and bookkeeping support.

## Milestones

- Milestone 1: Core runtime
- Milestone 2: Admin basics
- Milestone 3: Rankings
- Milestone 4: Challonge connector

## Key Rule

Keep the core match engine local. Connector logic must not leak provider-specific assumptions into UI or domain code.

## Deployment

GitHub-first deployment files are included for:

- automatic deploy from `develop` to test
- manual deploy from GitHub Actions to production
- manual database migrations for test and production using table prefixes in one shared database

Setup details are documented in `docs/handover/GITHUB_DEPLOY_SETUP.md`.

## Longer-Term Product Scope

The platform is expected to grow beyond venue runtime into a broader club system with:

- player and member login
- tournament signup and self-service
- personal statistics such as averages, checkout data, and ELO
- member payment tracking
- grasrotandel follow-up
- bookkeeping and club operations support

These capabilities should be added as separate bounded areas around the same core platform rather than folded directly into kiosk-specific runtime code.
