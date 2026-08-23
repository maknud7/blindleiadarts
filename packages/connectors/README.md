# Connectors Package

External provider integrations belong here and must stay behind provider boundaries.

Current direction:

- `DartsAtlas`: phase 1 tournament discovery, match mapping and live/broadcast snapshot adapter.
- `Scolia`: phase 2 dart-level integration using the same internal player/match/leg/visit model.
- `Challonge`: optional later adapter if a tournament format requires it; not a dependency of the core platform.

Shared concepts:

- stable provider IDs map through `external_references`
- provider polling/webhooks are recorded through connector sync resources/jobs
- provider payloads are translated before they reach screen/admin/domain code
- the internal database remains usable if a provider is temporarily unavailable

Suggested abstractions as the connector package grows:

- `TournamentProviderInterface`
- `BracketProviderInterface`
- `ProviderTournamentRepository`
- `ProviderMatchMapper`
- `ProviderParticipantMapper`
- `ConnectorSyncService`
- `ResultPublishService`
