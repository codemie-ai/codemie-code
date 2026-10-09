# Conversation-Sync Loop Fix Implementation Plan (EPMCDME-15771)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop re-PUTs of already-synced conversation payloads, and heal queues that are already bloated.
**Architecture:** Every send-side fix lives in the shared `syncProcessor.ts`. The pure queue helpers go in a new `payloadQueue.ts`. The read pipeline runs **heal → collapse → cap → send**. On the Claude side, a read-before-append dedupe prevents duplicates from being queued.
**Tech Stack:** TypeScript ESM, Vitest.
**Spec:** `docs/superpowers/tasks/2026-10-09-conversation-sync-loop-fix/spec.md`

Commit per task using the repository's existing convention. Tasks 1–2 make up Phase 1 (hotfix 0.15.8). Each of them can be committed on its own.

## Global Constraints
- ESM imports with a `.js` suffix and the `@/` alias. Use `logger.debug`, never `console.log`. No `any` in new code. Exported functions have explicit return types.
- `MAX_CONVERSATION_PAYLOADS_PER_RUN = 50` is a module constant and is not env-configurable.
- `superseded` is a terminal status. The candidate filter never selects it.
- Do not change `sync-state-utils.ts`, the `claude.session.ts` merge, or `ClaudeDesktopTelemetryAdapter.ts`.
- Tests live in `src/providers/plugins/sso/session/processors/conversations/__tests__/syncProcessor-dedupe.test.ts` (new). Reuse the harness from `syncProcessor-incremental-persistence.test.ts`: temp `CODEMIE_HOME`, `vi.mock('../apiClient.js')` with an `upsertConversation` spy, JSONL fixtures, and `logger.close()` in afterEach. Run with `npx vitest run <file>`.

## Review Focus
1. Records with no `payloadId` fall back to `conversationId:timestamp`. All matching must go through `getPayloadId`. Test this in Task 2.
2. A record with empty `payload.history` is **ineligible** for collapse. Every entry vacuously having the keys must not make it count as covered. Test this in Task 5.
3. The same `(history_index, role)` under a different `conversationId` must not supersede. Test this in Task 5.
4. A run that defers immediately (aborted signal) must still persist healed and superseded statuses. Test this in Task 2.
5. Codex `<id>@<n>` sentinel records have unique ids and possibly no `history_index`/`role`. They must still be sent, in order and unchanged. Test this in Task 5.

---

### Task 1: Mark every record sharing the sent payloadId (AC1)
**Files:** Modify `src/providers/plugins/sso/session/processors/conversations/syncProcessor.ts:93-153,299-326`. Test in `__tests__/syncProcessor-dedupe.test.ts` (create).
**Test-first: yes** — two `pending` records with the same `payloadId`. Expect one `upsertConversation` call and both records `success` afterwards. A second `process()` makes zero calls. A failure variant leaves both records `failed` with `syncAttempts: 1`. Today the second record stays `pending` and is sent again.
- [ ] Write the test and confirm it fails.
- [ ] Rewrite `applyPayloadOutcome`. It should update **every** record whose `getPayloadId` equals the sent id and whose status is `pending` or `failed`. Use a `forEach`, not `findIndex`. Leave `success` and `superseded` records untouched. Inside the send loop, skip any candidate whose id is already in `successfulPayloadIds` or `failedByPayloadId`, so each id is sent at most once per run.
- [ ] Run the new test plus `syncProcessor-incremental-persistence.test.ts`. Both should pass.

### Task 2: Heal pending duplicates of successful ids on read (AC2)
**Files:** Create `src/providers/plugins/sso/session/processors/conversations/payloadQueue.ts`. Modify `syncProcessor.ts:59-70,288-292`. Extend the test in `syncProcessor-dedupe.test.ts`.
**Interfaces (Produces):**
```ts
export function getPayloadId(payload: ConversationPayloadRecord): string; // moved verbatim from syncProcessor.ts:288-292
export function healSyncedDuplicates(allPayloads: ConversationPayloadRecord[]): number; // in place; returns healed count
```
**Test-first: yes** — a `success` record and a `pending` record share an id. Expect zero `upsertConversation` calls and the file shows both as `success`. Add the same case with no `payloadId` (fallback id). Add the same case with an already-aborted `AbortSignal`: the healed status must still be on disk.
- [ ] Write the tests and confirm they fail.
- [ ] Implement `healSyncedDuplicates`. Collect the ids of `success` records. Set every `pending` or retryable `failed` record with one of those ids to `success`. Do not increment `syncAttempts`. Do not send.
- [ ] In `processConversations`, call it right after `readJSONL`. If the count is above 0, run `writeJSONLAtomic` before the candidate filter and before the "No pending payloads" early return. Import `getPayloadId` from `./payloadQueue.js`.
- [ ] Run the tests and confirm they pass.

### Task 3: Sync step stops writing `lastSyncedMessageUuid` (AC3, AC4)
**Files:** Modify `syncProcessor.ts:171-238,328-335`. Extend the test in `syncProcessor-dedupe.test.ts`.
**Test-first: yes** — three pending Claude-style records with digit-led UUID payloadIds (`1234abcd-…`, `8e2f…`, `ab12…`) and history indices 0, 1, 2. The newest one fails. Expect `metadata.syncUpdates.conversations` to have no `lastSyncedMessageUuid` key, `lastSyncedHistoryIndex === 1`, and `conversationId` set. Pass the result through `applyProcessingSyncUpdates` (`@/agents/core/session/sync-state-utils.js`) on a session whose pointer is the newest UUID. The pointer must be unchanged. Today it is rewound to `1234abcd-…`.
- [ ] Write the test and confirm it fails.
- [ ] Replace the "latest payload" ranking block. Compute `maxHistoryIndex` over the successful payloads only. Take `conversationId` from the last successfully sent payload. Drop `lastSyncedMessageUuid` from the returned `conversations` object. Delete `parseSourceIndex`, which has no other callers.
- [ ] Run the tests and confirm they pass.

### Task 4: Claude dedupe-before-append (AC5)
**Files:** Modify `src/agents/plugins/claude/session/processors/claude.conversations-processor.ts:101-226`. Test in `src/agents/plugins/claude/__tests__/claude.conversations-processor-dedupe.test.ts` (create). Use a temp `CODEMIE_HOME`, seed a session via `SessionStore.saveSession`, pre-write `{sessionId}_conversation.jsonl`, and follow `codex.conversations-processor.test.ts` for the already-queued shape.
**Test-first: yes** — the JSONL already holds a record (status `success`) whose `payloadId` equals the next turn's `lastProcessedMessageUuid`. After `processSession`, no record has been appended, and the saved session's `sync.conversations.lastSyncedMessageUuid` has advanced to that UUID. Second case: two `processSession` calls start from the same reset pointer, which simulates Stop and SubagentStop. They leave exactly one record for the turn.
- [ ] Write the tests and confirm they fail.
- [ ] Before the drain loop, call `readJSONL` (`@/providers/plugins/sso/session/utils/jsonl-reader.js`) on `conversationsPath`. Build a `queuedPayloadIds: Set<string>` from the records, in any status, using `payloadId ?? lastProcessedMessageUuid`. In the loop, call `appendFile` only when the id is not in the set, then add the id to the set. Advance `localSync`, `lastSyncUpdate` and the CR-002 checkpoint either way. Change the `turnsWritten === 0` early return to fire only when `lastSyncUpdate` is undefined, so a skip-only run still returns its sync update. Log skips with `logger.debug`, mirroring `codex.conversations-processor.ts:126-162`.
- [ ] Run the tests and `claude.conversations-processor.test.ts`. Both should pass.

### Task 5: `superseded` status and collapse (AC7, AC8)
**Files:** Modify `conversations/types.ts:10-14` (add `SUPERSEDED: 'superseded'`), `payloadQueue.ts` and `syncProcessor.ts` (candidate selection). Extend the test in `syncProcessor-dedupe.test.ts`.
**Interfaces (Produces):**
```ts
// candidates in queue-file order; sets status 'superseded' in place; returns superseded count
export function collapseSupersededPayloads(candidates: ConversationPayloadRecord[]): number;
```
**Test-first: yes** — the cases below. Today all of them send every record.
- Three pending records, each with `{history_index:0, role:'Assistant'}`. Only the last is sent. The first two become `superseded`, are not counted as failures, and are persisted.
- Record A has `User 0` and `Assistant 0`. Continuation B has only `Assistant 0`. Both are sent (A is only partly covered), in order.
- Same keys under different `conversationId`s: both are sent.
- An empty-history record is not superseded.
- Codex sentinel records `c@0`, `c@1`, `c@2` with history entries that lack `role` are all sent in order, unchanged.
- [ ] Write the tests and confirm they fail.
- [ ] Implement `collapseSupersededPayloads`. A record is eligible when `history.length > 0` and every entry has a numeric `history_index` and a string `role`. Walk from newest to oldest and accumulate the keys `${conversationId}|${history_index}|${role}` seen in newer eligible records. Mark an eligible record `superseded` when all of its keys are already in the accumulated set.
- [ ] In `processConversations`, call it on the filtered candidates after healing. Drop the superseded ones. Fold its count into the pre-send `writeJSONLAtomic` condition from Task 2.
- [ ] Run the tests and confirm they pass.

### Task 6: Per-run send cap (AC6)
**Files:** Modify `conversations/constants.ts` (add `export const MAX_CONVERSATION_PAYLOADS_PER_RUN = 50;`) and `syncProcessor.ts` (after collapse, before the send loop). Extend the test in `syncProcessor-dedupe.test.ts`.
**Test-first: yes** — 51 unique pending records. The first `process()` makes 50 `upsertConversation` calls, oldest first, and leaves 1 `pending`. A second `process()` sends the remaining one. Add 60 records where 10 are superseded duplicates: all 50 survivors are sent in one run.
- [ ] Write the tests and confirm they fail.
- [ ] Slice the post-collapse candidates to `MAX_CONVERSATION_PAYLOADS_PER_RUN`. Use the sliced length in the result message and in `remainingCount`. Log the deferred remainder with `logger.debug`.
- [ ] Run the tests and confirm they pass.
