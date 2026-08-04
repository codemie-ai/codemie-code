# Spec — EPMCDME-13675: log `!bash` commands in codemie-claude sessions

## Problem

When a user runs `!<cmd>` bash commands inside a `codemie-claude` interactive
session, none of the following appears in the CodeMie session log
(`~/.codemie/sessions/<sid>_conversation.jsonl`), or appears wrong:

1. Single `!ls -al` — logged as raw XML `<bash-input> ls -al</bash-input>`
   instead of `!ls -al`.
2. Multiple bash commands followed by a real code question — only the first
   `<bash-input>` message is captured; the rest of the bash commands, the
   follow-up question, and the assistant's answer are all silently dropped.

Root cause is entirely within
`src/agents/plugins/claude/session/processors/claude.conversations-processor.ts`:

- `extractCommand()` recognizes only `<command-name>/slash</command-name>`; it
  returns `null` for `<bash-input>`, so `extractUserMessage()` falls back to the
  raw string.
- `<bash-stdout>` and `<bash-stderr>` are not in `isSystemMessage()`'s prefix
  list, so each becomes a fresh "turn" that consumes the processor's
  single-turn-per-invocation slot.
- `transformMessages()` processes exactly one turn per invocation. Bash
  commands do not fire the Claude Code `Stop` hook (no assistant response),
  so only two `processSession()` calls happen in total (Stop after the real
  question, SessionEnd on exit). With N bash commands before the real
  question, most of them are never processed.

## Goal

Satisfy the Jira acceptance criteria verbatim:

- `!` bash commands executed in a codemie-claude interactive session are
  recorded in the local session log.
- Multiple bash commands in one session are captured in the correct order.
- A following code-related prompt does not cause previously executed bash
  command log entries to be lost.
- The log output clearly distinguishes user prompts, bash commands, and
  assistant responses.
- Claude Code execution behavior remains unchanged.

## Design

Three changes, all inside `claude.conversations-processor.ts`.

### 1. Unwrap `<bash-input>` into `!<cmd>` in the User message text

In `extractCommand()` (or `extractUserMessage()`), add a branch for
`<bash-input>...</bash-input>`. When matched, return `!` + the inner text
trimmed. This mirrors the `<uploaded_files>` unwrapping precedent
(`extractUploadedFiles()`, lines 695–711 of the processor) and gives the user
entry the same text they typed.

Example transformation:
- input:  `<bash-input> ls -al</bash-input>`  → output: `!ls -al`
- input:  `<bash-input> ls -al </bash-input>` → output: `!ls -al`

### 2. Filter bash output injections in `isSystemMessage()`

Add `<bash-stdout>` and `<bash-stderr>` to the prefix list in
`isSystemMessage()`. Rationale: they are terminal output injected by Claude
Code (not user-typed), functionally equivalent to `<local-command-stdout>`
which is already in that list. Filtering them stops them from being treated
as fresh user turns.

`<bash-input>` is NOT added to that list — it is a real user event and must
appear in the log per AC.

### 3. Drain all pending turns per invocation in `processMessages()`

Replace the single-turn write with a bounded loop:

```
let localSyncState = { ...syncState };
let lastMetadata = null;
while (true) {
  const result = await this.transformMessages(messages, localSyncState, ...);
  if (result.history.length === 0) break;
  await appendFile(conversationsPath, JSON.stringify(payloadRecord) + '\n');
  localSyncState = {
    lastSyncedMessageUuid: result.lastProcessedMessageUuid,
    lastSyncedHistoryIndex: result.currentHistoryIndex,
  };
  lastMetadata = { ...updates for final syncUpdates };
}
return { ...uses lastMetadata for the final syncUpdates persisted to disk };
```

Iterations are bounded by the count of unprocessed real user messages — in
practice at most ~10–20 per invocation. `transformMessages` continues to
process exactly one turn per call; the loop is added around it. No change to
turn semantics, `isTurnContinuation` behavior, or payload schema.

## Out of scope

- No changes to the session adapter, hook router, sub-agent parsing,
  metrics processor, or downstream API sync.
- No new hook events, no new env vars, no config file changes.
- No changes to the "do not break on `system` records" mid-turn scanner
  (lines 271–275, 318–322) — that decision remains load-bearing.
- No integration-test fixtures are added — unit tests exercising
  `transformMessages` and `processMessages` directly are sufficient.

## Acceptance tests (from Jira AC)

Written as failing unit tests first (TDD).

1. **Single `!ls -al`**: emits one User entry whose `message` is `!ls -al`,
   with no raw `<bash-input>` XML.
2. **`!ls -al ` (trailing space)**: same as (1), trimmed.
3. **`<bash-stdout>` / `<bash-stderr>` alone**: filtered — no User entry
   emitted, no advancement of `lastSyncedHistoryIndex`.
4. **Multi-bash + code question**: three bash commands followed by a real
   question that gets an assistant answer — history contains one User entry
   per bash command in order, then the question User entry, then the
   assistant Assistant entry.
5. **`transformMessages` mid-turn `system` regression**: existing test
   remains green (no behavior change to the assistant-answer path).

## Risks / caveats

- **Sync-state advancement change**: after the fix, `lastSyncedMessageUuid`
  will advance through every pending turn, not just the first. That's the
  intended behavior. The existing incremental-processing integration
  fixture (`tests/integration/session/fixtures/claude/incremental-simple/`)
  must remain green — the loop terminates naturally when it hits the same
  "no more turns" condition as the original single-shot code path.
- **Turn continuation on Stop → SessionEnd**: if the Stop hook lands mid-turn
  and SessionEnd finalizes the same turn, `isTurnContinuation` still guards
  the User entry from being re-emitted. The loop uses the same
  `transformMessages` results, so this remains correct.
- **Loop bound**: the number of iterations is bounded by
  `messages.length / 2`. There is no unbounded work; the loop always
  terminates because `transformMessages` returns `history.length === 0`
  when no new real user message can be found.
