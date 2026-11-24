# Code review — 2026-10-16-fix-root-cause-a-cost-attribution (2026-10-16)

**request-changes** · confidence: low · 2 blocking · 1 deferred · 3 filtered as noise
Coverage: blind — n/a (balanced profile) · edge-case ✓ · acceptance — n/a (no spec) · verification-gap — n/a (balanced profile) · standards ✓ (2/2 applicable lenses ran)

## Look here first

- `src/cli/commands/analytics/cost/usage-readers.ts:162` — [other: analytics-accuracy] `withinWindow()`'s strict `r.ts < windowEnd` drops a session's own final usage record whenever its timestamp equals `windowEnd` — the common case for native sessions, since `observedEnd` is computed as the max of the session's own message timestamps — CR-002
- `src/cli/commands/analytics/cost/cost-enricher.ts:419` — [other: code-quality] new ~20-line grouping block added inline into the already-oversized `enrichCosts()` (now 568 lines / function still ~180 lines), compounding a documented code-quality violation instead of containing it — CR-001

## Checked and clean

commit-format ✓ · security ? unverified (no documented security guide path in this repo; manually inspected, no issues found) · 1 deferred → code-review-deferred.md
