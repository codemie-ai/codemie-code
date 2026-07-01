# Design: Session Origin Validation

**Ticket:** EPMCDME-12992  
**Date:** 2026-07-01  
**Status:** Approved  
**Complexity:** 24 (brainstorming)

## Problem

CodeMie parses `~/.claude/projects/` too broadly and ingests Claude Code sessions that were never created through CodeMie. This causes:

1. Non-CodeMie sessions appearing in CodeMie Analytics and account history.
2. `codemie-claude --resume <id>` silently syncing arbitrary Claude sessions into CodeMie datasets.
3. Potential customer data leakage when a user accidentally resumes client-work sessions via `codemie-claude`.

## Approach: Dual Signal — Correlation Index + Transcript Marker

Ownership is determined by two complementary signals:

1. **Correlation index** — `~/.codemie/sessions/*.json` records `correlation.agentSessionFile` (transcript path) and `correlation.agentSessionId` (Claude's session UUID). Fast O(1) lookup, already present.
2. **Transcript marker** — a `codemie_session_start` JSON line appended to the Claude `.jsonl` at session start. Makes the transcript self-describing; survives `~/.codemie/sessions/` cleanup.

## Section 1: Ownership Marker at Session Start

**File:** `src/agents/core/hook.ts` → `createSessionRecord()`

After the `~/.codemie/sessions/{id}.json` file is written, append one line to `correlation.agentSessionFile`:

```jsonl
{"type":"codemie_session_start","uuid":"<generated-uuid>","codemie_session_id":"<CODEMIE_SESSION_ID>","codemie_agent":"<CODEMIE_AGENT>","timestamp":"<ISO>"}
```

- Non-standard event type — ignored by Claude Code.
- If the transcript file does not yet exist at `SessionStart` time, the write is skipped and a debug log is emitted (non-fatal).
- Write failures are non-fatal: log warning, continue.

## Section 2: Analytics — Label External Sessions

**File:** `src/cli/commands/analytics/native-loader.ts`

### Ownership resolution for each discovered transcript

1. Build `CodeMieSessionIndex: Map<agentSessionFilePath, codemieSessionId>` from all `~/.codemie/sessions/*.json`.
2. For each transcript path discovered by `discoverSessions()`:
   - In index → `origin: 'codemie'`, ingest as today.
   - Not in index → scan first 10 lines of the transcript for `{"type":"codemie_session_start",...}`.
     - Marker found → `origin: 'codemie'`.
     - Marker not found → `origin: 'external'`.
3. Sessions with `origin: 'external'` are synthesized into `RawSessionData` normally but with:
   - `data.origin = 'external'`
   - `data.provider = 'native-external'` (replaces `'native'`)

### Rendering

Analytics report renderers check `provider === 'native-external'` and append a label (e.g., `[external]`) to the session line. No sessions are hidden — all are surfaced, external ones are clearly marked.

### Error handling

- If building `CodeMieSessionIndex` fails → treat all sessions as `origin: 'external'` (conservative; prevents leakage by default).
- If transcript read fails during marker scan → treat as `origin: 'external'`.

## Section 3: Resume Validation

**File:** `src/agents/core/AgentCLI.ts` → `handleRun()`

Before flag transformation and subprocess spawn, when `--resume <sessionId>` is present:

1. Scan `~/.codemie/sessions/*.json` for a record where `correlation.agentSessionId === sessionId`.
2. **Found** → CodeMie-owned; proceed normally.
3. **Not found** → print:

   ```
   ⚠  Warning: Session <id> was not created through CodeMie.
   If you continue:
     • Token usage and API metrics WILL be tracked via the CodeMie proxy.
     • Conversation transcript will NOT be synced to your CodeMie account history.
   
   To resume without any CodeMie tracking, use: claude --resume <id>
   
   Continue with CodeMie? (y/N):
   ```

4. **User confirms `y`** → spawn Claude with `--resume`, inject `CODEMIE_CONV_SYNC_DISABLED=1` into subprocess env.
5. **User declines** → exit 1, print: `Use 'claude --resume <id>' to resume without CodeMie tracking.`

### Sync suppression (conversation transcript only)

Because the CodeMie proxy captures token usage and API metrics for all traffic regardless of session origin, **only conversation transcript sync is suppressed** for confirmed external resumes.

`ConversationSyncProcessor` checks `process.env.CODEMIE_CONV_SYNC_DISABLED === '1'` and skips transcript upload. `MetricsSyncProcessor` and `SessionSyncer` run normally — token/metric data flows through the proxy as expected.

The env var is renamed `CODEMIE_CONV_SYNC_DISABLED` (not `CODEMIE_SYNC_DISABLED`) to be precise about what is suppressed.

### Error handling

- `~/.codemie/sessions/` scan failure → treat as "not found" → show warning flow (conservative).
- Non-interactive (piped stdin / `--yes` / `CODEMIE_NO_PROMPTS=1`) → behave as if user declined; exit 1 with error message.

## Section 4: Audit Logging

**New file:** `src/agents/core/session/session-origin-audit.ts`

Append-only audit log at `~/.codemie/logs/session-origin-audit.jsonl`:

```jsonl
{"ts":"<ISO>","event":"transcript_marker_written","sessionId":"<codemie-id>","claudeSessionId":"<claude-id>"}
{"ts":"<ISO>","event":"resume_blocked","sessionId":"<attempted-claude-id>"}
{"ts":"<ISO>","event":"resume_external_confirmed","sessionId":"<attempted-claude-id>","codemieSessionId":"<new-id>"}
```

Events:
- `transcript_marker_written` — emitted after successful marker write in `createSessionRecord()`.
- `resume_blocked` — emitted when user declines or non-interactive exit.
- `resume_external_confirmed` — emitted when user confirms resume of external session.

Write failures are non-fatal (log to stderr debug, continue).

## Files Changed

| File | Change |
|------|--------|
| `src/agents/core/hook.ts` | Append `codemie_session_start` marker to transcript in `createSessionRecord()` |
| `src/agents/core/AgentCLI.ts` | Add resume validation in `handleRun()` before flag transform; inject `CODEMIE_CONV_SYNC_DISABLED=1` on confirmed external resume |
| `src/cli/commands/analytics/native-loader.ts` | Add `CodeMieSessionIndex` build + origin labeling logic |
| `src/cli/commands/analytics/types.ts` | Add `origin: 'codemie' \| 'external'` to `RawSessionData` |
| `src/cli/commands/analytics/sources/sessions-source.ts` | Pass `origin` through to renderer |
| `src/cli/commands/analytics/report-renderer.ts` (or equivalent) | Render `[external]` label for `native-external` sessions |
| `src/providers/plugins/sso/session/processors/conversations/syncProcessor.ts` | Check `CODEMIE_CONV_SYNC_DISABLED` and skip transcript upload when set |
| `src/agents/core/session/session-origin-audit.ts` | **New file** — append-only audit log utility |

## Out of Scope

- Deletion of already-ingested non-CodeMie data from the server (backend concern).
- Changes to `~/.codemie/sessions/` file format.
- Modifying Claude's JSONL format beyond appending a non-standard event line.

## Acceptance Criteria Mapping

| AC | Implementation |
|----|----------------|
| No external session ingestion | Sync suppression via `CODEMIE_SYNC_DISABLED` when user confirms external resume |
| Analytics shows only CodeMie sessions | `origin='external'` label on non-CodeMie sessions; no hidden sessions |
| Resume validates origin | `handleRun()` ownership check + warn + confirm flow |
| Non-CodeMie sessions blocked from sync | `CODEMIE_SYNC_DISABLED` env + sync processor guard |
| `.claude/projects` parsing restricted | Index + marker dual-signal filter in `native-loader.ts` |
| Audit logging | `session-origin-audit.ts` append-only log |
