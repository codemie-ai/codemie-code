# Plan — EPMCDME-13675

Repo: `/Users/Evgenii_Kurdakov/Desktop/projects/codemie-dev/codemie-code`
Branch: `EPMCDME-13675`
Spec: `docs/superpowers/tasks/2026-07-30-bash-input-logging/spec.md`

All implementation tasks are TDD. Every task has:
- **Test-first: yes** — write the failing test(s) first and see RED before
  writing any production code.
- **Failing test description** — the assertion(s) that must exist in RED.

Files touched:
- `src/agents/plugins/claude/session/processors/claude.conversations-processor.ts`
- `src/agents/plugins/claude/__tests__/claude.conversations-processor.test.ts`

## Task 1 — Unwrap `<bash-input>` in `extractCommand()` / `extractUserMessage()`

**Test-first: yes** — assertion: given a user message with content
`<bash-input> ls -al</bash-input>`, `transformMessages` emits exactly one
User entry whose `message` equals `!ls -al`. Also assert `message` does
NOT contain the substring `<bash-input>`.

Implementation:
1. In `extractCommand(content)` (approx. line 763), add a second regex
   branch:
   ```
   const bashMatch = content.match(/<bash-input>([\s\S]*?)<\/bash-input>/);
   if (bashMatch) return `!${bashMatch[1].trim()}`;
   ```
   Keep the existing slash-command branch intact and return the first match.
2. No other changes to `extractUserMessage` — it already delegates to
   `extractCommand` in both the string and array branches.

Regression guard: the mid-turn `system`-event test and the
`<uploaded_files>` tests must remain green.

## Task 2 — Filter `<bash-stdout>` and `<bash-stderr>` in `isSystemMessage()`

**Test-first: yes** — assertion: given a `type:'user'` message whose content
starts with `<bash-stdout>` (or `<bash-stderr>`), `shouldFilterMessage`
returns `true`. Wrap in `transformMessages` assertion: a session containing
only a `<bash-stdout>` message emits an empty history.

Implementation:
1. In `isSystemMessage()` (approx. lines 587–594), extend the `patterns`
   array to include `'<bash-stdout>'` and `'<bash-stderr>'`.
2. No other filter changes.

Regression guard: `<local-command-stdout>` filtering still works — this is
adjacent behavior and shares the same code path.

## Task 3 — Drain all pending turns per invocation in `processMessages()`

**Test-first: yes** — assertion: given three `<bash-input>` messages
followed by a real user question with an assistant response, running
`processMessages` (or `transformMessages` in a small driver loop) produces
history in this order: `User("!ls -al")`, `User("!pwd")`, `User("!whoami")`,
`User("what is here?")`, `Assistant("<answer>")`. All five entries must
carry monotonically increasing `history_index` values.

Implementation:
1. In `processMessages()` (approx. lines 63–160), wrap the
   `transformMessages` → `appendFile` block in a bounded loop:
   ```
   let localSync = { ...syncState };
   let lastSyncUpdate: any = undefined;
   let totalRecords = 0;
   let turnsWritten = 0;

   while (true) {
     const result = await this.transformMessages(
       session.messages, localSync, '5a...', session.agentName,
       context.agentSessionFile
     );
     if (result.history.length === 0) break;

     const historyIndices = result.history.map((e: any) => e.history_index);
     const payloadRecord = { /* same shape as today */ };
     await appendFile(conversationsPath, JSON.stringify(payloadRecord) + '\n');

     totalRecords += result.history.length;
     turnsWritten++;
     lastSyncUpdate = {
       conversations: {
         lastSyncedMessageUuid: result.lastProcessedMessageUuid,
         lastSyncedHistoryIndex: result.currentHistoryIndex,
       },
     };
     localSync = {
       lastSyncedMessageUuid: result.lastProcessedMessageUuid,
       lastSyncedHistoryIndex: result.currentHistoryIndex,
     };
   }

   if (turnsWritten === 0) {
     return { success: true, message: 'No history generated',
              metadata: { recordsProcessed: 0 } };
   }
   return { success: true,
            message: `Generated ${turnsWritten} turn${turnsWritten !== 1 ? 's' : ''}`,
            metadata: { recordsProcessed: totalRecords, syncUpdates: lastSyncUpdate } };
   ```
2. `transformMessages` remains unchanged (still one turn per call).
3. Loop is bounded by the count of unprocessed user messages; it terminates
   naturally when `history.length === 0` (the existing base case).

Regression guard: the existing integration fixture (`incremental-simple/`)
still passes — because with a session that has one turn per invocation the
loop runs once and behaves identically to the current code.

## Task 4 — Test: `<bash-stderr>` alongside `<bash-stdout>` filtered

**Test-first: yes** — assertion: a session containing `<bash-input>` +
`<bash-stdout>` + `<bash-stderr>` produces exactly one User entry (from the
bash-input), no entries from stdout or stderr.

Implementation: no production code — this is a coverage-only test that
belongs to Task 2's behavior but is broken out because it exercises the
full three-message shape observed in real Claude JSONL.

## Validation

After all four tasks are GREEN:
1. `npm run test -- src/agents/plugins/claude` — unit tests for the
   affected package all pass.
2. `npm run test -- tests/integration/session` — integration coverage
   for the session adapter remains green.
3. `npm run lint` — no new warnings.
4. `npm run typecheck` — clean.

## Out of scope (do not do)

- Do not modify `claude.session.ts`, hook router, or downstream sync.
- Do not add integration-test fixtures.
- Do not add feature flags or env vars.
- Do not touch `MetricsProcessor` or `strip-clear.ts`.

## Commit strategy

One commit per task with Conventional Commits format:
- `fix(agents): unwrap <bash-input> into !cmd for conversation logs (EPMCDME-13675)`
- `fix(agents): filter <bash-stdout>/<bash-stderr> in isSystemMessage (EPMCDME-13675)`
- `fix(agents): drain all pending turns per processSession invocation (EPMCDME-13675)`
- `test(agents): cover !bash-input logging end-to-end (EPMCDME-13675)`

If the tests all land in Task 4, tasks 1–3 can share their tests with
task 4 to avoid RED-GREEN thrash; grouped commit per logical change.
