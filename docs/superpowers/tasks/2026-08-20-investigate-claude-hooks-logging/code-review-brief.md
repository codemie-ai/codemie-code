# Code review — 2026-08-20-investigate-claude-hooks-logging (2026-08-20)

**request-changes** · confidence: medium · 4/4 prior findings resolved · 1 new blocking finding
Coverage: blind ✓ · edge-case ✓ · verification-gap — n/a (check round) · acceptance — n/a (check round)  (2/2 lenses ran)

## Confirmation results (prior findings)

- CR-001 resolved — notice level now flows through types.ts, parser.ts, filter.ts, formatter.ts
- CR-002 resolved — executor.ts's new notifiedFailedHooks dedup stops console flooding on repeat hook failures
- CR-003 resolved — logger.ts's notice() now spreads sanitized args into console.warn
- CR-004 resolved — vitest.config.ts's testCodemieHome is now PID-suffixed, closing the cross-invocation race

## New finding

- `src/hooks/executor.ts:545` — [other: reliability] clearCache() never clears notifiedFailedHooks; once a hook fails once, every later failure of it (even a different error) is permanently silenced from the console for the life of the process — CR-005

## Checked and clean

commit-format ✓ · code-quality ✓ · security n/a — carried forward from the final round (standards audit is not re-run on check rounds)
