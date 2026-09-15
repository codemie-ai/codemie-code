DONE

Commit: d795253 (fix(analytics): reconcile nested agent usage allocations)

Changed paths:
- src/cli/commands/analytics/cost/usage-readers.ts
- src/cli/commands/analytics/cost/cost-enricher.ts
- src/cli/commands/analytics/cost/types.ts
- src/cli/commands/analytics/cost/__tests__/usage-readers.test.ts
- src/cli/commands/analytics/cost/__tests__/cost-enricher.test.ts

Validation command: npx vitest run src/cli/commands/analytics/cost/__tests__/usage-readers.test.ts src/cli/commands/analytics/cost/__tests__/cost-enricher.test.ts
RED: seven new allocation/ownership/tool regressions failed with94 existing tests passing; separate precision RED failed after the ownership reader fix. Full failure logs preserved under docs/superpowers/tasks/2026-09-15-analytics-nested-subagents/task-4-red.local.log and task-4-precision-red.local.log.
GREEN:102/102 focused tests passed; npm run typecheck and scoped ESLint passed. Hooks passed related cost/extraction tests, ESLint, TypeScript, and Gitleaks. Complete focused success log: docs/superpowers/tasks/2026-09-15-analytics-nested-subagents/task-4-green.local.log.

New interfaces:
- UsageRecord.ownerAgentId (optional): canonical Claude transcript owner retained when progressive/replayed rows provide fuller usage.
- DispatchEvent.inclusiveTokens / inclusiveCostUSD: own plus guarded resolved descendants; existing tokens/costUSD remain OWN only.
- DispatchEvent.attributionStatus: exact | estimated | unavailable | ambiguous.
- DispatchEvent.attributionScope: own | owner-window. Skills/commands are owner-scoped estimates or unavailable; overlapping estimates never feed totals.
- SessionCost.rootOwnTokens / rootOwnCostUSD and unlinkedTokens / unlinkedCostUSD / unlinkedAgentIds: disjoint reconciliation summaries, only when response ownership exists (SDK rollups remain authoritative without manufactured allocations).

Synthetic fixture reconciles174 tokens and$0.00030525: root43/$0.00012825 + top-level child inclusive107/$0.000105 + sibling11/$0.000033 + unlinked13/$0.000039. Mixed Sonnet4.5/Haiku4.5 TTL prices avoid future Task5 model-rate changes.

Concerns: none blocking. Real private-session/report validation remains Stage7; none of its transcript bodies were copied into tests/artifacts. Existing environment NO_COLOR/FORCE_COLOR warnings remain in Vitest output.
