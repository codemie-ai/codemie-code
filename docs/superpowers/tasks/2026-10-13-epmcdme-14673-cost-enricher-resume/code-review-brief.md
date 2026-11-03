# Code review — 2026-10-13-epmcdme-14673-cost-enricher-resume (2026-10-13)

**request-changes** · confidence: low · 3 blocking · 1 deferred · 3 filtered as noise
Coverage: blind — n/a (compact profile) · edge-case ✓ · verification-gap — n/a (compact profile) · acceptance — n/a (no spec)  (1/1 applicable lenses ran)

## Look here first

- `src/cli/commands/analytics/index.ts:154` — [other] filtered analytics run omits sibling sessions, so the older session's window runs to Infinity and takes the resumed session's records — CR-003
- `src/cli/commands/analytics/cost/cost-enricher.ts:141` — [other] sessions with identical/missing startTime get the same window; first takes all, other gets $0 — CR-001
- `src/cli/commands/analytics/cost/cost-enricher.ts:141` — [other] solo sessions get a window too, so records before startTime are dropped — CR-002

## Checked and clean

commit-format na · code-quality na · security na (standards not run) · 1 deferred → code-review-deferred.md
