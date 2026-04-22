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

## External Mapping Model

Use a generic mapping table instead of scattering provider IDs across domain tables.

Suggested fields:

- `external_system`
- `external_entity_type`
- `external_id`
- `internal_id`
- `sync_state`
- `last_synced_at`

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
