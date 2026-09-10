# Blindleia Backend v2

Backend v2 is the TypeScript migration path for the Blindleia Darts application backend.

Backend v2 is introduced incrementally beside the existing PHP API. PHP remains canonical for user traffic until migrated domains have proven behavioral parity, real TEST database compatibility and end-to-end behavior.

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
3. Do not perform shadow writes against production merely to compare implementations. Behavioral parity belongs in CI and isolated TEST fixtures; production compatibility probes are read-only until an explicit canary is approved.
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

## Slice 3: canonical scoring repository boundary

The third slice ports the current PHP `recordVisit` repository/transaction semantics behind the existing TypeScript MySQL session contract:

- the request-key retry check runs before the transaction and is repeated inside it before row locks, matching PHP,
- active match and open-leg selection retain `SELECT ... FOR UPDATE`,
- visit evaluation uses the already parity-tested TypeScript 501 rules,
- leg completion, match completion and `match_statistics` rebuild remain inside the same canonical write transaction,
- every database `BIGINT` id is required to enter TypeScript as a decimal string,
- repository SQL uses only the runtime table prefix; identity and hardware prefixes are not reachable from this layer,
- all SQL calls are serial on one transaction session; there is no nested acquisition and no background/shadow database traffic.

## Slice 4: guarded Node/MySQL runtime

The fourth slice makes backend-v2 runnable as a separate Node service without routing any user traffic to it:

- `mysql2` is isolated behind one `MySqlSessionProvider`; there is no pool,
- normal runtime work is serialized through one admitted slot and one physical connection is reused only for a short idle window before being returned,
- coexistence with PHP defaults to one backend-v2 connection and is hard-capped at two,
- `/health` is local runtime state while `/ready` performs a real read-only scoring-schema compatibility probe,
- runtime modes are `readonly`, `test-write` and `prod-canary`,
- TEST writes require both the TEST environment and `bd_test_` runtime prefix,
- PROD compatibility testing is read-only by default; production writes remain compile-time blocked until the complete canonical side-effect chain is migrated,
- mutation HTTP routes require an internal token.

## Slice 5: scoring lifecycle E2E and production preflight

The fifth slice extends the same canonical repository to `startMatch`, `recordVisit` and `undoLastVisit`, preserving PHP transaction and row-lock behavior. The internal HTTP runtime exposes the full scoring lifecycle without changing kiosk or Scolia routing.

A real TEST E2E workflow is SHA-gated against the deployed TEST release. It creates an isolated `bd_test_` fixture, starts backend-v2 with a one-connection budget, runs start → scoring → idempotent retry → checkout → statistics → undo through HTTP, verifies persisted MySQL state and removes the fixture. This lifecycle is now proven green against the hosted TEST database.

A separate production preflight starts the same backend-v2 runtime against `bd_prod_` in `readonly` mode with a one-connection budget. It validates the production scoring schema through `/ready` and proves the mutation endpoint is rejected before any write. This is preproduction use of real production data; production scoring remains owned by PHP until canonical side effects and source routing have also moved behind backend-v2.

## Slice 6: canonical realtime publication

Realtime refresh publication is the first post-mutation side effect migrated from the orchestration boundary:

- backend-v2 reads the kiosk code and club id only after the canonical scoring mutation has committed,
- it publishes the same `snapshot` event to `kiosk:<code>` and `club:<id>` channels,
- the refresh payload preserves reason and scoring source while keeping canonical database ids as decimal strings,
- relay exchanges default to the same 1.5 second bound as PHP,
- missing realtime configuration is a zero-work no-op and does not spend a MySQL connection slot,
- lookup, network, timeout and relay response failures are all best effort and can never turn a successful canonical scoring mutation into a client-visible write failure,
- the old `CoreOnlyCanonicalSideEffects` no longer contains a realtime no-op; remaining temporary ports are ELO, playoff reconciliation and ranking projections only.

Realtime configuration uses `REALTIME_PUBLISH_URL` and `REALTIME_PUBLISH_SECRET`. Production scoring writes remain compile-time disabled after this slice because ELO, playoff reconciliation, tournament ELO and linear ranking are still pending migration.
