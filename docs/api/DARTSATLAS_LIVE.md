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

The importer may automatically connect a player to a member only when the normalized full name has exactly one exact match in `medlemmer`, and that member is not already linked to another local dart player. Fuzzy matches and conflicts are intentionally left unmatched for manual review.

There is no database foreign key to `medlemmer` in migration 0002. The member registry predates the dart schema and should first be verified in production with `dartsatlas_doctor.php` before a cross-schema constraint is considered.

## Data acquisition

The connector is isolated under `packages/connectors/DartsAtlas`.

It uses public DartsAtlas HTML/broadcast pages as an upstream source. This is not a documented general-purpose DartsAtlas API, so parsing is deliberately defensive:

- stable resource IDs are taken from URLs when available
- tournament rows can be used as a fallback when a separate match ID/page is not exposed
- ETag/Last-Modified are used when DartsAtlas supplies them
- parsed snapshots and content hashes are stored in `connector_resources`
- deterministic `data-*` fields can be promoted to structured live values
- ambiguous visible text is kept only as diagnostics and is never guessed into official statistics
- MySQL named locks prevent two workers from polling the same tournament simultaneously

If DartsAtlas changes markup, the failure is contained inside this connector rather than leaking into the Blindleia domain model.

## Live data model

The venue screens should never call DartsAtlas themselves.

The worker writes:

- durable match identity/status to `matches`
- current score/legs to `live_match_states`
- average, 180s, checkout figures and other available statistics to `match_statistics`
- provider/cache metadata to `connector_resources`

This means one worker can serve any number of TV/browser clients through Blindleia's own API/database.

## Sync modes

### Full season sync

Use for discovery/history/member linking. It reads the season, results and calendar pages and follows discovered tournaments/matches.

```bash
php apps/api/bin/dartsatlas_sync.php \
  --season-id=rFByCgOqI1rq \
  --club-id=1
```

### Live tournament sync

Use during a club night. Supplying a tournament ID skips broad season discovery and works only with that tournament.

```bash
php apps/api/bin/dartsatlas_sync.php \
  --season-id=rFByCgOqI1rq \
  --tournament-id=YOUR_TOURNAMENT_ID \
  --club-id=1 \
  --watch \
  --interval=8
```

The default interval is 8 seconds and the minimum is 5 seconds. The live loop always refreshes the tournament page, but it does **not** re-fetch every historical match every cycle. Separate match/broadcast pages are continuously polled only for matches detected as active; newly discovered unknown matches are fetched once for identity mapping. Conditional HTTP requests further reduce payload when DartsAtlas supplies cache validators.

`--watch` requires a tournament ID so a broad season crawl cannot accidentally run every few seconds.

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
- `DARTSATLAS_POLL_INTERVAL_SECONDS` (default 8, minimum 5)
- `DARTSATLAS_USER_AGENT`

The deploy workflows pass the non-secret DartsAtlas values from GitHub environment variables into the generated config.

## Phase 2: Scolia

Scolia should be implemented as another connector, not built into the DartsAtlas adapter. It can later populate the same internal match/leg/visit structures with richer dart-level events while existing member links, player IDs, rankings and screen APIs remain unchanged.
