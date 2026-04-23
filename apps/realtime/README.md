# Blindleia Darts Realtime

Dette er en liten websocket-relay som brukes sammen med PHP-API-et.

Ansvarsdeling:

- PHP er source of truth for matchstate, adminhandlinger og database
- realtime-serveren broadcaster bare events videre til kiosk, screen og admin

Miljøvariabler:

- `PORT` default `8081`
- `HOST` default `0.0.0.0`
- `REALTIME_PUBLISH_SECRET` må settes for å tillate publish fra API-et
- `REALTIME_ALLOWED_ORIGINS` kan settes som kommaseparert liste

Endepunkter:

- `GET /health`
- `POST /publish`
- websocket: `GET /ws`

Klientmelding for abonnement:

```json
{
  "type": "subscribe",
  "channels": ["club:1", "kiosk:BOARD-1"]
}
```
