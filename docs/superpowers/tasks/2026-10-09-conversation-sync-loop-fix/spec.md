# Spec — Stop conversation-sync re-send loops (EPMCDME-15771)

**Date**: 2026-10-09 · **Size**: M (18/36) · **Requirements**: `docs/stories/2026-10-09-conversation-sync-loop-fix/story.md`
**Research**: `technical-analysis.md` (same folder)

## Problem

Since v0.15.2 (#557, 7472ea8a), `applyPayloadOutcome` (`syncProcessor.ts:299-326`) marks only the *first* record carrying the sent payloadId. When an older `success` record shares the id, the pending duplicate that was actually sent stays pending and is re-PUT on every sync tick. Duplicates arise because (1) the sync step rewrites `lastSyncedMessageUuid` to the latest *successful* payload (`syncProcessor.ts:171-238`), rewinding the Claude transform pointer so old turns are re-queued under new history indices, and (2) concurrent Stop/SubagentStop hooks append the same turn with no already-queued check (`claude.conversations-processor.ts:169-183`).

## Delivery

One spec, two phases. **Phase 1** (AC1, AC2) is self-contained and shippable as hotfix 0.15.8. **Phase 2** (AC3–AC8) follows.

## Design

### Phase 1 — outcome marking and queue healing (`syncProcessor.ts`)

- **Outcome marking.** After each send, every not-yet-successful record whose `getPayloadId` equals the sent id gets the outcome: success on success, or `failed` with `syncAttempts` incremented on failure. This restores the pre-#557 "mark all by id" semantics but keeps per-payload persistence and deadline deferral.
- **Healing on read.** Before choosing what to send, any `pending` or retryable `failed` record whose payloadId already has a `success` record is set to `success` without being sent. The healed queue is persisted in the same run. Old queues heal on first sync after upgrade.

### Phase 2

1. **No pointer rewind.** Remove `conversations.lastSyncedMessageUuid` from syncProcessor's syncUpdates entirely. Each transform processor (claude, codex, opencode, pi, gemini, copilot-cli) remains the sole writer of its own pointer. `lastSyncedHistoryIndex` is still reported as the max history index sent. `parseSourceIndex` is deleted if it has no remaining caller. Merges in `sync-state-utils.ts`, `claude.session.ts:545` and `ClaudeDesktopTelemetryAdapter.ts:147` are left unchanged.
2. **Claude dedupe-before-append.** `ConversationsProcessor.processMessages` reads `{sessionId}_conversation.jsonl` once before its drain loop and builds a set of the queued payloadIds, covering records in any status. A result whose payloadId is already in the set is not appended. Its CR-002 checkpoint still advances, mirroring codex `codex.conversations-processor.ts:126-162`. Each new append adds its id to the set.
3. **Collapse (record-level, all agents).** Collapse runs after healing and only among send candidates (pending or retryable failed).
   - A record is *eligible* only if every entry in `payload.history` carries `history_index` and `role`. Ineligible records pass through untouched.
   - An older eligible record is set to `superseded` when every one of its `(conversationId, history_index, role)` keys also appears in a newer eligible record. "Newer" means a later position in the queue file.
   - A record that is only partly covered is sent whole.
   - Superseded records are never sent, never counted as failures, and are persisted.
4. **Per-run cap.** A module constant `MAX_CONVERSATION_PAYLOADS_PER_RUN = 50` in `conversations/constants.ts` limits API sends per sync run. Candidates are sent oldest-first in queue order. Records beyond the cap stay as they are for the next run. Healed and superseded records do not count toward the cap.

Read pipeline order: **heal → collapse → cap → send**.

### Data shape change

```ts
// conversations/types.ts — ConversationPayloadRecord
status: 'pending' | 'success' | 'failed' | 'superseded';
```

`superseded` is terminal. The candidate filter (`syncProcessor.ts:61-65`) never selects it.

## Acceptance criteria

- **AC1** — Two records for one turn identifier: across repeated syncs, the turn is sent at most once, and no record for it is pending after the first success.
- **AC2** — A pending record whose identifier already has a `success` record is marked `success` without being sent.
- **AC3** — After a sync with several successes, the session's `lastSyncedMessageUuid` is never earlier than before the sync. The sync step does not write it.
- **AC4** — The newest queued turn fails and older ones succeed: the next hook queues no already-synced turn again, and the conversation gains no duplicate turns.
- **AC5** — Two hook events for the same session processed together queue the turn once, within the limits of a lock-free read-before-append.
- **AC6** — More than 50 send candidates: a single run sends no more than 50, and the rest remain for the next run.
- **AC7** — Several pending records for the same (conversation, history_index, role): only the newest is sent, and the older fully-covered ones become `superseded` (not sent, not failures).
- **AC8** — A normal session with no duplicates: every turn reaches CodeMie with unchanged content and order. Codex/opencode/pi `@<index>` sentinel payloads behave as before.

## Non-goals

- SSO expiry, redirect handling and credential refresh during sync.
- The cross-process sync-lock timeout, and the race between hook `appendFile` and `writeJSONLAtomic`.
- Server-side throttling or skipping of unchanged uploads.
- Gemini/Copilot/Codex/OpenCode/Pi behaviour beyond the shared syncProcessor change.
- Repairing duplicate turns already stored server-side.
- Monotonic guards in `sync-state-utils.ts` and the adapter merges. An env-configurable cap.

## Verification cases

Extend the temp-`CODEMIE_HOME` plus mocked-`apiClient` harness (`syncProcessor-incremental-persistence.test.ts`) with:
- duplicate ids with mixed success and pending records;
- healing on read;
- collapse, including a continuation re-sending only the Assistant entry and a partly covered record;
- the cap at 51 or more records;
- the absence of `lastSyncedMessageUuid` in syncUpdates.

For the Claude processor: a pre-queued payloadId is skipped and its checkpoint still advances.
