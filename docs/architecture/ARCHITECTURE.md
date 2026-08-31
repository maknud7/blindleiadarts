# Architecture

## High-Level Principles

### API-first

All frontends communicate with the internal API only. No frontend should talk directly to the database or to external tournament systems.

### Internal domain first

Core entities such as club, season, tournament, kiosk, match, leg, visit, and ranking belong to the local domain model and should remain the source of truth.

The same approach extends to member accounts, tournament registrations, member payments, and club operations data. Those should be internal platform domains rather than external side systems.

### Reuse before duplication

If the same data, meaning, calculation or interaction already exists, reuse the canonical implementation. A new variant is justified only when the semantics or behavior genuinely differ.

This applies especially to match cards, player links, status labels, statistics, ranking rules, tournament metadata and shared workflows. Surface-specific code should normally add layout/context rather than duplicate business logic.

### Connector pattern

External systems should implement bounded provider/integration contracts instead of leaking provider details into the rest of the codebase. Blindleia Darts remains canonical at runtime.

### Event-oriented design

Important state transitions should be modeled around explicit domain events, even if execution is still synchronous.

### Venue runtime independence

Imported tournament data, live match state, rankings, and public display data must remain usable when an upstream provider is unavailable.

### User guides are part of the product contract

Player- and admin-facing behavior must be reflected in the in-product user guides. Before every Git push, the diff must be reviewed for guide impact.

The canonical guide content lives in `packages/ui-assets/user-guide.js`; the maintenance process lives in `docs/user-guides/README.md`.

A user-visible change is not complete until one of these has been decided:

- `Guide impact: updated`
- `Guide impact: none`

The review must cover workflow, navigation, terminology, status semantics, permissions, rankings/statistics, tournament rules, membership/payment behavior, equipment/Scolia and Live behavior.

## Suggested Module Boundaries

### `apps/api`

- API endpoints
- application services
- orchestration of domain and integration workflows

### `packages/domain`

- entities
- value objects
- state machine rules
- shared schemas

### `packages/connectors`

- provider interfaces
- provider-specific mappers
- sync/import jobs
- webhook receivers
- optional result publishing

### `packages/ui-assets`

- canonical shared UI components
- common navigation and shell behavior
- shared player links and match details
- in-product player/admin user guides

## Suggested Bounded Contexts

Keep these areas separated even if they start inside the same PHP codebase:

### Venue Runtime

- kiosk state
- live matches
- legs and visits
- public screen data

### Competition Management

- tournaments
- tournament players
- assignments
- groups and playoffs
- rankings
- integrations/imports

### Member Portal

- user login and activation
- member profile
- tournament registration/check-in
- personal stats and history
- membership/payment self-service

### Club Operations

- membership status
- payment tracking
- equipment administration
- grasrotandel follow-up
- bookkeeping support
- future reporting exports

The important design choice is that venue runtime should not depend on finance or member administration to function during a tournament.

## Core Events

- `tournament.created`
- `match.assigned`
- `match.started`
- `visit.recorded`
- `leg.finished`
- `match.finished`
- `ranking.updated`

## Integration Flow

1. Data may be created locally or imported from an external source.
2. External identifiers are mapped to local/canonical entities.
3. Internal tables own participants, matches, legs, visits and results.
4. Kiosk, player portal and Live consume only internal data at runtime.
5. Match completion updates canonical results/statistics/ELO.
6. Publishing back to an external provider, when supported, is optional and must not change the canonical ownership model.

## Surface Responsibilities

### Kiosk

- consume assigned match state for a board
- record visits and checkout data
- present idle mode when no match is assigned

### Live / Screen

- render current matches by board
- show upcoming matches
- display tables, playoffs, ELO, highlights and venue branding
- omit unplayed players from ranking/statistical lists

### Admin

- manage clubs, seasons, equipment, players/members and tournaments
- lead tournament workflow from setup/check-in through completion
- manage integrations and operational health

### Player Portal

- sign in and manage personal account
- register/check in for tournaments
- view groups, matches and results
- use canonical player profiles and match cards
- view statistics, ELO, membership and payment status
