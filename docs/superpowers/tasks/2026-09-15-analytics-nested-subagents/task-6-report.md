DONE

Commit: 996f16d (fix(analytics): project complete captured report data)

Changed paths:
- src/cli/commands/analytics/report/types.ts
- src/cli/commands/analytics/report/payload-builder.ts
- src/cli/commands/analytics/cost/types.ts
- src/cli/commands/analytics/report/__tests__/payload-builder.test.ts
- src/cli/commands/analytics/report/__tests__/report-generator.test.ts
- src/cli/commands/analytics/cost/cost-enricher.ts
- src/cli/commands/analytics/cost/__tests__/cost-enricher.test.ts
- src/cli/commands/analytics/otel-loader.ts
- src/cli/commands/analytics/__tests__/otel-loader.test.ts

The last four paths are the coordinator-approved scope extension: native snapshot metadata cannot reach buildPayload without a SessionCost bridge, and OTEL source-reported costs bypass native enrichment. Changes there are limited to those bridges and focused regressions.

Validation command: npx vitest run src/cli/commands/analytics/report/__tests__/payload-builder.test.ts src/cli/commands/analytics/report/__tests__/report-generator.test.ts src/cli/commands/analytics/report/__tests__/session-report.test.ts
RED: 5 expected failures, 44 existing tests passing; full log task-6-red.local.log.
GREEN: 49/49 passing; full log task-6-green.local.log.
Transport command: npx vitest run src/cli/commands/analytics/cost/__tests__/cost-enricher.test.ts src/cli/commands/analytics/__tests__/otel-loader.test.ts
Transport RED: 3 expected failures, 56 existing tests passing; task-6-transport-red.local.log.
Transport GREEN: 59/59 passing; task-6-transport-green.local.log.
Scoped ESLint and npm run typecheck passed. Commit hooks passed related analytics/report/cost tests, ESLint, TypeScript and Gitleaks. git show --stat HEAD confirms exactly these nine paths.

Public fields:
- SessionCost and ReportSessionRecord: capturedAt, observedStart, observedEnd (epoch milliseconds); costSource native-estimate|authoritative; costBasis standard-api-tokens|source-reported; dispatchesComplete.
- ReportMeta.capturedAt: latest included actual native-family capture; each session retains its own capture time. Never derived from report generatedAt.
- ReportSessionRecord projects rootOwnTokens/rootOwnCostUSD/unlinkedTokens/unlinkedCostUSD/unlinkedAgentIds and all dispatch identity, ancestry, lifecycle, own/inclusive allocation and attribution fields.
- dispatchesComplete=true marks uncapped Claude extraction; only complete lists replace named invocation summaries. Legacy lists keep aggregate fallbacks. Completed/failed statuses populate their respective counts; incomplete/unknown invocations are counted without invented success.
- Native snapshot bounds determine its record duration and derived report period. Explicit date-range filters remain authoritative.
- Native/SDK usage priced locally remains a standard API-equivalent estimate. Actual finite OTEL cost_usd amounts retain their numeric value and are tagged authoritative/source-reported; no invoice claim.

Proof includes 80 dispatches with duplicate names, three nesting levels, all lifecycle fields, own/inclusive/root/unlinked reconciliation and identical HTML/JSON single-session exports. Dispatch projection allowlists public fields; synthetic private transcript/tool-body markers do not survive either export. Original captured ParsedSession objects remain private.

Concerns: none blocking. Task 7 should carry s.capturedAt into client-side scopedPayloadForSession meta, which currently rebuilds metadata; session fields already survive. Real private report generation remains Stage 7.
