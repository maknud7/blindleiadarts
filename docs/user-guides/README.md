# User guides and documentation gate

Blindleia Darts has two in-product user guides:

- **Player guide** for account activation, tournaments, groups, match details, statistics, membership and the live experience.
- **Admin guide** for member onboarding, tournament setup, check-in, tournament operations, equipment/Scolia, Live, ELO and result control. Superadmin gets the same operational club topics plus explicitly role-gated platform-operation topics such as Scolia bridge drift and diagnostics.

The canonical user-facing guide content lives in:

`packages/ui-assets/user-guide.js`

Role/topic access for the guide lives in:

`packages/ui-assets/user-guide-access.js`

Both player and admin surfaces load the shared guide through `packages/ui-assets/portal-menu.js`. Do not create separate copies of the same guide text in each frontend.

## Access control

The guide must follow the same authenticated role model as the product. Showing a feature in documentation is part of the user experience, so users should not be presented with procedures for functionality they cannot access.

Current roles are `player`, `club_admin` and `super_admin` for guide purposes:

- On the player surface, authenticated users see player topics only.
- On the admin surface, only `club_admin` and `super_admin` may see club-administration topics.
- Superadmin-only topics, when added, must be explicitly limited to `super_admin`.
- Guide topics are **deny-by-default**. A new topic must be explicitly added to the topic-access map in `user-guide-access.js` before it becomes visible.
- If the correct access level for a new or changed topic is not obvious from the product permissions or workflow, **do not guess**. Ask the product owner which role(s) should see it before adding the topic to the access map.
- If a future role gets narrower product permissions, its guide topic list must be narrowed at the same time. Do not grant guide access merely because a user can open the general portal.
- If a user has no accessible guide topics on the current surface, the guide launcher is hidden.

Guide access is not a substitute for backend authorization. APIs and product features remain the security boundary; the guide mirrors those permissions so the documentation matches what the user can actually do.

## Guide format

The in-product guide is an **operational manual**, not a collection of feature blurbs. A topic should normally answer a concrete question such as “How do I add a normal board?” or “How do I check players in and start a tournament?”.

For workflows, use numbered steps in the same order the user performs them in the UI. Include prerequisites, the exact navigation path, what to enter/select, the action that commits the change, and how the user verifies that it worked. Use explanatory notes only after the procedure when they prevent a common misunderstanding.

Write club-neutral instructions where the behavior is generic. Blindleia-specific wording should only be used where the functionality genuinely depends on Blindleia. This keeps the documentation suitable for the platform to be used by other small dart clubs later.

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

1. **Guide impact: updated** – user-visible behavior changed, so the guide and, when relevant, its access map are updated in the same logical change.
2. **Guide impact: none** – the change is internal only and does not alter how a player or admin uses or understands the platform.

The check is required even when the answer is “none”.

## What does not normally require a guide edit?

Examples include a pure refactor with identical behavior, test-only changes, deployment plumbing, database performance work with no visible semantic change, or a bug fix that restores behavior already described correctly in the guide.

If a bug fix changes the intended behavior or corrects a guide that was describing the wrong rule, the guide must be updated.

## Documentation principles

- The guide describes **current behavior**, not future plans.
- Reuse the same terms as the UI and canonical domain model.
- Prefer task titles, numbered procedures and verification steps over general descriptions.
- When the same concept exists on several surfaces, describe the canonical behavior once and only add surface-specific context when it genuinely differs.
- Do not document a default value as a rule unless it actually is the product rule.
- Migrated or historical data must be described according to the same semantics as native data once it is canonical.
- A workflow guide must be understandable by a new club administrator without repository or database knowledge.
- Documentation visibility must follow product permissions; adding a topic requires an explicit access decision.
- When the appropriate access level is ambiguous, clarification is mandatory before the guide is changed.

## Review checklist

Before pushing:

- [ ] I reviewed the diff for player-facing impact.
- [ ] I reviewed the diff for admin-facing impact.
- [ ] I checked shared/canonical concepts affected by the change.
- [ ] I updated the guide if the workflow, rule, term or visible data changed.
- [ ] I checked whether guide topic access must change for any role.
- [ ] Any new/changed topic is explicitly present in the guide access map (deny-by-default).
- [ ] If the correct guide access level was ambiguous, I asked for clarification before assigning it.
- [ ] Any new/changed workflow has a real step-by-step procedure, not only a feature explanation.
- [ ] I verified that the guide still describes what TEST will actually do after deploy.
- [ ] I can state `Guide impact: updated` or `Guide impact: none` for this push.