# API App

Internal API for kiosk, screen, and admin clients.

Guidelines:

- keep request and response contracts stable and versionable
- keep provider-specific logic behind connector services
- keep migrations separate from application code

## Current Runtime Endpoints

- `GET /v1/health`
- `POST /v1/auth/login`
- `GET /v1/auth/me`
- `GET /v1/me/dashboard`
- `GET /v1/clubs`
- `POST /v1/clubs`
- `GET /v1/clubs/{id}/dashboard`
- `GET /v1/clubs/{id}/players`
- `POST /v1/clubs/{id}/players`
- `GET /v1/clubs/{id}/tournaments`
- `POST /v1/clubs/{id}/tournaments`
- `GET /v1/clubs/{id}/kiosks`
- `POST /v1/clubs/{id}/kiosks`
- `GET /v1/tournaments/{id}`
- `GET /v1/tournaments/{id}/matches`
- `POST /v1/tournaments/{id}/register`
- `POST /v1/tournaments/{id}/matches`
- `POST /v1/matches/{id}/assign-kiosk`
- `GET /v1/kiosks/{code}/state`
- `POST /v1/kiosks/{code}/start-match`
- `POST /v1/kiosks/{code}/visit`
- `POST /v1/kiosks/{code}/undo`
- `GET /v1/connectors/challonge/authorizations`
- `GET /v1/connectors/challonge/authorize-url?redirect_uri=...`
- `GET /v1/connectors/challonge/authorizations/{id}/tournaments`
- `GET /v1/connectors/challonge/authorizations/{id}/tournaments/{tournamentId}/participants`
- `GET /v1/connectors/challonge/authorizations/{id}/tournaments/{tournamentId}/matches`
- `POST /v1/connectors/challonge/authorizations/{id}/tournaments/{tournamentId}/import`
- `GET /v1/connectors/challonge/callback`

## Server-local member registry

DartsAtlas player linking prefers the club's existing server-local `sqlconnect.php` instead of storing the member database password in GitHub.

- default path is `../sqlconnect.php` relative to the deployed `api/` directory, i.e. `<release-root>/sqlconnect.php`
- the file is not versioned or included in release packages
- the loader accepts the existing club-admin convention where `sqlconnect.php` creates a `mysqli` connection in `$conn`
- any output produced while loading the file is suppressed for API/CLI use
- only `medlemmer.id` and `medlemmer.navn` are copied into a temporary in-session bridge table during DartsAtlas sync; the member registry is never persisted in the dart database
- `MEMBERS_SQLCONNECT_PATH` can override the path, including with an absolute server path to an already existing `sqlconnect.php`
- `MEMBERS_DB_*` remains an optional fallback; if neither source is available, DartsAtlas Live continues but automatic member linking is disabled

## Notes

- `config.php` is generated during GitHub deployment from environment secrets and variables.
- `config.example.php` is the local fallback when a generated config is not present.
- `.htaccess` routes requests into `index.php` for Apache-style hosting.
- Challonge connector config is injected from environment variables so client secrets do not live in Git.
- test/dev seed data includes known player accounts with a shared dummy password created by migration `0004_seed_known_players.php`.
- seeded usernames are derived from player names, for example `magnus-knudsen` and `andre-kendrick`.
- current shared test/dev password for seeded accounts is `BD-Test-2026!`.
- club scoping is explicit in portal/admin APIs so multiple clubs can coexist in the same runtime.
