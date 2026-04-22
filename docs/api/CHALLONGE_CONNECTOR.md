# Challonge Connector Notes

This document captures the first official Challonge integration details we want to preserve in the project.

## Official Sources

- [Challonge API Docs](https://challonge.apidog.io/)
- [Getting Started](https://challonge.apidog.io/getting-started-1726706m0)
- [Authorization](https://challonge.apidog.io/authorization-1726705m0)
- [Scopes](https://challonge.apidog.io/scopes-1726710m0)
- [Grant Request](https://challonge.apidog.io/grant-request-23702476e0)
- [Token Request](https://challonge.apidog.io/token-request-23703396e0)
- [List Tournaments](https://challonge.apidog.io/list-tournaments-23619739e0)
- [List Participants](https://challonge.apidog.io/list-participants-23619749e0)
- [List Matches](https://challonge.apidog.io/list-matches-23619745e0)
- [Update Match](https://challonge.apidog.io/update-match-23619747e0)
- [Connect Request Signing](https://challonge.apidog.io/connect-request-signing-1726704m0)

## Confirmed API Details

- API version target: `v2.1`
- Base API URL: `https://api.challonge.com/v2.1`
- OAuth authorize URL: `https://api.challonge.com/oauth/authorize`
- OAuth token URL: `https://api.challonge.com/oauth/token`

## Recommended Initial Scopes

For our first read/import phase, these are enough:

- `me`
- `tournaments:read`
- `participants:read`
- `matches:read`

When we are ready to publish results back to Challonge, we will likely also need:

- `matches:write`

When we want to create or manage tournaments fully through our app, we will likely also need:

- `tournaments:write`
- `participants:write`

## Recommended Internal Flow

1. Admin chooses Challonge as tournament provider.
2. Admin starts OAuth from our backend.
3. Backend receives authorization code on our callback endpoint and exchanges it for tokens.
4. Tokens are stored server-side only.
5. Import jobs pull tournaments, participants, and matches into local tables.
6. Venue runtime uses only local data.
7. Optional publish-back updates Challonge through the connector.

## Current Backend Endpoints

- `GET /api/v1/connectors/challonge/authorize-url`
- `GET /api/v1/connectors/challonge/callback`

## Important Security Note

The Challonge `client_secret` is for OAuth token exchange.

It is **not** the same as the separate request-signing validation secret described in Challonge Connect request signing docs. If we later report scores from distributed clients, we should treat request signing as a separate feature and secret.

## First Endpoints We Care About

- `GET /tournaments.json`
- `GET /tournaments/{tournament_id}/participants.json`
- `GET /tournaments/{tournament_id}/matches.json`
- `PUT /tournaments/{tournament_id}/matches/{match_id}.json`

## Current Project Rule

Challonge remains an integration adapter. The internal tournament runtime stays the source of truth once data has been imported.
