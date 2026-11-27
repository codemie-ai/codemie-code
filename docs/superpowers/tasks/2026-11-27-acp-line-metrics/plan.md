# EPMCDME-14384 claude-acp line metrics Implementation Plan

**Goal:** claude-acp runs get a CodeMie session record and `fileOperations` line metrics, via wrapper-side lifecycle (codex/opencode pattern).

**Architecture:** `ClaudeAcpPluginMetadata` gets `onSessionStart/onSessionEnd`; `ClaudeSessionAdapter` gets `encodeClaudeProjectDir` and `locateTranscript`. No change to plain `claude`, `recordTranscriptCorrelation`, `processSession` signature, reconcile code, or `default-agent-hooks.ts`.

**Conventions:** Commit per task using the repository's existing convention (`.ai-run/guides/standards/git-workflow.md`, ticket EPMCDME-14384). No push, no MR. Vitest project "unit", dynamic-import mocking after setup, `.js` import extensions, `logger` only (ACP stdout is JSON-RPC). Fixture: `~/dev/codemie-dev/EPMCDME-14384-evidence/transcripts/acp-fixture.jsonl` (copy a sanitized version into `src/agents/plugins/claude/__tests__/fixtures/` for tests; expected 7 added / 2 removed).

Note (not a task): AC9, the manual harness run from `acp-repro`, is owned by the handoff stage.

---

### Task 1: Spike - repeated processSession on one CodeMie id
Files: new test `src/agents/plugins/claude/__tests__/claude.session.repeat-process.test.ts`; reads `claude.session.ts:619` (`processSession`).
- Create a record, call `processSession` for two distinct transcripts with the same CodeMie id, assert `fileOperations` are summed (deltas, baseline cutoff, `recordId` dedupe). Also call twice on the same file to see whether it is idempotent.
- Keep the test as the permanent record of the outcome (it asserts the observed behaviour). Write the outcome ("sums" or "fallback: earliest only") as a comment at the top of the test; Task 4 branches on it.
- Test-first: no — characterization spike; it establishes behaviour for Task 4 rather than driving new code.

### Task 2: encodeClaudeProjectDir (AC8)
Files: `src/agents/plugins/claude/claude.session.ts:32` (beside `decodeClaudeProjectDir`); test in `__tests__/ClaudeSessionAdapter.test.ts` or a new `claude.encode-project-dir.test.ts`.
- Export `encodeClaudeProjectDir(cwd: string): string`: `realpath` first (fall back to the input when it does not exist), then every non-alphanumeric char becomes `-`. Leave the decoder untouched.
- Test-first: yes — `/Users/jane_doe/dev/my-repo` encodes to `-Users-jane-doe-dev-my-repo`; a dot-named temp dir reached through a symlink encodes from the realpath; a round-trip check against `decodeClaudeProjectDir` for a simple path.

### Task 3: ClaudeSessionAdapter.locateTranscript (AC5)
Files: `src/agents/plugins/claude/claude.session.ts` (near `getProjectsDir`, `:76`); new test `__tests__/claude.locate-transcript.test.ts` modelled on `opencode/__tests__/opencode.locate-transcript.test.ts`.
- Read-only `locateTranscript(record)`: directory = `getProjectsDir()/encodeClaudeProjectDir(record.workingDirectory)`. `stat` every `*.jsonl` first and drop by birth/mtime before reading any first event (arch-review note). Keep files at or after the run start and before `nextRecordStartInDirectory` (reuse `src/agents/core/session/next-record-start.ts`), and drop any that is another record's `correlation.agentSessionFile`. Return paths sorted by time, `[]` when none. No search of other directories.
- Debug logs: cwd used, encoded dir, dir exists, files found, dropped as outside window, dropped as claimed.
- Test-first: yes — fails today as the method is undefined. Cases: unknown cwd gives `[]`; file older than the run start excluded; file at/after next record start excluded; file claimed by another record excluded (foreign-transcript); two valid files returned in time order; `CLAUDE_CONFIG_DIR` honoured.

### Task 4: claude-acp lifecycle (AC1-AC4)
Files: `src/agents/plugins/claude/claude-acp.plugin.ts:16` (metadata) and a `buildHookConfig(env, sessionId)` helper copied in shape from `codex.plugin.ts`/`opencode.plugin.ts:271`; new test `__tests__/claude-acp.lifecycle.test.ts`.
- Set `lifecycle: {...ClaudePluginMetadata.lifecycle, onSessionStart, onSessionEnd}` so `beforeRun` is kept; do not edit `claude.plugin.ts`.
- `onSessionStart`: dynamic-import `processEvent` from `@/cli/commands/hook.js`, send `{hook_event_name:'SessionStart', transcript_path:'', ...}`; wrap in non-blocking try/catch.
- `onSessionEnd(exitCode, env)`: load the record, `locateTranscript`. None found: `logger.warn`, skip processing, still send `processEvent(SessionEnd)` so the record ends (AC3). Otherwise `recordTranscriptCorrelation(sessionId, earliest)`, then per the Task 1 outcome: sums gives `processSession` for each file in time order; fallback gives the earliest only plus a `logger.warn` listing the skipped transcripts. Then `processEvent(SessionEnd)` with `transcript_path: ''`. All steps in try/catch.
- Test-first: yes — with the fixture in a temp `CLAUDE_CONFIG_DIR` under the cwd's encoded dir, start then end yields a record with 7 added / 2 removed (fails on current code); `ClaudePluginMetadata.lifecycle` has no `onSessionStart/End` and the ACP lifecycle still has `beforeRun` (AC2); no transcript gives a warn, no throw, record ended (AC3); two transcripts follow the spike-chosen branch with no double count (AC4).

### Task 5: Reentry and reconciliation coverage (AC6, AC7)
Files: new tests `__tests__/claude-acp.reentry.test.ts` and a case in `src/agents/core/session/__tests__/stale-session-reconciliation.test.ts`.
- AC7: a live hook-created record (`status==='active'`, no `endTime`) exists; `onSessionStart` creates no second record and `onSessionEnd` writes into the existing one (`hook.ts:944-977`).
- AC6: a stale `claude-acp` record without `agentSessionFile` is finalized by reconciliation through `locateTranscript`, with metrics recorded. Add a case showing a `claude` record that already has `agentSessionFile` does not call `locateTranscript`.
- Test-first: yes — the AC6 test fails before Task 3; if AC7 passes on first run, tighten it until it asserts a real record-count invariant, so it is not vacuous.

---

## Negative-constraint pass
- Not editing plain `claude` lifecycle, hooks or `default-agent-hooks.ts`: Task 4 spreads the lifecycle and does not touch `claude.plugin.ts`; its test asserts that.
- Not changing `recordTranscriptCorrelation`, the `processSession` signature or reconcile code: Tasks 3-5 only add the adapter method and call existing APIs.
- No search of other directories by time: Task 3 looks only in the encoded cwd dir.
- No incremental sync, no skills-sync gating, no summation beyond the spike outcome: none planned.
- No push or MR: header.
