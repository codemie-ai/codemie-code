DONE

Commit: 12c7d77 (fix(analytics): apply verified Claude 5 pricing)

Changed paths:
- src/utils/pricing.json
- src/utils/__tests__/pricing.test.ts
- src/cli/commands/analytics/cost/__tests__/cost-calculator.test.ts

Validation command: npx vitest run src/utils/__tests__/pricing.test.ts src/cli/commands/analytics/cost/__tests__/cost-calculator.test.ts
RED: 4 expected failures for the outdated Sonnet 5 entry, with 28 tests passing. Full log: task-5-red.local.log.
GREEN: 32/32 tests passed. Full log: task-5-green.local.log. Commit hooks passed ESLint, the focused tests, TypeScript and Gitleaks. git show --stat HEAD confirms only the three owned paths.

Sonnet 5 rates per million: input 2, output 10, cache read 0.2, 5m cache creation 2.5, 1h cache creation 4 USD.
Opus 5 is explicitly pinned: input 5, output 25, cache read 0.5, 5m cache creation 6.25, 1h cache creation 10 USD.
Approved source: https://platform.claude.com/docs/en/about-claude/pricing, verified 2026-09-15 in session-reconciliation.json. Added a model-scoped verification note without implying all other entries were reverified. Values are standard API-equivalent token estimates, not invoices.

Tests cover every rate for canonical, dated and Bedrock-normalized aliases. Mixed-TTL regression prices a 1M 1h subset within 3M aggregate cache creation exactly once: Sonnet 5 cache creation costs 9 USD and complete fixture costs 21.4 USD; Opus 5 costs 22.5 USD and 53.5 USD respectively. Existing TTL algorithm and normalization/fallback policies are unchanged. Direct before/after comparison found no unrelated model-row changes.

Concerns: none blocking. Real session cost reconciliation and final report generation remain Stage 7.
