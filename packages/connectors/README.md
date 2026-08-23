# Connectors Package

Provider integrations live here and must not leak provider-specific assumptions into the Blindleia domain or venue UI.

## Active connector

- `dartsatlas/DartsAtlasLiveAdapter.php` – phase 1 live/import adapter for Darts Atlas.
  - discovers tournaments and matches
  - maps stable Darts Atlas ids to local entities through `external_references`
  - links players to the existing `medlemmer` register when the full-name match is unique
  - stores a compact `live_match_state` snapshot for venue screens
  - exposes the official Darts Atlas broadcast URL for the fastest score rendering

See `docs/architecture/DARTSATLAS_LIVE.md`.

## Boundary

Darts Atlas is a provider. The local core remains the source of truth for Blindleia identities and historical data.

Scolia is phase 2. Existing `legs` and `visits` tables are intentionally kept provider-neutral so dart/visit events can be added later without changing player/member identity.
