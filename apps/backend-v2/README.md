# Blindleia Backend v2

Backend v2 is the TypeScript migration path for the Blindleia Darts application backend.

This directory starts in **shadow mode**. It does not receive kiosk, Scolia, admin or production traffic yet. The existing PHP API remains canonical until each migrated domain has proven behavioral parity and has been exercised in TEST.

## Migration contract

The migration changes architecture and technology, not the product surface.

- Current approved kiosk design, wording and interaction flow are frozen unless a separate UX change is explicitly approved.
- Existing PHP behavior is the reference contract while a domain is migrated.
- A migrated domain must pass parity tests before TEST routing can be considered.
- TEST must be proven before any production cutover.
- The existing Scolia bridge remains a thin physical-board adapter during the first slices. Scolia routing, durable spool, deduplication, reconciliation and TEST leases are not rewritten as part of the scoring-domain foundation.

## MySQL compatibility contract

The hosted MySQL database has a deliberately constrained connection budget. Existing PHP runtime code already uses an admission gate so PROD, TEST and maintenance do not exhaust the shared database account.

Backend v2 must therefore follow these rules:

1. Do not introduce a conventional large Node connection pool. Connection capacity must be explicitly configured and kept within the existing hosted budget.
2. Keep transactions short and preserve row-lock semantics such as `SELECT ... FOR UPDATE` where the current scoring transaction relies on them.
3. Do not perform shadow reads or writes against the live database merely to compare implementations. Parity belongs in CI/TEST fixtures first.
4. Keep database `BIGINT UNSIGNED` identifiers as decimal strings at the TypeScript boundary. Never assume every database id is a safe JavaScript `number`.
5. Preserve the existing runtime, identity and hardware table-prefix boundaries. TEST runtime data must not accidentally mutate canonical PROD hardware/Scolia master data.
6. Keep SQL compatible with the deployed MySQL feature set. Do not introduce PostgreSQL syntax or unverified MySQL-8-only features as migration shortcuts.
7. Prefer existing InnoDB tables, indexes, unique constraints and idempotency keys over new infrastructure. Early backend-v2 slices make no schema changes.

## Slice 1: 501 domain parity

The first slice contains:

- typed scoring contracts,
- a TypeScript port of the canonical `Dart501Rules`,
- explicit domain validation errors using the same error codes as PHP,
- safe MySQL identifier/table-prefix boundary helpers,
- a parity suite that executes the TypeScript implementation and the existing PHP implementation against the same vectors.

There is intentionally no HTTP server and no MySQL driver in this slice. That keeps the first architectural step zero-risk for runtime traffic and database connection capacity.

## Slice 2: Scolia adapter boundary

The second slice keeps the existing Scolia bridge and PHP queue operational, but makes the future TypeScript boundary explicit:

- Scolia ingress has typed event, buffer and routing identities.
- Serial normalization, event priority and dedupe identity are deterministic before persistence.
- Scolia sector mapping is ported to TypeScript and parity-tested against the existing PHP mapper.
- An assembled Scolia visit becomes one source-agnostic canonical `recordVisit` command.
- The current `scolia-<sha256(event ids)>` request key remains the idempotency contract.
- Connection/status/takeout events stay adapter concerns; only completed dart visits cross into canonical scoring.
- The canonical scoring port contains no Scolia-specific hardware or WebSocket concepts.

This slice still opens no MySQL connections and exposes no HTTP server. The live PHP implementation remains authoritative for queue persistence, TEST lease routing, reconciliation, ELO/playoff side effects and realtime publication.
