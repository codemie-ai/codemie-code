# EPMCDME-14384: CodeMie session record and line metrics for claude-acp

## Problem
`claude-acp` runs bare `claude-agent-acp`, so the `--plugin-dir` SessionStart hook (added only for agent `claude`, `src/providers/core/default-agent-hooks.ts:86-88`) never runs. No session record is created and line-change metrics stay 0. The ACP transcript is fine: `extractClaudeFileOperation` gives correct counts (fixture `acp-fixture.jsonl`: 7 added, 2 removed; EVIDENCE section 3).

## Approach
Run the lifecycle in the wrapper, as codex and opencode do.

0. **First implementation step, before any other code: a spike.** Verify that two `adapter.processSession` calls for one CodeMie id sum `fileOperations` (deltas, baseline, dedupe by `recordId`). Outcome decides step 3:
   - sums: process every located transcript (below).
   - does not sum: fallback. Process only the earliest transcript; the lines of all later transcripts are not counted (multi-session runs are undercounted); multi-transcript summation moves to a follow-up.
1. `ClaudeAcpPluginMetadata` (`claude-acp.plugin.ts:16`) replaces `lifecycle` with `{...ClaudePluginMetadata.lifecycle, onSessionStart, onSessionEnd}`. The inherited `beforeRun` is kept. `ClaudePluginMetadata` is not modified.
2. `onSessionStart`: `processEvent({hook_event_name:'SessionStart', transcript_path:''...}, buildHookConfig(env, sessionId))`, the codex/opencode shape. Non-blocking try/catch. Logging via `logger` only (ACP stdout is JSON-RPC).
3. `onSessionEnd`: locate transcripts with `ClaudeSessionAdapter.locateTranscript(record)`. If none are found, `logger.warn` and skip (as codex). Otherwise call `recordTranscriptCorrelation` with the earliest file, then `adapter.processSession` once per file (earliest only, if the spike fell back), then `processEvent(SessionEnd)`. In the fallback branch, when more than one transcript was located, `logger.warn` lists the skipped transcripts.
4. `ClaudeSessionAdapter.locateTranscript(record)`: read-only. It looks in `getProjectsDir()` (honours `CLAUDE_CONFIG_DIR`) under the directory for the record's cwd. It returns every `*.jsonl` that:
   - has birth/first-event time at or after the run start and before `nextRecordStartInDirectory` (the run window), and
   - is not already claimed by another record, i.e. is not the `correlation.agentSessionFile` of a different record.
   It returns `[]` when none match. There is no fallback that searches other directories by time.
5. `encodeClaudeProjectDir(cwd)` next to `decodeClaudeProjectDir` (`claude.session.ts:32`). Rule: `realpath` first, then every non-alphanumeric char becomes `-`. Verified on real paths: `/Users/<name_with_underscore>/...` becomes `-Users-<name-with-underscore>-...`; `/tmp/dot.test` becomes `-private-tmp-dot-test` (dot replaced, and `/tmp` resolves to `/private/tmp`). The decode helper stays lossy and is not used for lookup.
6. Debug logging in `locateTranscript` so a wrapper-cwd vs `session/new`-cwd divergence is diagnosable: the cwd used, the encoded directory searched, whether it exists, how many files were found, how many were dropped as outside the window or claimed by another record.

## Multiple transcripts per record
`recordTranscriptCorrelation` stores one `agentSessionFile` and refuses a different one (`no-transcript-correlation.ts:78`). `processSession` takes one file. Resolution: correlate the earliest file only (stable key for reconciliation and ownership). Then, if the spike (step 0) shows summation works, call `processSession(file, codemieSessionId, ctx)` for each located file in time order. Repeated calls for one id are not exercised by any existing caller (analysis section 2), hence the spike. If the spike falls back, a long-lived ACP process that opened several sessions is undercounted: only the first transcript's lines are recorded, and `onSessionEnd` warns with the skipped transcripts. Exact per-ACP-session mapping is a follow-up.

## Acceptance criteria
- AC1: With the fixture placed in a temp `CLAUDE_CONFIG_DIR` under the cwd's encoded directory, running `onSessionStart` then `onSessionEnd` for `claude-acp` yields a session record with `fileOperations` totals 7 added and 2 removed. The test fails on current code.
- AC2: `ClaudePluginMetadata.lifecycle` has no `onSessionStart`/`onSessionEnd` and plain `claude` lifecycle behaviour is unchanged. The `claude-acp` lifecycle still contains the inherited `beforeRun`.
- AC3: With no transcript found, `onSessionEnd` logs a warning, does not throw, and still ends the session record.
- AC4: With two transcripts matching cwd and run window: if the spike shows summation, both are processed and their metrics are summed. If it does not (fallback), only the earliest is processed and its metrics are recorded; the lines of all transcripts after the first are NOT counted (a known undercount for multi-session runs), there is no double count and no error, and `onSessionEnd` writes a `logger.warn` listing the skipped transcripts.
- AC5: `locateTranscript` returns `[]` for an unknown cwd, excludes files older than the run start or at/after `nextRecordStartInDirectory`, and excludes a transcript in the same cwd already claimed by another record's `correlation.agentSessionFile` (foreign-transcript test).
- AC6: A stale `claude-acp` record with no `agentSessionFile` is finalized by reconciliation via `locateTranscript`.
- AC7: With an existing live record for the run created by a hook, `onSessionStart` does not create a second record and `onSessionEnd` writes into the existing one (reentry path, `hook.ts:944-977`; the live-record guard is `existing.status==='active' && endTime===undefined`). A reentry test covers it.
- AC8: `encodeClaudeProjectDir` tests cover an underscore path (`/Users/jane_doe/dev/my-repo` to `-Users-jane-doe-dev-my-repo`) and a dot plus symlink path (a temp dir named with a dot reached through a symlink; the result uses the realpath).
- AC9 (gating, manual): running an ACP client from `~/dev/codemie-dev/EPMCDME-14384-evidence/acp-repro` against the built change yields 7 added / 2 removed in `_metrics.jsonl` and no `Session file not found` in the sync log. The check runs in this harness. Real IntelliJ is NOT verified and is not a gate: it awaits the colleagues' confirmation. If the harness cwd diverges so the check fails, the fix is not accepted.
- AC10: Tests are vitest project "unit", written test-first (AC1-AC8).

## Manual verification procedure (for AC9)
Before and after the change, run an ACP client from `~/dev/codemie-dev/EPMCDME-14384-evidence/acp-repro`. Before: no session record, no line metrics. After: a session record, `_metrics.jsonl` with 7 added / 2 removed, and no `Session file not found` in the sync log. Record the result in `EVIDENCE-EPMCDME-14384.md`.

## Non-goals
- No incremental/live sync during the session (end-of-session only).
- No exact mapping of each ACP session to its own CodeMie record (follow-up).
- No counting of lines from transcripts after the first in the spike-fallback branch; `onSessionEnd` only warns with the skipped transcripts (summation is a follow-up).
- No option to disable skills sync for ACP (follow-up).
- No verification in real IntelliJ as part of this change (colleagues confirm).
- No change to plain `claude` lifecycle, hooks, or `default-agent-hooks.ts`.
- No change to `recordTranscriptCorrelation`, `processSession` signature, or reconcile code.
- No fallback that searches all project directories by time when the cwd directory has no match.
- No push or MR.

## Risks
- Wrapper cwd vs the IDE's `session/new` cwd: the wrapper sees only `process.cwd()` (unverified; analysis section 2). When they differ, no transcript is found and AC3 applies (warn and skip). Step 6 logging makes the cause visible. AC9 checks the harness only; real IntelliJ is unverified. A later reconciliation pass has the same limit. No directory-wide fallback by design.
- Hard kill (SIGKILL): `onSessionEnd` does not run. Reconciliation finalizes the record via the new `locateTranscript` (AC6).
- `locateTranscript` on the shared adapter also affects plain `claude` records. `otherAgentEnd` calls it only when `agentSessionFile` is empty, and hook-created records set it. Only claude records with no recorded transcript change behaviour. AC5/AC6 plus an existing-behaviour test cover this.
- Possible second record creator: user-settings hooks fire under ACP (EVIDENCE 4b). `handleSessionStart` has existing-record handling (`hook.ts:944-977`), covered by AC7; end-to-end with a real user-settings hook is unverified.
- Concurrent ACP processes in the same cwd: the claimed-by-other-record filter and `nextRecordStartInDirectory` bound attribution, but a transcript not yet claimed by a concurrent run can still be taken. Not exact.
- Skills sync writes into the user's project: `processEvent(SessionStart)` calls `syncSkillsToClaude(event.cwd || process.cwd())` unconditionally (`hook.ts:264`, `hook.ts:271-277`), writing `{cwd}/.claude/skills/` and `.codemie-sync.json` (`SkillSync.ts:82,97`, `:216`) when skills are discovered. Accepted, same as plain `claude` through the hook path (see Decisions). Not deferred to the plan stage. Disabling it is a follow-up.
- Fallback undercount: if the spike shows no summation, multi-session ACP runs record only the first transcript (AC4).
- `realpath` and encoding are evidenced on one OS (macOS). Windows paths are untested.

## Decisions
- Override lifecycle in `ClaudeAcpPluginMetadata` only, over adding it to plain `claude`: the hook already creates claude's record, so the override would create it twice.
- End-of-session processing only over incremental sync: smallest change.
- Collect all transcripts by cwd and run window over exact per-session mapping: the wrapper cannot see ACP session ids.
- Correlate the earliest file and run `processSession` per file over relaxing `recordTranscriptCorrelation`: avoids touching shared code.
- Spike first, with fallback to earliest-transcript-only, over assuming repeated `processSession` sums: the behaviour is unexercised today.
- In the fallback, warn with the skipped transcripts over silently dropping them: the undercount stays visible.
- Exclude transcripts claimed by another record and files outside the run window over cwd+time alone: avoids stealing other sessions' transcripts.
- Detailed debug logging over a search-all-directories fallback for cwd divergence: keeps attribution strict while making the cause visible.
- Accept writing to `{cwd}/.claude/skills/` and `.codemie-sync.json` over gating skills sync: parity with plain `claude` (same `handleSessionStart` in the hook path); no gate exists without changing shared code.
- Warn and skip when no transcript is found over failing the run: matches codex, and the IDE session must not break.
- Implement `ClaudeSessionAdapter.locateTranscript` on the shared adapter over a private helper in the ACP plugin: reconciliation needs it through the adapter contract.
- Add an encode helper (`realpath` plus non-alphanumeric to `-`) over inverting the lossy decoder.
- Manual harness check as a gating AC9 over a non-gating note: the end-to-end result needs a criterion that can fail; real IntelliJ stays out of the gate.
- Tests: vitest "unit", test-first, with the fixture in a temp `CLAUDE_CONFIG_DIR`.
