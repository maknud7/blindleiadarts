# Blindleia Scolia Bridge

Persistent adapter between Scolia External API v1.4 and the Blindleia Darts PHP API.

The bridge is deliberately thin. It does **not** know 501 rules, players, ELO, playoff logic or tournament state. It only:

1. polls Blindleia for enabled Scolia boards,
2. keeps one Scolia WebSocket connection per board,
3. durably spools every inbound message to disk before delivery,
4. delivers events to the Blindleia database queue,
5. polls outbound Scolia commands and forwards them to the board,
6. reconnects with exponential backoff.

Canonical scoring remains in `MatchScoringRepository` / `Dart501Rules`.

## Required environment

- `BLINDLEIA_API_BASE`, e.g. `https://test.example.org/api/v1`
- `SCOLIA_BRIDGE_SECRET`, same value as the PHP API configuration

Optional:

- `SCOLIA_WSS_URL` (default `wss://game.scoliadarts.com/api/v1/external`)
- `SCOLIA_SPOOL_DIR` (default `./data/scolia-spool`)
- `SCOLIA_CONFIG_POLL_MS` (default 10000)
- `SCOLIA_COMMAND_POLL_MS` (default 750)
- `SCOLIA_DRAIN_POLL_MS` (default 2000)
- `SCOLIA_HEARTBEAT_MS` (default 15000)
- `SCOLIA_COMMAND_ACK_TIMEOUT_MS` (default 8000)

## Reliability model

Scolia documentation does not promise replay after a WebSocket disconnect. Therefore Blindleia never silently assumes that no darts were lost. If a live board disconnects during an active match, the API marks the board `needs_reconciliation` and activates manual fallback. Reconnection does not clear that flag. The score must be checked at the terminal before Scolia is explicitly resumed.

The bridge spool protects the opposite direction: once the bridge has received a Scolia message, an API outage or bridge restart will not lose it. Duplicate delivery is safe because the API stores a deterministic dedupe key before processing.

## Running

```bash
npm install
npm start
```

Run this process under a service manager (systemd, Docker restart policy, PM2 or equivalent). It is a persistent worker and should not be hosted as a short-lived PHP request.
