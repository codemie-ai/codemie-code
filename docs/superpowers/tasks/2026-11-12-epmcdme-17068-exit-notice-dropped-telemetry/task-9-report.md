DONE_WITH_CONCERNS

## Changed paths
- src/agents/core/session/exit-notice.ts (rewritten)
- src/cli/commands/__tests__/hook.session-delivery.test.ts
- src/agents/core/session/__tests__/stale-session-reconciliation.test.ts
- docs/ANALYTICS-REPORT.md
- .ai-run/guides/integration/external-integrations.md
- docs/ARCHITECTURE-PROXY.md

## Tests
`npx vitest run src/cli/commands/__tests__/hook.session-delivery.test.ts src/agents/core/session/__tests__/stale-session-reconciliation.test.ts` (RED seen first: 8 exit-notice tests failed). Final: exit-notice + related tests pass; `npx vitest run src/agents/core src/telemetry/runtime`: 1396 pass, 2 fail in launch-identity.test.ts (not touched by this task; unverified whether pre-existing).
tsc clean; eslint clean on changed ts files.

## Interfaces
exit-notice.ts exports `ExitDeliveryEntry`, `listExitDelivery(ownSessionId, since, now)`, `formatExitDelivery(entries): string[]`, and unchanged `noticeDeliveryAtExit(sessionId, startedAt, print)` (now wraps lister+formatter), so BaseAgentAdapter.ts needs no edit.
Lister: scans sessions dir; dropped = droppedAt >= since (any file); pending = own live json with codemieUrl; queued = other live json with deliveryFailingSince or deliveryRealAttempts>0, mtime since `since`; dedupe by sessionId per kind, newest startTime.
"Nothing is lost" removed from src and docs (only task-folder planning docs and negative test assertions mention it).
