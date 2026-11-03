# Blindleia player journey: end-to-end acceptance matrix

Status: architecture/code review + initial UX fixes on a feature branch. Browser/manual UAT and release checks still required; **not** a claim of a completed E2E test.

## Architecture and independent clocks

A user moves through identity + membership eligibility -> tournament discovery -> registration/waitlist -> check-in gate -> code/admin check-in -> ready -> match assignment -> kiosk score -> Live/result/leaderboard -> player views.

- A successful registration or check-in must return canonical status from the server, not just a locally changed label.
- The code-based check-in modal is the single player-facing gate for home and tournament views. `admin_only` requires an operator; a closed or not-yet-open window must show a human-readable reason; waitlisted users must not be offered check-in.
- Do not send duplicate registration or check-in writes on rapid taps. Do not automatically retry ambiguous canonical mutations.
- After check-in, update user dashboard and cards *in place*, retaining scroll/view. A full-page reload is not necessary.
- Live checks canonical public/live and check-in display every **3 seconds** for data freshness; its autonomous visual display clocks remain **6 seconds board-page rotation**, **20 seconds group-page rotation**, **20 seconds ELO-page rotation**. These are not polling intervals; data refresh must not reset them.
- Transient failures of a required API read must not change an already valid `phase-live` or `phase-checkin` display to standby. Valid backend phase transitions still must apply.
- WebSocket scoring snapshots received during `phase-checkin` must **not** force Live before the authoritative check-in display has ended.
- Coalesce simultaneous read-only check-in status calls for the same tournament. Updating button/hint text must not cause self-triggered MutationObserver refresh loops.
- Kiosk and public Live WebSocket events prompt a read of canonical data; polling remains a fallback. The kiosk-prioritization/visit-source changes are in separate #380/#382 and are **not merged by this PR**.
- TEST: `bd_test_` runtime, shared `bd_prod_` identity/hardware read-only, no TEST writes to PROD.

## E2E scenarios to run in TEST (real mobile + desktop)

| ID | Starting state | Action | Expected visible UI | Canonical verification |
| --- | --- | --- | --- | --- |
| E01 | No account | Start account/member onboarding, login | Clear next step; no looping redirects | Identity/member linkage correct, no shadow duplicates |
| E02 | Eligible member; registration open | Tap "Meld meg på" twice rapidly, including poor network | One pending state; then "Påmeldt" or one specific error | Exactly one registration; no double mutation |
| E03 | Membership/payment requires action | Open tournament | No false successful registration; useful payment guidance | Backend eligibility consistent; no side effect |
| E04 | Tournament full | Register | "Venteliste"; check-in unavailable | Waitlist status, no check-in |
| E05 | Registered, check-in not open | Check in from Home and tournament | Same opening time; no code modal yet | No check-in mutation |
| E06 | Registered, check-in open with code | Open from Home, enter wrong code then correct code | Invalid code is an inline error; corrected code succeeds *without reload* | Exactly one `checked_in` record, source `player_code` |
| E07 | Registered, admin-only check-in | Try from all player surfaces | "Gå til innsjekkbordet" | No player mutation; admin can check in separately |
| E08 | Already checked in | Reopen Home and tournament | "Innsjekket"/"Venter på oppkalling"; no active code button | No duplicate changes |
| E09 | Ready/in progress | Assign a match to a board | Player sees actual opponent and board; kiosk sees same match | Match ID, kiosk, player identities match |
| E10 | Manual kiosk | Score a 3-dart visit, bust and checkout | Kiosk immediate pending, then saved; Live other client updates | One canonical visit; stats, legs and `source` correct when #382 available |
| E11 | Live active | Force one public live request to fail while next succeeds | Live remains on-screen; rotations continue 6/20s; no standby flash | No phantom tournament-state changes |
| E12 | Check-in display active | Fail one check-in-display read | Check-in phase remains; independent clock remains | No phantom state change |
| E13 | Live active, socket disconnected | Register/score/check in | Live falls back to up-to-3s refresh; rotates independently | Canonical data eventually caught up |
| E14 | Match completed | Watch Live, player portal, ranking | Correct result, separate display rotation, no stale match assignment | Match/stats/ELO/canonical projections in sync; ELO repair tracked in #381 |

## Mobile UX and observability checks

Test iPhone-scale 375px, Android-scale 412px, tablet 768px and desktop 1440px. Tap targets >=44px, no horizontal overflow, focus stays in the code dialog, status messages remain near the action, keyboard does not hide submit, no forced scroll to unrelated sections, and no blank/hidden buttons while check-in status is unresolved. Capture screen video with request timing; record latency at registration/check-in acknowledgement and time until Home, tournament, Live and kiosk agree.

Record correlation IDs/returned identifiers when supported, **but never log tokens, check-in codes or full personal records**. Compare: request time -> canonical write -> read response -> visible state; for scoring add relay publish -> WS receive -> visual update. Normal refresh must not cause double writes or timer resets.

## Release gates

1. Automated static/regression and backend tests green; no new CI failures.
2. Existing `Verify Core Test DB` ELO guest issue (#381) investigated independently. Do not disable checks or mutate PROD.
3. Browser E2E with two user roles and an admin on TEST confirms E01-E14.
4. Explicit approval before PROD deploy. Real Scolia API cannot be validated without paid Service Account.
