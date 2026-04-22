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
- `GET /v1/kiosks/{code}/state`
- `GET /v1/connectors/challonge/authorizations`
- `GET /v1/connectors/challonge/authorize-url?redirect_uri=...`
- `GET /v1/connectors/challonge/authorizations/{id}/tournaments`
- `GET /v1/connectors/challonge/authorizations/{id}/tournaments/{tournamentId}/participants`
- `GET /v1/connectors/challonge/authorizations/{id}/tournaments/{tournamentId}/matches`
- `POST /v1/connectors/challonge/authorizations/{id}/tournaments/{tournamentId}/import`
- `GET /v1/connectors/challonge/callback`

## Notes

- `config.php` is generated during GitHub deployment from environment secrets and variables.
- `config.example.php` is the local fallback when a generated config is not present.
- `.htaccess` routes requests into `index.php` for Apache-style hosting.
- Challonge connector config is injected from environment variables so client secrets do not live in Git.
- test/dev seed data includes known player accounts with a shared dummy password created by migration `0004_seed_known_players.php`.
- seeded usernames are derived from player names, for example `magnus-knudsen` and `andre-kendrick`.
- current shared test/dev password for seeded accounts is `BD-Test-2026!`.
