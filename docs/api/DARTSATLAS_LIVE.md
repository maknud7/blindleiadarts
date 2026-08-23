# DartsAtlas Live Adapter

## Goal

Use DartsAtlas as the tournament/score source in phase 1 while keeping Blindleia's own database as the stable internal model for members, players, matches, rankings and venue displays.

Scolia is deliberately phase 2. The existing `legs` and `visits` model is retained so dart-level input can be added later without redesigning the player/match identity model.

## Existing tables reused

The initial core migration already contains:

- `clubs`
- `seasons`
- `tournaments`
- `players`
- `tournament_players`
- `matches`
- `legs`
- `visits`
- `ranking_snapshots`
- `external_references`
- `connector_sync_jobs`

Migration `0002_dartsatlas_live.sql` adds only the fields/tables needed for the live connector:

- `players.member_id`, `member_link_source`, `member_linked_at`
- `matches.provider_metadata`
- `connector_resources`
- `match_statistics`
- `live_match_states`

## Identity model

Do not use a person's name as permanent identity.

- DartsAtlas player ID -> `external_references`
- local dart player -> prefixed `players.id`
- club member -> existing `medlemmer.id`
- `players.member_id` joins the dart identity to the member registry

The importer may automatically connect a player to a member only when the normalized full name has exactly one exact match in `medlemmer`. Fuzzy matches are intentionally left unmatched for manual review.

There is no database foreign key to `medlemmer` in migration 0002. The member registry predates the dart schema and should first be verified in production with `dartsatlas_doctor.php` before a cross-schema constraint is considered.

## Data acquisition

The connector is isolated under `packages/connectors/DartsAtlas`.

It uses public DartsAtlas HTML/broadcast pages as an upstream source. Because this is not a documented public data API, parsing is conservative:

- stable resource IDs are taken from URLs
- ETag/Last-Modified are used when DartsAtlas supplies them
- raw pages are not stored; parsed snapshots and content hashes are stored in `connector_resources`
- deterministic `data-*` fields can be promoted to structured live values
- ambiguous visible text is kept only as diagnostics and is never guessed into official statistics

If DartsAtlas changes markup, the failure is therefore contained inside this connector rather than leaking into the Blindleia domain model.

## Sync modes

### Full season sync

Use for discovery/history/member linking. It reads the season and tournament-results pages and follows discovered tournaments/matches.

```bash
php apps/api/bin/dartsatlas_sync.php \
  --season-id=rFByCgOqI1rq \
  --club-id=1
```

### Live tournament sync

Use during a club night. Supplying a tournament ID skips the broad season discovery pages and works only with that tournament.

```bash
php apps/api/bin/dartsatlas_sync.php \
  --season-id=rFByCgOqI1rq \
  --tournament-id=YOUR_TOURNAMENT_ID \
  --club-id=1 \
  --watch \
  --interval=30
```

`--watch` requires a tournament ID. The minimum interval is 15 seconds; 30 seconds is the conservative default until real traffic and DartsAtlas markup have been observed in production.

## Database doctor

After migrations/deploy, run:

```bash
php apps/api/bin/dartsatlas_doctor.php
```

The command reports only schema readiness. It does not print member records. It checks the core/live tables plus the existence and types of `medlemmer.id` and `medlemmer.navn`.

## Configuration

Generated API config supports these environment variables:

- `DARTSATLAS_SEASON_ID`
- `DARTSATLAS_TOURNAMENT_ID`
- `DARTSATLAS_CLUB_ID`
- `DARTSATLAS_LOCAL_SEASON_ID`
- `DARTSATLAS_MEMBERS_TABLE` (default `medlemmer`)
- `DARTSATLAS_POLL_INTERVAL_SECONDS` (default 30, minimum 15)
- `DARTSATLAS_USER_AGENT`

The deploy workflows pass the non-secret DartsAtlas values from GitHub environment variables into the generated config.

## Phase 2: Scolia

Scolia should be implemented as another connector, not built into the DartsAtlas adapter. It can later populate the same internal match/leg/visit structures with richer dart-level events while existing member links, player IDs, rankings and screen APIs remain unchanged.
