# Realtime Setup

## Recommended Shape

Use PHP as the primary API and database owner, and run websocket separately:

- PHP API: auth, tournament logic, kiosk commands, DB writes
- realtime relay: websocket fanout only
- clients: websocket first, SSE/poll fallback

## Why

This keeps the venue logic in one place while making kiosk and screen feel immediate.

## Realtime Channels

- `club:{clubId}` for screen and admin
- `kiosk:{kioskCode}` for the paired tablet

## Minimal Runtime

The repo now includes `apps/realtime` with:

- websocket endpoint: `/ws`
- publish endpoint: `/publish`
- health endpoint: `/health`

Environment variables:

- `PORT`
- `HOST`
- `REALTIME_PUBLISH_SECRET`
- `REALTIME_ALLOWED_ORIGINS`

## Event Flow

1. kiosk/admin sends command to PHP API
2. PHP commits to MySQL
3. PHP POSTs snapshot payload to realtime `/publish`
4. realtime relay broadcasts to subscribed websocket clients
5. kiosk, screen and admin redraw immediately

## Suggested Deployment

Use a small Node-friendly host for realtime, for example a VPS or simple app runner.

Suggested hostnames:

- `realtime-test.blindleiadarts.ingenting.org`
- `realtime.blindleiadarts.ingenting.org`
