# Canonical visit source and live delivery (November 2026)

## Visit provenance
- `bd_test_visits` / `bd_prod_visits` use the same additive `source VARCHAR(24) NOT NULL DEFAULT 'legacy'` column (migration `0089_add_visit_source.php`).
- New canonical Node and PHP writers explicitly store server-selected `manual`, `scolia`, `import`, or `api` alongside `input_mode`, `score`, `darts_json`, `request_key`, and `remaining_after`.
- Historical unknown sources stay `legacy`; only safe request-key markers (`scolia-%`, `manual:%`) are backfilled. Do not infer old import provenance from empty request keys.
- `request_key` remains a deduplication key, not the source of truth for provenance. `BIGINT` IDs remain exact decimal strings.
- Canonical kiosk recent visits and Scolia status / undo reads expose `source`.

## Live delivery
- Scoring writes commit before the best-effort canonical realtime publisher sends a `snapshot` refresh notification to `kiosk:{code}` and `club:{id}`. The event contains `reason`, `source`, `kiosk_id`, `match_id`. Notifications tell consumers to **re-fetch canonical state** rather than carrying speculative scores.
- Old kiosk: refresh-on-WebSocket; poll fallback about 1500 ms; on write, its own snapshot is rendered immediately after the response.
- Platform v2 kiosk: local optimistic display as soon as input is queued; now also listens for canonical `snapshot` events independently of Scolia, and refreshes the kiosk state. The existing ~1500-ms periodic polling remains a recovery path. While a local turn is unconfirmed, the WebSocket refresh does not overwrite its optimistic score.
- Club Live: refresh-on-WebSocket, plus 3000-ms poll regardless of socket status.
- Player Now: 5000-ms polling in active tabs, 15000-ms in hidden tabs; other player pages can need manual refresh or navigating between sections.
- Tournament leader admin: 15000-ms polling while tournament is in progress and page visible.
- Scolia input: individual hardware throw events can render locally before canonical persistence. Confirmed canonical scoring is a visit/turn event, typically completed by three darts or bust/checkout; for Scolia, timing depends on bridge/provider and takeout semantics.
- Real-time is **best effort**, not guaranteed delivery. Relay may be disabled; database write does not roll back or retry because relay publish fails. `/realtime/config` must report an enabled WebSocket. Polling is the correctness backstop.

## TEST sign-off checklist
1. Apply migration on `bd_test_`; verify schema, old `legacy` rows, known historical `scolia` rows and manually keyed `manual` rows.
2. Record manual sum and per-dart visits via kiosk, check `source='manual'`, compare match, legs, stats, ELO and Live.
3. Simulate Scolia event/visit without paid API access; assert `source='scolia'` and same canonical normalization and scoring validation.
4. Open two Platform v2 terminals and club Live, emit a manual visit on TEST, confirm receipt of `snapshot` and fresh server read on the other terminal. Disconnect the WebSocket and verify 1500-ms/3000-ms fallback.
5. Measure actual time: button/throw -> canonical commit -> relay publish -> each consumer's render, including reconnect. **Do not advertise a sub-second SLA based on source inspection.**
6. Keep any existing TEST ELO discrepancy (#381) separate, do not alter PROD. No PROD schema migration or rollout without approval.
