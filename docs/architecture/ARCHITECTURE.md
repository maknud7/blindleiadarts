# Architecture

## High-Level Principles

### API-first

All frontends communicate with the internal API only. No frontend should talk directly to the database or to external tournament systems.

### Internal domain first

Core entities such as club, season, tournament, kiosk, match, leg, visit, and ranking belong to the local domain model and should remain the source of truth.

The same approach should later extend to member accounts, tournament registrations, member payments, and club operations data. Those should become internal platform domains rather than external side systems.

### Connector pattern

External systems such as Challonge should implement generic provider contracts instead of leaking provider details into the rest of the codebase.

### Event-oriented design

Important state transitions should be modeled around explicit domain events, even if execution is still synchronous.

### Venue runtime independence

Imported tournament data, live match state, rankings, and public display data must remain usable when the upstream provider is unavailable.

## Suggested Module Boundaries

### `apps/api`

- API endpoints
- application services
- orchestration of domain and connector workflows

### `packages/domain`

- entities
- value objects
- state machine rules
- shared schemas

### `packages/connectors`

- provider interfaces
- provider-specific mappers
- sync jobs
- webhook receivers
- result publishing

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
- rankings
- connector synchronization

### Member Portal

- user login
- member profile
- tournament registration
- personal stats and history

### Club Operations

- membership status
- payment tracking
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

## Example Connector Flow

1. Admin creates a tournament.
2. Admin selects provider `challonge`.
3. The system stores provider metadata locally.
4. Import jobs fetch participants and bracket structure.
5. Internal tables are populated.
6. Kiosk and screen operate only on internal tables.
7. Match completion may optionally publish results back through the connector.

## Surface Responsibilities

### Kiosk

- consume assigned match state for a board
- record visits and checkout data
- present idle mode when no match is assigned

### Screen

- render current matches by board
- show upcoming matches
- display rankings and venue branding

### Admin

- manage clubs, seasons, kiosks, players, tournaments, providers, and media

### Future Member Portal

- sign in and manage personal account
- register for tournaments
- view own match history and statistics
- view membership and payment status
