# Technical Research

**Task**: session sync conversations syncProcessor SessionSyncer claude conversations-processor sync-state-utils hook proxy timer
**Generated**: 2026-10-09
**Research path**: filesystem

---

## 1. Original Context

Stop codemie-code CLI conversation-sync loops that flood PUT /v1/conversations/{id}/history and overload the prod DB. Scope (must-have + cheap safety net): (1) fix duplicate-payloadId outcome marking regression from #557 (7472ea8a, v0.15.2) in syncProcessor applyPayloadOutcome — mark the record actually sent; on read, mark pending records done when a success record with the same payloadId exists (heals existing queues); (2) stop the conversation sync step from moving lastSyncedMessageUuid back (remove it from syncProcessor syncUpdates / never move backward; parseSourceIndex misparses digit-led UUIDs); (3) stop concurrent Stop/SubagentStop hooks from queueing the same payload — skip append when payloadId already queued in _conversation.jsonl (as codex/opencode/pi do); (4) safety net: cap payloads per sync run and collapse pending payloads to newest per (conversationId, history_index, role) before sending.

---

## 2. Codebase Findings

### Existing Implementations
- `src/providers/plugins/sso/session/processors/conversations/syncProcessor.ts` (335 lines) — `createSyncProcessor()` closure factory. Reads `~/.codemie/sessions/{sessionId}_conversation.jsonl` via `readJSONL`, filters `pending` or `failed && syncAttempts < MAX_CONVERSATION_SYNC_ATTEMPTS (3)` (L61-65), sends each through `apiClient.upsertConversation` sequentially with no per-run cap, and after every payload calls `applyPayloadOutcome(allPayloads, payloadId, syncError)` + `writeJSONLAtomic` (L146-148).
  - `applyPayloadOutcome` (L299-326): `allPayloads.findIndex(p => getPayloadId(p) === payloadId)`, so it updates the **first** record with that id. When an older `success` record shares the id, the pending duplicate that was actually sent is never marked and is re-sent on every run. Before 7472ea8a the code used `allPayloads.map(...)` + `successfulPayloadIds.has(id)` and marked **all** records with the id (confirmed in `git show 7472ea8a`).
  - `getPayloadId` (L288-292): `payloadId || lastProcessedMessageUuid || conversationId:timestamp`.
  - syncUpdates (L171-238): returns `conversations.lastSyncedMessageUuid` taken from the "latest" successful payload, ranked by `max(max(historyIndices), parseSourceIndex(lastProcessedMessageUuid))`. It also returns `lastSyncedHistoryIndex`, `conversationId`, `totalMessagesSynced`, `totalSyncAttempts: 1` and `lastSyncAt`.
  - `parseSourceIndex` (L328-335): `parseInt(value.slice(value.lastIndexOf('@') + 1))`. Claude UUIDs have no `@`, so the whole UUID is parsed. A digit-led UUID such as `8e2f…` gives 8 and `1234abcd-…` gives 1234. A letter-led UUID gives NaN, which becomes -1. This only makes sense for codex, opencode and pi sentinels (`<id>@<sourceIndex>`).
- `src/agents/core/session/sync-state-utils.ts` — `applyProcessingSyncUpdates(session, results)`. It **overwrites** `lastSyncedMessageUuid` whenever the new value differs (L74-81). `lastSyncedHistoryIndex` is merged with `Math.max`, so it only moves forward (L82-91).
- `src/providers/plugins/sso/session/SessionSyncer.ts` — runs `MetricsSyncProcessor` and the conversation `createSyncProcessor()` on an empty ParsedSession, then `applySyncUpdates` → `applyProcessingSyncUpdates` → `saveSession`. A cross-process lock file `sessions/{id}.sync.lock` (`open 'wx'`, stale after 120s) guards **only** the API-sync step.
- `src/agents/plugins/claude/session/processors/claude.conversations-processor.ts` — `ConversationsProcessor.processMessages` (L72-250) runs a drain loop. It calls `transformMessages(messages, localSync, …)` and appends `{payloadId: result.lastProcessedMessageUuid, lastProcessedMessageUuid, historyIndices, payload:{conversationId: context.agentSessionId, history}, status:'pending'}` with `appendFile` (L169-183). It does **not** read the existing JSONL first, so there is no already-queued check. After each append it persists a checkpoint `sessionMetadata.sync.conversations.lastSyncedMessageUuid` (CR-002, L198-218).
  - `transformMessages` (L287-478): `startIndex` = the position after `lastSyncedMessageUuid`, or 0 if that UUID is not found. A new user turn does `currentHistoryIndex = lastSyncedHistoryIndex + 1`. If the UUID pointer moves backward while the history index stays at its max, older turns are re-emitted under **new** history_index values. Their payloadIds match earlier success records.
- `src/agents/plugins/claude/claude.session.ts` L485-575 — the adapter's own syncUpdates merge after `processSession`. It also overwrites `lastSyncedMessageUuid` without a monotonic check (L545-547).
- Reference dedupe pattern (point 3):
  - `codex/session/processors/codex.conversations-processor.ts` L126-162: `readJSONL(conversationsPath)`, then `getQueuedCheckpoint` (L715), then `existingPayloads.some(p => p.lastProcessedMessageUuid === sentinel)`, which returns `'Window already queued'`.
  - opencode L130-154 does the same.
  - pi L168-355 uses a `queuedSentinels: Set<string>`.
- `src/providers/plugins/sso/session/processors/conversations/types.ts` — `ConversationPayloadRecord` (`payloadId?`, `historyIndices`, `lastProcessedMessageUuid?`, `payload.history: any[]`, `status`, `syncAttempts?`). Claude history entries carry `history_index` and `role` (`'User'|'Assistant'`) (claude processor L524/640/676).
- `apiClient.ts` L80-95: `PUT ${baseUrl}/v1/conversations/{conversationId}/history` with `{history, …}`. `DEFAULT_RETRY_ATTEMPTS = 3`, `DEFAULT_API_TIMEOUT_MS = 30000` (constants.ts).

### Architecture and Layers Affected
- **Agent hook / transform layer**: `src/cli/commands/hook.ts`. `handleStop` (L601) and `handleSubagentStop` (L613) both call `performIncrementalSync` → `sessionAdapter.processSession` → `ConversationsProcessor`. They run as separate processes with no lock.
- **Sync / upload layer**: `SessionSyncer` → `syncProcessor`.
- **Session state layer**: `sync-state-utils.ts`, `SessionStore`, and the claude adapter merge in `claude.session.ts`.
- **Schedulers**:
  - Proxy timer: `sso.session-sync.plugin.ts` `setInterval` (L199), `CODEMIE_SESSION_SYNC_INTERVAL`, default 120000 ms.
  - SessionEnd hook: `syncPendingDataToAPI` (hook.ts L260), with a deadline.
  - Codex, opencode and pi incremental-sync timers, plus `DesktopTelemetryRuntime`. These all instantiate `SessionSyncer`.

### Integration Points
- Flood mechanism, inferred from the code above:
  1. The sync step's `lastSyncedMessageUuid` moves the session pointer back.
  2. The Stop hook then re-emits old turns, whose payloadIds duplicate existing success records.
  3. `applyPayloadOutcome` marks the old record, not the sent one.
  4. The pending duplicate is re-PUT on every timer tick and every SessionEnd. The queue only grows.
- `syncProcessor`'s `writeJSONLAtomic` (full rewrite from in-memory `allPayloads`) can race with `appendFile` from the hook processes. Neither takes a shared lock.
- `syncProcessor` is shared by all agents (claude, codex, opencode, pi, gemini, copilot-cli, Claude Desktop telemetry), so its changes affect every agent.

### Patterns and Conventions
- Closure factory processors implementing `SessionProcessor {name, priority, shouldProcess, process}`.
- JSONL queue with statuses `pending/success/failed`, rewritten atomically with `writeJSONLAtomic`, read with `readJSONL` (`src/providers/plugins/sso/session/utils/`).
- `shouldStopSync(context)` deadline/abort checks between items.
- Dedupe-before-append on payloadId/sentinel in the non-Claude conversation processors.
- Logger prefix `[${CONVERSATION_PROCESSOR_NAME}]`. ESM `.js` import suffixes and `@/` path alias.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/architecture/architecture.md`, `.ai-run/guides/testing/testing-patterns.md`, `.ai-run/guides/development/development-practices.md` — general guides. None is specific to conversation sync.
- `docs/ARCHITECTURE-PROXY.md` L36, L674-725 — the SSO Session Sync plugin orchestrates metrics + conversations through `SessionSyncer`.
- `docs/superpowers/specs/2026-05-12-codex-conversations-sync-design.md` — origin of the codex sentinel (`<id>@<sourceIndex>`) and already-queued dedupe.

### Architectural Decisions
- CR-001 and CR-002 (inline in claude processor L113-127, L198-203): drain-loop advance guard and per-iteration checkpoint persistence, to avoid re-appending turns.
- #557 / 7472ea8a: per-payload persistence plus deadline deferral for SessionEnd teardown.
- EPMCDME-12992: central external-origin gate in `SessionSyncer`.

### Derived Conventions
- Sync pointers that are numeric are merged monotonically (`Math.max`). The UUID pointer is not.
- New behaviour comes with colocated `__tests__/*.test.ts` that use a temp `CODEMIE_HOME` and a mocked `apiClient`.

---

## 4. Testing Landscape

### Existing Coverage
- `syncProcessor-incremental-persistence.test.ts` (174 lines) — per-payload persistence, abort deferral, and no re-send of success records. Payloads use unique ids `conv-N@0`, so duplicate ids are not covered.
- `syncProcessor-guard.test.ts` — `CODEMIE_CONV_SYNC_DISABLED`.
- `syncProcessor-folder-mapping.test.ts` — folder resolution.
- `SessionSyncer.test.ts`, `SessionSyncer-lock.test.ts` — lock acquire, stale takeover, release.
- `src/agents/core/__tests__/core-misc.test.ts` L212+ — `applyProcessingSyncUpdates` (metrics counters).
- `src/agents/plugins/claude/__tests__/claude.conversations-processor.test.ts` — transformMessages content (bash, uploads).
- `tests/integration/session/incremental-conversation-processing.test.ts`, `tests/integration/session-syncer.test.ts`.
- `codex.conversations-processor.test.ts`, `opencode.incremental-sync.test.ts`, `pi.conversations-processor.test.ts` — references for already-queued tests.

### Testing Framework and Patterns
- Vitest (projects `unit`, `cli`, `agent`).
- `vi.mock('../apiClient.js')` with an `upsertConversation` spy.
- `mkdtempSync` temp `CODEMIE_HOME`, raw JSONL fixtures written with `writeFileSync`, and `logger.close()` in afterEach for Windows.

### Coverage Gaps
- Duplicate payloadId with a mix of success and pending records in `applyPayloadOutcome`, and queue healing on read.
- `parseSourceIndex` with Claude UUIDs (digit-led versus letter-led), and the `lastSyncedMessageUuid` value in syncUpdates.
- `applyProcessingSyncUpdates` conversation-pointer behaviour, both monotonic and overwrite.
- Claude processor with an existing queued payloadId (no dedupe test), and concurrent Stop/SubagentStop.
- No per-run cap and no collapse by (conversationId, history_index, role). Neither exists.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_SESSION_SYNC_INTERVAL` (proxy timer, default 120000).
- `CODEMIE_SESSION_SYNC_ENABLED`, `CODEMIE_SESSION_DRY_RUN` (proxy plugin).
- `CODEMIE_CONV_SYNC_DISABLED=1` (kill switch in syncProcessor and claude processor).
- `CODEMIE_SESSION_END_SYNC_BUDGET_MS` (default 2000).
- `CODEMIE_CONVERSATION_ASSISTANT_ID`, `CODEMIE_HOME`.

### Configuration Files
- `conversations/constants.ts` — timeouts, retries, processor priority/name.
- `MAX_CONVERSATION_SYNC_ATTEMPTS = 3` is a module constant in syncProcessor.ts.

### Feature Flags and Deployment Concerns
- No feature flag covers the sync logic beyond `CODEMIE_CONV_SYNC_DISABLED`.
- Fixes ship with the npm CLI release (current version 0.15.7). Queues already bloated on user machines will only heal if the on-read healing is included.

---

## 6. Risk Indicators

- `syncProcessor.ts` is shared by all agents. Healing and collapse logic must not break codex, opencode or pi sentinel payloads, whose ids legitimately use `@<index>`.
- Speculative: collapsing by (conversationId, history_index, role) needs care with Claude turn continuations. These re-send only the `Assistant` entry for an existing history_index, so "newest wins" must keep the latest continuation. Superseded records also need a terminal status that the `pending/failed` filter will never pick up again.
- Speculative: if `lastSyncedMessageUuid` is removed from syncProcessor's syncUpdates, the claude adapter merge (`claude.session.ts` L545) and the CR-002 checkpoint become the only writers. Gemini and codex callers of `applyProcessingSyncUpdates` should be checked for reliance on this field.
- Race: `writeJSONLAtomic` full rewrite in syncProcessor against hook `appendFile` with no shared lock. A record appended mid-sync can be dropped. This is not in scope but is adjacent.
- Concurrent Stop/SubagentStop processes both read the same session pointer. A read-then-append dedupe narrows the window but cannot close it without a lock.
- `transformMessages` falls back to `startIndex = 0` when `lastSyncedMessageUuid` is not found. This can re-emit the whole transcript with new history_indices.
- No existing tests cover duplicate payloadIds, UUID parsing, or pointer monotonicity.

---

## 7. Summary for Complexity Assessment

The change touches three layers: the shared upload processor (`syncProcessor.ts`), the session-state merge (`sync-state-utils.ts`, and possibly the adapter merge in `claude.session.ts`), and the Claude transform processor (`claude.conversations-processor.ts`). The surface is about 3–4 source files plus colocated Vitest tests. Each fix is localized:
- `applyPayloadOutcome` reverts to marking by the record that was sent.
- A filter pass on read heals existing queues.
- `lastSyncedMessageUuid` is dropped from, or guarded in, the syncUpdates.
- A read-before-append check mirrors the existing codex, opencode and pi `alreadyQueued` pattern.
- A per-run cap and a collapse step are added before the send loop.

Technical novelty is low. Every pattern already exists in the repo: the pre-#557 `map`-over-all-ids marking, the codex `existingPayloads.some(...)` dedupe, and `Math.max` monotonic merges. The collapse key (conversationId, history_index, role) is new logic, and it interacts with Claude turn continuations that re-send the Assistant entry for the same index.

Test posture is moderate. syncProcessor already has a temp-dir/mocked-apiClient harness (`syncProcessor-incremental-persistence.test.ts`) that the new cases can extend. There is no coverage of duplicate ids, Claude UUID parsing, pointer monotonicity or Claude-side dedupe. The key risks are:
- Regressions for the other agents that share syncProcessor.
- Correct handling of superseded and collapsed records, so they are never re-sent.
- The unlocked append/rewrite race between hook processes and the sync step.

---

## 8. External References

None named by the task. The commit `7472ea8a` (#557) the task cites was inspected in-repo with `git show`. It replaced the `allPayloads.map(p => successfulPayloadIds.has(getPayloadId(p)) ? success : failedByPayloadId.get(...) ? failed : p)` end-of-loop marking with per-payload `applyPayloadOutcome` using `findIndex`.
