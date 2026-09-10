# Blindleia Platform v2

Platform v2 is the incremental replacement for the legacy browser runtime.

## Scope of the first vertical slice

- `/v2/equipment/` — typed React equipment administration for boards, pairing and venue screens.
- `/v2/kiosk/` — typed React kiosk state machine for pairing, TEST board selection, idle/assigned/live match state and manual sum scoring.
- Existing PHP APIs and MySQL data remain canonical.
- Existing `/admin/` and `/kiosk/` remain available during migration.

## Architecture rules

1. Domain state is owned by React components, never inferred from DOM mutations.
2. All HTTP traffic goes through `src/shared/api.ts`.
3. Shared API shapes live in `src/shared/types.ts` and are checked by TypeScript.
4. Independent domains fail independently. Pairing failure must not hide canonical boards.
5. TEST/PROD hardware boundaries remain server-enforced; frontend read-only behavior is only UX.
6. New v2 features should not attach behavior to legacy DOM nodes.

## Build

From repository root:

```sh
npm install
npm run v2:typecheck
npm run v2:build
```

The build output is `apps/platform-v2-dist/` and is packaged as `/v2/` by `infra/deploy/build-release.sh`.
