---
name: dartsatlas-history-migration
description: Safely migrate completed DartsAtlas tournament history into Blindleia Darts with test-first source probing, canonical player identity, atomic match imports, strict completion verification, idempotency checks, and a separate PROD promotion gate.
---

# DartsAtlas historical migration

Use this skill whenever old tournament/season data is copied from DartsAtlas into Blindleia Darts. DartsAtlas is a historical source only; it must never become a runtime dependency or canonical identity source again.

## Non-negotiable rules

1. Never migrate a new tournament to PROD before the exact same migration path is green in TEST.
2. Never continue with additional TEST tournaments while the Atlas history QA workflow is red for already-imported tournaments.
3. Never mark a historical tournament `completed` merely because the structural rows exist. Completion is a post-condition after matches, legs, visits, statistics, playoff state, ranking events and external references have been verified.
4. A canonical completed tournament must match the platform lifecycle: `tournaments.status='completed'` **and** `tournaments.end_at IS NOT NULL`. A completed playoff must have `status='completed'`, a champion, and completed nodes. The normal playoff lifecycle in `TournamentPlayoffRepository` is the reference behavior.
5. Import one full match atomically. Never leave half a match in the database. Visits may be fetched sequentially, but the database write for a match must be one transaction.
6. Resolve players canonically. Prefer existing member-linked/active player IDs and retain DartsAtlas external references. Do not create a second local player only because an old Atlas identity exists.
7. Never infer dart segments, busts, checkout darts or other data not present in the source. Aggregate data must remain aggregate data.
8. Respect DartsAtlas rate limiting. Do not parallelize scraping or evade limits. Use the established slow policy: cooldown before a run, about 12 seconds between successful match requests, and escalating backoff on 429.
9. New migrations must be manifest/config driven. Do not create future tournament importers by runtime text replacement of a previous tournament-specific PHP file. The old #1/#2 importers may remain as migration history, but they are not the model for PROD promotion.
10. Before any write, fetch current `develop` and inspect current schema/import files. Concurrent development is normal in this repository.

## Known lifecycle bug to guard against

The legacy Atlas structural importer writes `status='completed'` on `tournaments`, but historically did not populate `end_at`. The normal Blindleia playoff lifecycle completes a tournament with both `status='completed'` and a non-null `end_at`. Missing `end_at` must therefore fail QA and be repaired/finalized before PROD.

## Required migration phases

### 1. Probe and freeze the source

Fetch tournament root, groups, each group page, results and the match-detail pages needed for visits. Record at minimum:

- Atlas season/tournament external ID
- tournament name/date
- expected participant count
- expected group sizes
- expected completed match count
- playoff shape and final winner
- all Atlas player IDs
- all Atlas match IDs

Reject the source before database writes if a required page is unavailable, a match is undecided, a final/champion cannot be resolved, or the discovered counts differ from the manifest.

### 2. Import structure into TEST as not-finalized

Create/update season, tournament, canonical player references, tournament participants, groups, group assignments, matches, aggregate match statistics, playoff entries/nodes and ranking events idempotently.

During a multi-step import the tournament must be treated as not finalized. Do not expose a false `completed` lifecycle while detailed match data is still missing.

### 3. Import match detail atomically

For each Atlas match:

- fetch and validate the whole match payload first;
- validate source score accounting;
- start one database transaction;
- replace/upsert that match's legs, visits and derived statistics consistently;
- commit only after the complete match validates;
- on any error, roll back that match and stop/retry safely.

### 4. Strict TEST verification

Run:

`php infra/sql/atlas_history_verify.php --external=<ATLAS_TOURNAMENT_ID> --expected-matches=<N> --expected-players=<N> --phase=final`

The verifier is a release gate, not an informational inventory. It must fail on lifecycle or data inconsistencies, including:

- wrong participant/match count;
- tournament not completed or missing `end_at` in final phase;
- participant without a match;
- missing group assignment;
- non-completed match, missing winner/finished timestamp or missing Atlas match reference;
- source result differing from imported leg winners/statistics;
- incomplete/missing legs or visits;
- missing canonical Atlas player reference;
- incomplete playoff/champion/final node;
- missing season ranking events.

`history_inventory.php` is useful context, but it is **not** a substitute for this verifier.

### 5. Idempotency test in TEST

Before PROD, rerun the same import once against TEST and run the strict verifier again. The second run must not create extra tournaments, matches, players, legs, visits, ranking events or external references, and must not change the winner/standings.

### 6. API/UX smoke in TEST

After DB verification, inspect the deployed TEST UI/API as a user would:

- tournament is visibly finished, not active/in progress;
- group tables have all expected matches and standings;
- playoff bracket is fully resolved and champion correct;
- tournament result list is complete;
- player match history and match detail open for representative group and playoff matches;
- tournament/season 3DA and season ranking are populated;
- no duplicate player appears because of the migration.

Do not promote because the SQL rows merely “look plausible”.

### 7. PROD promotion

PROD is a separate explicit operation. Before writing PROD:

- TEST QA is green after an idempotent rerun;
- current PROD inventory has been captured;
- the PROD importer uses canonical IDs/external references and the same verified source manifest;
- no TEST-only hard guard has been casually removed from an old script; use a deliberate PROD-safe importer/finalizer;
- the exact expected deltas are known in advance.

After PROD import, run the same strict verifier with the PROD table prefix, then verify the public/player UI. If verification fails, stop further imports and repair/roll back the affected tournament before continuing.

## What to report after each migration

Always report concrete evidence: external tournament ID, local tournament ID, participants, matches, legs, visits, champion, lifecycle status/end time, verifier result, and whether an idempotent rerun was tested. Never say “migrated successfully” from a workflow exit code alone.
