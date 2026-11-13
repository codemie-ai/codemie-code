DONE

Changed paths
- src/providers/plugins/sso/session/processors/conversations/types.ts (REJECTED status, ConversationSyncResponse.outcome)
- src/providers/plugins/sso/session/processors/conversations/payload-queue.ts (MAX_CONVERSATION_SYNC_ATTEMPTS removed; isSendCandidate = pending|failed)
- src/providers/plugins/sso/session/processors/conversations/apiClient.ts (results carry outcome: RequestOutcome)
- src/providers/plugins/sso/session/processors/conversations/syncProcessor.ts (rejected outcome -> status rejected)
- src/providers/plugins/sso/session/processors/metrics/metrics-api-client.ts (thrown errors carry outcome)
- src/providers/plugins/sso/session/processors/metrics/metrics-sync-processor.ts (MAX_SYNC_ATTEMPTS removed; rejected delta status)
- tests: conversations/__tests__/apiClient.test.ts, syncProcessor-dedupe.test.ts; metrics/__tests__/metrics-sync-processor.test.ts, metrics-sync-processor.merge.test.ts; src/cli/commands/__tests__/hook.session-delivery.test.ts (cap test updated to new rule)

Test command
npx vitest run src/providers/plugins/sso/session src/agents/core/session src/cli/commands/__tests__/hook.session-delivery.test.ts src/cli/commands/__tests__/hook.legacy-metrics-gate.test.ts src/telemetry/runtime
Result: all pass (after updating the cap test); tsc and eslint clean.

Interfaces
- CONVERSATION_SYNC_STATUS.REJECTED = 'rejected'; ConversationSyncResponse.outcome?: RequestOutcome
- isDeltaSendCandidate / isSendCandidate no longer read syncAttempts.
- src/cli/commands/hook/delivery.ts still calls both (now cap-free) and its cap-based drop no longer triggers; budget-based drop belongs to later tasks.
