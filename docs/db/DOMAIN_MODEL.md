# Domain Model And Database Direction

## Core Entities

- `Club`
- `Season`
- `Tournament`
- `TournamentPlayer`
- `Kiosk`
- `Match`
- `Leg`
- `Visit`
- `RankingSnapshot`
- `ConnectorSyncJob`
- `ExternalReference`

## Planned Future Entities

These are not part of the first runtime slice, but the data model should leave room for them:

- `UserAccount`
- `MemberProfile`
- `MembershipPeriod`
- `TournamentRegistration`
- `PlayerStatisticSnapshot`
- `Payment`
- `PaymentAllocation`
- `LedgerEntry`
- `RevenueSource`
- `GrassrootsContribution`

## Current / Expected Tables

- `clubs`
- `seasons`
- `tournaments`
- `players`
- `matches`
- `legs`
- `visits`
- `kiosks`
- `settings`
- `kiosk_sessions`
- ranking tables

## Recommended Additional Tables

- `external_references`
- `connector_sync_jobs`
- `webhook_events`
- `tournament_players`
- `ranking_snapshots`

## Recommended Future Tables

- `user_accounts`
- `member_profiles`
- `membership_periods`
- `tournament_registrations`
- `player_statistic_snapshots`
- `payments`
- `payment_allocations`
- `ledger_entries`
- `revenue_sources`
- `grassroots_contributions`

## External Mapping Model

Use a generic mapping table instead of scattering provider IDs across domain tables.

Suggested fields:

- `external_system`
- `external_entity_type`
- `external_id`
- `internal_id`
- `sync_state`
- `last_synced_at`

## Future Member And Finance Direction

Important principle:

- tournament runtime and venue operations should stay usable even if member portal or finance features are unavailable

Recommended links between domains:

- a `UserAccount` may be linked to one `MemberProfile`
- a `MemberProfile` may be linked to one `Player`
- a `TournamentRegistration` links a member or player to a tournament before match creation
- `Payment` and `LedgerEntry` should be club-operation records, not embedded into tournament tables

This separation makes it easier to replace today's club-management setup gradually without blocking tournament work.

## Media Direction

Shared storage strategy:

- `/www/BD/static/club-logos/`
- `/www/BD/static/sponsors/`
- `/www/BD/static/players/avatars/`

Suggested DB columns:

- `clubs.logo_url`
- `kiosks.sponsor_logo_url`
- `kiosks.sponsor_label`
- `players.avatar_url`
- `tournaments.max_visits_per_leg`

## Minimum Useful Test Data

To exercise a real match flow, keep these records consistent:

- one club
- one season
- one tournament
- two players
- one kiosk
- one assigned match on that kiosk
- `settings.active_tournament_id`
