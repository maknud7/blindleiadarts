# Blindleia Scolia Bridge

Persistent adapter between Scolia External API v1.4 and the Blindleia Darts PHP API.

The bridge is deliberately thin. It does **not** know 501 rules, players, ELO, playoff logic or tournament state. Blindleia remains canonical for matches, scoring state and results.

## Activity model

The bridge is intentionally quiet when physical Scolia scoring is not needed.

### Idle / dvale

When no relevant tournament is near its start and no TEST lease is active, the bridge is in `idle` / **Dvale**:

- no Scolia WebSocket is kept open,
- no bridge heartbeat is written,
- no command polling runs,
- no server queue drain runs,
- the bridge only performs a lightweight read-only router check. The idle check is capped at roughly two seconds so a newly acquired TEST lease can wake the physical Scolia connection before kiosk fallback activates.

This is a healthy state. Missing heartbeat while the router says Scolia is not required must not be treated as an outage.

### Active

The bridge wakes automatically when one of these conditions is true:

1. a planned tournament is within the activation window (default 30 minutes before start),
2. a tournament is `in_progress`,
3. a `draft` or `ready` tournament is still inside the late-start window (default eight hours after planned start),
4. a physical board has an active TEST lease.

While active, the bridge:

1. opens one Scolia WebSocket connection per routed physical board,
2. durably spools every inbound message to disk before delivery,
3. delivers events to the routed Blindleia environment,
4. polls outbound Scolia commands and forwards them to the board,
5. writes bridge heartbeat/runtime status,
6. reconnects with exponential backoff.

When none of the activation conditions remain, the bridge closes the Scolia connection and returns to Dvale.

A TEST lease should therefore wake the bridge within a few seconds even when the service was already in Dvale.

Canonical scoring remains in `MatchScoringRepository` / `Dart501Rules`.

## Required environment

- `BLINDLEIA_API_BASE`, normally `https://blindleiadart.ingenting.org/api/v1`. The production router decides whether each physical board is routed to PROD or temporarily leased to TEST.
- `SCOLIA_BRIDGE_SECRET`, the platform-level credential shared with the PHP API configuration. Never reuse a Scolia Service Account token as this value.

Optional:

- `SCOLIA_WSS_URL` (default `wss://game.scoliadarts.com/api/v1/external`)
- `SCOLIA_SPOOL_DIR` (default `./data/scolia-spool`)
- `SCOLIA_CONFIG_POLL_MS` (active polling interval)
- `SCOLIA_IDLE_CONFIG_POLL_MS` (idle router interval; currently capped at 2000 ms so TEST can wake safely)
- `SCOLIA_COMMAND_POLL_MS` (default 750)
- `SCOLIA_DRAIN_POLL_MS` (default 5000)
- `SCOLIA_HEARTBEAT_MS` (default 15000)
- `SCOLIA_COMMAND_ACK_TIMEOUT_MS` (default 8000)

Secrets and Scolia access tokens must never be printed in logs.

## Canonical hardware and TEST routing

Scolia Service Account settings and physical board serial numbers are canonical production hardware data. TEST and PROD do not maintain competing copies of those settings.

A TEST lease only changes event routing for the leased physical board. Match, visit, statistics and other runtime data still stay in the selected environment.

## Reliability model

Scolia documentation does not promise replay after a WebSocket disconnect. Therefore Blindleia never silently assumes that no darts were lost. If a live board disconnects during an active match, the API marks the board `needs_reconciliation` and activates manual fallback. Reconnection does not clear that flag. The score must be checked at the terminal before Scolia is explicitly resumed.

The bridge spool protects the opposite direction: once the bridge has received a Scolia message, an API outage or bridge restart will not lose it. Duplicate delivery is safe because the API stores a deterministic dedupe key before processing.

`GET_SBC_STATUS` is request/response based. The bridge correlates its ACK with the queued command and, when the ACK contains a physical board status, normalizes it to the same `SBC_STATUS_CHANGED` event shape used by spontaneous Scolia status notifications. This prevents the kiosk from declaring a healthy board offline merely because the previous status event became old.

## Railway production service

The current Railway service is configured in the Railway UI rather than through repository Config as Code.

Use:

- **Root Directory:** `/apps/scolia-bridge`
- **Start Command:** `npm start`
- **Build Command:** blank/default
- **Volume mount:** `/data`
- `SCOLIA_SPOOL_DIR=/data/scolia-spool`
- restart policy: Always

The service is outbound-only and does not need a public domain.

## Running locally

```bash
npm install
npm start
```

For any persistent installation, run the process under a service manager or hosting platform with automatic restart.