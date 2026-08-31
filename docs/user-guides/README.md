# User guides and documentation gate

Blindleia Darts has two in-product user guides:

- **Player guide** for account activation, tournaments, groups, match details, statistics, membership and the live experience.
- **Admin guide** for member onboarding, tournament setup, check-in, tournament operations, equipment/Scolia, Live, ELO and result control.

The canonical user-facing guide content lives in:

`packages/ui-assets/user-guide.js`

Both player and admin surfaces load that shared module through `packages/ui-assets/portal-menu.js`. Do not create separate copies of the same guide text in each frontend.

## Mandatory guide-impact check before every Git push

Before **every** push to Git, review the intended diff and decide whether it changes anything a player or administrator needs to understand.

Check the guide whenever the change affects any of these areas:

- navigation, labels, buttons or visible terminology
- account activation, login, profile or player identity
- membership, payment or registration rules
- tournament creation, format, check-in, start or completion
- group tables, playoffs, matches or match details
- ELO, rankings, averages or any other statistic
- permissions, status meanings or workflow rules
- kiosk, board, tablet pairing, Scolia or Live screen behavior
- a shared/canonical component such as the match card or player links
- removal, replacement or deprecation of a feature

### Decision

For each push, the developer/agent must make one of two explicit decisions:

1. **Guide impact: updated** – user-visible behavior changed, so `packages/ui-assets/user-guide.js` is updated in the same logical change.
2. **Guide impact: none** – the change is internal only and does not alter how a player or admin uses or understands the platform.

The check is required even when the answer is “none”.

## What does not normally require a guide edit?

Examples include a pure refactor with identical behavior, test-only changes, deployment plumbing, database performance work with no visible semantic change, or a bug fix that restores behavior already described correctly in the guide.

If a bug fix changes the intended behavior or corrects a guide that was describing the wrong rule, the guide must be updated.

## Documentation principles

- The guide describes **current behavior**, not future plans.
- Reuse the same terms as the UI and canonical domain model.
- Prefer short operational instructions over implementation details.
- When the same concept exists on several surfaces, describe the canonical behavior once and only add surface-specific context when it genuinely differs.
- Do not document a default value as a rule unless it actually is the product rule.
- Migrated or historical data must be described according to the same semantics as native data once it is canonical.

## Review checklist

Before pushing:

- [ ] I reviewed the diff for player-facing impact.
- [ ] I reviewed the diff for admin-facing impact.
- [ ] I checked shared/canonical concepts affected by the change.
- [ ] I updated the guide if the workflow, rule, term or visible data changed.
- [ ] I verified that the guide still describes what TEST will actually do after deploy.
- [ ] I can state `Guide impact: updated` or `Guide impact: none` for this push.
