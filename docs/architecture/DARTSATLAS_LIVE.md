# Darts Atlas Live adapter

## Purpose

The adapter treats Darts Atlas as a provider, not as the Blindleia source of truth.

Darts Atlas remains responsible for tournament execution in phase 1. Blindleia stores its own player identities, member links, season/tournament/match references and a compact live snapshot for venue screens and later statistics.

Scolia is deliberately not implemented here. The core `legs` and `visits` tables remain available for phase 2.

## Existing tables reused

The adapter reuses the first core migration:

- `clubs`
- `seasons`
- `tournaments`
- `players`
- `matches`
- `legs`
- `visits`
- `ranking_snapshots`
- `external_references`
- `connector_sync_jobs`

Migration `0002_dartsatlas_live_adapter.sql` only adds:

- `live_match_state` – fast, provider-neutral state for the venue display
- `connector_state` – small key/value state for future poll throttling/cursors

## Member identity

The existing Blindleia admin table `medlemmer` remains authoritative for membership.

No member data is copied into the darts core.

Links are stored in `external_references`:

- Darts Atlas player → internal player
  - `external_system = dartsatlas`
  - `external_entity_type = player`
- Blindleia member → internal player
  - `external_system = blindleia_admin`
  - `external_entity_type = member`

The resolver automatically links a Darts Atlas player to a member only when the normalised full name has exactly one match in `medlemmer`.

Zero or multiple member matches remain unlinked. Existing mappings are never replaced by a name guess. The match is retried on later syncs, so a player imported before joining the club can be linked automatically later.

## Live strategy

Darts Atlas documents official broadcast pages for match scoreboards and match statistics. Their match-stat source is updated after each throw.

For phase 1 the adapter therefore uses a hybrid approach:

1. Poll Darts Atlas tournament/match pages to discover IDs and persist Blindleia identities.
2. Resolve any Darts Atlas season reference into the existing local `seasons` table.
3. Store a compact normalised snapshot in `live_match_state`.
4. Expose the official Darts Atlas broadcast URL for each match so the venue display can use Darts Atlas' own after-each-throw rendering while Blindleia owns the surrounding UI and statistics.

This avoids depending on undocumented websocket internals.

## Running a sync

Direct tournament (recommended for a live evening):

```bash
php apps/api/dartsatlas_sync.php --tournament=TOURNAMENT_ID
```

Configured source/calendar discovery:

```bash
php apps/api/dartsatlas_sync.php
```

JSON state for the venue UI:

```text
/apps/api/live_state.php
```

Manual member link when automatic exact-name matching is not safe:

```bash
php apps/api/link_player_member.php --player=PLAYER_ID --member=MEMBER_ID
```

## Configuration

Optional environment variables used by generated config:

- `MEMBER_TABLE` (default `medlemmer`)
- `DARTSATLAS_BASE_URL`
- `DARTSATLAS_TOURNAMENT_ID`
- `DARTSATLAS_SOURCE_URL`
- `DARTSATLAS_SEASON_ID`
- `DARTSATLAS_MAX_TOURNAMENTS_PER_RUN`

For the Mandagsserie, configure the current Darts Atlas tournament ID on the live evening when possible. Calendar discovery is a fallback and intentionally limited to avoid polling a large historic catalogue.

## Important parser behaviour

Darts Atlas does not publish a general public tournament API in its current guides. The adapter therefore isolates HTML parsing in `packages/connectors/dartsatlas/DartsAtlasParser.php`.

If Darts Atlas changes markup:

- existing internal identities remain intact;
- the sync job fails or marks a match as skipped rather than guessing;
- no existing member link is overwritten;
- parser changes stay inside the connector package.

This is intentional.
