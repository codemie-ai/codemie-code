# Technical Research

**Task**: hook own-generation subagent-stop session
**Generated**: 2026-11-23
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-16971: SubagentStop hook proceeds with sync when no session record exists yet, causing 'Session metadata not found' / 'Session not found' failures. Root cause: ensureOwnGeneration in src/cli/commands/hook/own-generation.ts returns 'own' when no session record exists (`if (!record || !isOtherGeneration(...)) return 'own'`). handleSubagentStop in src/cli/commands/hook.ts then calls performIncrementalSync unconditionally, and claude.metrics-processor.ts / claude.conversations-processor.ts fail because SessionStore.loadSession(sessionId) returns null. Suggested fix: treat a missing session record as 'not yet ready' - ensureOwnGeneration (or handleSubagentStop) should defer (nothing synced, no waiting/blocking). An existing RED test is at src/cli/commands/hook/__tests__/own-generation.missing-record.test.ts (expects 'deferred'; currently gets 'own'). Must enumerate EVERY caller of ensureOwnGeneration (handleStop, handleSubagentStop, others) and the existing tests covering them, and say how each would be affected by returning 'deferred' for a missing record. Out of scope: SendMessage tool availability.

---

## 2. Codebase Findings

### Existing Implementations
Purpose: decide whether a hook event may write to `{id}.json`.
- `ensureOwnGeneration` `src/cli/commands/hook/own-generation.ts:47-75`. Reads `readLiveRecord(sessionId)`, falling back to `SessionStore.loadSession`. Line 56: `if (!record || !isOtherGeneration(record, event.session_id)) return 'own'`. Return values: `own | closed | created | deferred`. `deferred` is documented as "lock held by another process; tried once, never waited for". It is also returned (line 74) when no own record could be written.
- `isOtherGeneration` (line 14) returns false when the record is null.

Callers of `ensureOwnGeneration` (grep over src, tests and docs; the only non-test hits are in `hook.ts`):
1. `handleStop`, `hook.ts:735-744`. It returns early on `deferred` or `closed`. It also returns early if `isCompletedRecord`. Otherwise it runs `accumulateActiveDuration` and then `performIncrementalSync`.
2. `handleSubagentStop`, `hook.ts:751-757`. It returns early on `deferred` or `closed`. Otherwise it runs `performIncrementalSync`.
3. Router `hook.ts:847` (Stop) and `:855` (SubagentStop) only dispatch to the two handlers above.
4. The new RED test `own-generation.missing-record.test.ts`. It is untracked, so it is not committed yet.

No other callers were found. `handleSessionStart` uses `createSessionRecordOverUnclosed` directly (`hook.ts:260`).

Effect of returning `deferred` for a missing record, per caller:
- `handleSubagentStop`: already treats `deferred` as a no-op. It would skip sync, which is the intended fix.
- `handleStop`: the code is unchanged and it also skips. This is a behavior change. A Stop with no record currently runs `accumulateActiveDuration` and `performIncrementalSync`, which likely fail the same way. With the change it silently skips. Nothing else in `handleStop` creates a record. After the router's switch, `hook.ts:~866-880` loads the session for the ownership marker on UserPromptSubmit and Stop. That path is independent of `handleStop`'s return and still runs.
- `deferred` is not a distinct signal. The existing warn log at line 70 says the lock is held, which would be wrong for a missing record. A different log message would be needed there.
- Within `ensureOwnGeneration`, the missing-record check is before the `isOtherGeneration` branch. A shared change would also affect Stop. Putting the check in `handleSubagentStop` only would leave Stop as it is.

### Decisions Already in the Code
- The doc comment (line 39) defines `own` as "no record, or one of this generation". The missing-record-is-own choice is recorded there, with no reason given. A change here contradicts that comment.
- `deferred` means "write nothing, don't wait" (a Stop hook blocks the agent's turn). This matches the task's "no waiting/blocking".
- Both the lookup and the sync read the record via `SessionStore.loadSession`, so a missing record means the sync has nothing to update.

### Task Statements Checked Against the Code
- "ensureOwnGeneration returns 'own' when no record exists": holds (line 56).
- "handleSubagentStop calls performIncrementalSync unconditionally": holds for `own` and `created` (`hook.ts:752-756`).
- "processors fail because loadSession returns null": unverified. I did not open `claude.metrics-processor.ts` or `claude.conversations-processor.ts`.
- "Existing RED test expects 'deferred'": holds. It sets `CODEMIE_HOME` to an empty temp dir, uses a SubagentStop event, and expects `deferred`.
- The task does not say whether a missing record should defer for Stop or for other event types. The test covers only SubagentStop.

### Consumers of Changed Contracts
The return union of `ensureOwnGeneration` is consumed only by `handleStop` and `handleSubagentStop`. Both already handle `deferred`. No other consumers were found.

### Architecture and Layers Affected
CLI command layer (`src/cli/commands/hook.ts` and `hook/own-generation.ts`). The session-store layer (`src/agents/core/session`) is read only.

### Integration Points
`readLiveRecord` and `reconcileLockPath` from `stale-session-reconciliation.ts`. `SessionStore`. `createSessionRecordOverUnclosed` (dynamic import from `hook.ts`).

### Patterns and Conventions
ES modules with `.js` import extensions. `logger` for output. Dynamic imports are used inside the function.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists. Per AGENTS.md the relevant guides are architecture and development-practices. I did not read them in depth. `docs/ARCHITECTURE-OTLP-PLUGIN.md` is unrelated.

### Architectural Decisions
None found beyond the doc comment on `ensureOwnGeneration`.

### Derived Conventions
Hook handlers return early on `deferred` and `closed`.

---

## 4. Testing Landscape

### Existing Coverage
- `src/cli/commands/hook/__tests__/own-generation.missing-record.test.ts` (new, RED).
- `generation-close.aside.test.ts` and `delivery.attempt.test.ts` sit in the same dir. They have no direct references to `ensureOwnGeneration` (grep).
- `src/agents/core/session/__tests__/stale-session-reconciliation.test.ts` references `commands/hook`. I did not inspect whether it exercises Stop or SubagentStop with no record.
- There is no test of `handleStop` or `handleSubagentStop` that references `ensureOwnGeneration` by name.

### Testing Framework and Patterns
Vitest. The new test sets `CODEMIE_HOME` to a temp dir and uses a dynamic import.

### Coverage Gaps
There is no test for `handleStop` with a missing record, and none for the log message on that path.

---

## 5. Configuration and Environment

### Environment Variables
`CODEMIE_HOME` determines the sessions directory (used by the test).

### Configuration Files
None relevant.

### Feature Flags and Deployment Concerns
None found.

---

## 6. Risk Indicators

- Speculative: changing the shared function also changes Stop. A Stop before any SessionStart record now skips accumulate and sync (`hook.ts:737`). Data in that turn could be dropped if no later event recovers it.
- Speculative: a legitimate first Stop or SubagentStop for a session whose record is created later (late-start paths) would be deferred with nothing queued. Whether a later event picks it up is unverified.
- The warn message at `own-generation.ts:70` describes a lock conflict, so it would mislead if reused for a missing record.
- The doc comment at line 39 states `own` includes "no record" and would contradict the new behavior.
- Existing callers other than the two handlers: none, so the blast radius is small.
- Processor failure causes were not verified (processor files unread).

---

## 7. Summary for Complexity Assessment

Two source files are involved: `src/cli/commands/hook/own-generation.ts` and, optionally, `src/cli/commands/hook.ts`. Only the CLI hook layer is touched. Both callers of `ensureOwnGeneration` (`handleStop`, `handleSubagentStop`) already return early on `deferred`, so no caller needs to change for the `deferred` value to take effect.

There is no technical novelty. The choice is where the check goes. In `ensureOwnGeneration` it also affects Stop. In `handleSubagentStop` alone it affects only SubagentStop. Research did not weigh these.

Coverage is thin. One RED unit test targets `ensureOwnGeneration` directly. There is no handler-level test for Stop or SubagentStop. The main risk is the Stop behavior change and possible dropped data.

---

## 8. External References

None named by the task.
