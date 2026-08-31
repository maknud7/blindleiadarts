# Blindleia Dartkiosk

Production-oriented tournament platform for Blindleia Dartklubb with three primary surfaces:

- kiosk tablets at each board
- public screen / venue display
- club admin backoffice
- player and member portal

The platform is designed to run the venue locally without depending on Challonge, DartsAtlas or other external systems at runtime. External systems are supported through bounded integrations while Blindleia Darts remains canonical.

## Repository Shape

```text
/apps
  /api
  /kiosk
  /screen
  /admin
  /player
/packages
  /domain
  /connectors
  /ui-assets
/docs
  /architecture
  /handover
  /api
  /db
  /user-guides
/infra
  /sql
  /deploy
```

## Core Principles

- API-first: all frontends talk to the internal API only.
- Internal domain first: local entities and rules are the source of truth.
- Provider boundaries: external systems plug in through bounded adapters and must not become runtime truth.
- Event-oriented design: state changes should align with explicit domain events.
- Venue runtime independence: local tournament operations must continue without external availability.
- Reuse before duplication: when the same domain data, meaning, calculation or interaction already exists elsewhere in the platform, reuse the existing canonical API field, calculation, component or UI pattern instead of creating a parallel variant. Only introduce a new variant when the context genuinely requires different semantics or behavior, and document why.
- Shared domain concepts should look and behave consistently across surfaces. A match card, player link, statistic or status with the same meaning should have one canonical implementation where practical, with surface-specific wrappers limited to layout or context rather than duplicated business logic.
- User documentation is part of the product contract. A change to user-visible behavior is not complete until its player/admin guide impact has been reviewed.

## Current Product Surfaces

- `apps/api`: internal API and domain orchestration, currently PHP-friendly.
- `apps/kiosk`: match input UI for each board kiosk.
- `apps/live` / screen surfaces: public venue display for live boards, queues, tables, playoffs, ELO and highlights.
- `apps/admin`: club administration and tournament operations.
- `apps/player`: member/player portal for tournaments, statistics, profiles, membership and self-service.

## Key Rule

Keep the core match engine and canonical competition data local. Connector logic must not leak provider-specific assumptions into UI or domain code.

Before adding a new calculation, field, component or interaction for an existing concept, search for an existing canonical implementation and reuse it when the semantics are the same.

## Mandatory pre-push user-guide check

Before **every Git push**, review whether the diff changes anything a player or club administrator needs to understand: workflow, navigation, terminology, permissions, status rules, tournament behavior, match/stat data, membership/payment behavior, equipment or Live.

The canonical in-product guides live in `packages/ui-assets/user-guide.js`. The maintenance checklist and decision rules live in `docs/user-guides/README.md`.

Every push must end with one explicit conclusion:

- `Guide impact: updated` – the guide was changed together with the user-visible behavior.
- `Guide impact: none` – the diff was reviewed and does not change how a player or admin uses or understands the platform.

Do not push first and update the guide afterwards. The guide-impact review belongs in the same logical change.

## Deployment

GitHub-first deployment files are included for:

- automatic deploy from `develop` to TEST
- manual deploy from GitHub Actions to production
- database migrations for test and production using table prefixes in one shared database

Setup details are documented in `docs/handover/GITHUB_DEPLOY_SETUP.md`.

## Product Scope

The platform covers and continues to expand around:

- player/member login and activation
- tournament signup, check-in and self-service
- groups, matches, playoffs and canonical scoring
- player statistics, averages and ELO
- club member payment tracking
- equipment and Scolia integration
- public Live/venue display
- club operations and future reporting support

These capabilities should remain separate bounded areas around the same canonical core rather than becoming duplicated side systems.
