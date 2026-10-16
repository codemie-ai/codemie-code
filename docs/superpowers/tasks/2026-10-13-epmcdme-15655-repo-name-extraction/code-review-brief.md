# Code review — 2026-10-13-epmcdme-15655-repo-name-extraction (2026-10-13)

**request-changes** · confidence: low · 2 blocking · 2 deferred · 0 filtered as noise
Coverage: edge-case ✓ · acceptance — n/a (no spec) · blind — n/a (compact profile) · verification-gap — n/a (compact profile)  (1/1 applicable lenses ran)

## Look here first

- `src/utils/processes.ts:401` — [other: regression] bare filesystem git remotes (e.g. `/home/user/repo.git`) now return `undefined` instead of a best-effort `owner/repo`, because the new parser requires a `scheme://` or `user@host:` form and the old generic fallback regex was removed — CR-001
- `src/utils/processes.ts:412` — [other: robustness] a malformed `%` escape in a path segment makes `decodeURIComponent` throw, which propagates to the outer catch and silently returns `undefined` for an otherwise-valid remote — CR-002

## Also flagged

(none)

## Checked and clean

edge-case ✓ · 2 deferred → code-review-deferred.md

No spec/story artifact exists for this task, so the acceptance lens did not run (no-spec round) and this caps confidence at low. Standards review was not expected for this profile/round.
