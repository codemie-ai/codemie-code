# Technical Research

**Task**: claude-acp session lifecycle metrics
**Generated**: 2026-11-27
**Research path**: codegraph

---

## 1. Original Context

EPMCDME-14384: claude-acp sessions never get a CodeMie session record, so line-change metrics are always 0.

Details (verified by user): Evidence in ./EVIDENCE-EPMCDME-14384.md (untracked; read it, do not commit). Sanitized ACP transcript fixture: ~/dev/codemie-dev/EPMCDME-14384-evidence/transcripts/acp-fixture.jsonl (Write 5 lines + 2 Edits: expected totals 7 added, 2 removed). Root cause: ClaudeAcpPlugin runs bare `claude-agent-acp`, so the --plugin-dir SessionStart hook never runs, no session record, no _metrics.jsonl with fileOperations. Transcript is fine (extractClaudeFileOperation gives correct counts). Pattern to follow: codex.plugin.ts and opencode.plugin.ts run lifecycle in the wrapper (onSessionStart -> processEvent(SessionStart); onSessionEnd -> locate transcript, recordTranscriptCorrelation, adapter.processSession, processEvent(SessionEnd)). ClaudeSessionAdapter has no locateTranscript yet.
Proposed approach: (1) override lifecycle onSessionStart/onSessionEnd only in ClaudeAcpPluginMetadata (never plain claude, or record is created twice); (2) implement ClaudeSessionAdapter.locateTranscript (~/.claude/projects/<encoded-cwd>/*.jsonl by cwd and run start time; return all matches); (3) vitest tests (project "unit"), test-first.
Proposed decisions: end-of-session processing only; several ACP sessions per process handled by collecting all transcripts by cwd+time; if none found warn and skip like codex.
Risks to research: wrapper cwd may differ from cwd IDE sends in session/new; onSessionEnd may not run if IDE kills process (stale-session reconciliation needs locateTranscript too).
Do not propose touching src outside what's needed.

---

## 2. Codebase Findings

### Existing Implementations

Purpose A: a CodeMie session record exists for a claude-acp run.
- `ClaudePluginMetadata.lifecycle` (`src/agents/plugins/claude/claude.plugin.ts:273`) defines `beforeRun` etc.; grep finds no `onSessionStart`/`onSessionEnd` in it. Claude's record comes from the `--plugin-dir` SessionStart hook, added by `defaultAgentHooks['claude']` `enrichArgs` (`src/providers/core/default-agent-hooks.ts:86-88`), keyed by agent name `'claude'` only.
- `ClaudeAcpPluginMetadata` (`claude-acp.plugin.ts:16`) spreads `...ClaudePluginMetadata` (so it inherits `lifecycle`, `sessionAnalyticsReport: true`, `dataPaths.home='.claude'`), sets `flagMappings: {}`, `silentMode: true`. `ClaudeAcpPlugin` (`:68`) overwrites `this.metadata`; no lifecycle override.
- Hook-created record: `handleSessionStart` (`src/cli/commands/hook.ts:255`; record built ~`:1030-1068`): `correlation.agentSessionId = event.session_id`, `agentSessionFile = event.transcript_path` (unless shared store), plus `runtimeCheckpoint` for agentName `claude`/`claude-acp` (`:1058`).
- Wrapper-side creators: `ensureSessionFile(sessionId, env, defaultAgentName)` (`src/agents/core/session/ensure-session.ts:13`) sets `correlation.agentSessionId = CodeMie id`, no `agentSessionFile`, `ownerPid`, `cwd = process.cwd()`; callers `codemie-code.plugin.ts`, `opencode.plugin.ts` (`beforeRun` safety net). Codex/opencode instead call `processEvent({hook_event_name:'SessionStart',...}, buildHookConfig(env, sessionId))` from `lifecycle.onSessionStart` (`opencode.plugin.ts:271`, `codex.plugin.ts:~200`).
- Lifecycle dispatch: `executeOnSessionStart/End` (`src/agents/core/lifecycle-helpers.ts:130,222`); `resolveHook` (`:70`) picks provider hook, else agent `lifecycle[hookName]`. `onSessionEnd(exitCode, env)` is called in `endSessionAndCleanup` (`BaseAgentAdapter.ts:936`), followed by `finalizeOwnRecord`. Types: `src/agents/core/types.ts:116,122,176`.

Purpose B: line metrics from the transcript (`fileOperations`).
- `ClaudeSessionAdapter` (`src/agents/plugins/claude/claude.session.ts:43`): `agentName='claude'`; `getProjectsDir` (`:76`) honours `CLAUDE_CONFIG_DIR` else `~/.claude/projects`; `discoverSessions` (`:96`) walks `projects/<encoded-cwd>/<uuid>.jsonl`; `decodeClaudeProjectDir` (`:32`) is lossy (every `/` -> `-`). `processSession(filePath, sessionId, context)` (`:619`) loads the record by CodeMie id and, if missing, logs error and returns `success:false` ("Session record could not be loaded"); applies `runtimeCheckpoint.baselineCutoffMs` baseline when set. No `locateTranscript` in it.
- Reference `locateTranscript` implementations: `CodexSessionAdapter.locateTranscript` (`codex.session.ts:379`, uses `findRolloutForRun` from `codex.correlation.ts:49` plus `nextRecordStartInDirectory` window bound), opencode (`opencode.session.ts:397`), pi (`pi.session.ts:329`), copilot-cli (`copilot-cli.session.ts:390`). Interface: `SessionAdapter.locateTranscript?(record: Session): Promise<string[]>` (`BaseSessionAdapter.ts:234`), read-only, empty when none, may throw.
- Codex end-of-run: `onSessionEnd` (`codex.plugin.ts:~340-415`): stop timer; locate rollout (cwd = `process.cwd()`, `startedAt` from env); if none, `logger.warn` and skip; else `recordTranscriptCorrelation(sessionId, path)` (`no-transcript-correlation.ts:69`, must precede SessionEnd; returns false if record absent or already correlated to another file), `adapter.processSession`, then `processEvent(SessionEnd)` with `transcript_path: ''`.

Purpose C: record of a wrapper that died is finalized later.
- `reconcileOtherSessions` (`src/agents/core/session/stale-session-reconciliation.ts:562`) runs at the start of other launches; `syntheticSessionEnd` (`synthetic-session-end.ts:83`) -> `otherAgentEnd`: uses `record.correlation.agentSessionFile` when set; otherwise (with flush) `AgentRegistry.getAgent(record.agentName).getSessionAdapter().locateTranscript(record)`; result passed as `transcript_path` / `transcript_paths` (multiple supported, `:21`). Without `locateTranscript` it finds nothing.
- `nextRecordStartInDirectory`/`sameTranscriptKeys` (`next-record-start.ts:49-59`) already keys `claude-acp` records by `claude:<file>` (shares key space with `claude`).
- `session-ownership.ts:7` treats `claude` and `claude-acp` as Claude agents.

Other touched code: `src/agents/registry.ts` (registers `ClaudeAcpPlugin`), `AgentCLI.ts:753` (metadata lookup `'claude-acp'`), `hook.ts:1058`.

### Decisions Already in the Code
- Convention for agents without hooks: lifecycle in the wrapper's `metadata.lifecycle` (codex, opencode, codemie-code); record via `processEvent(SessionStart)` or `ensureSessionFile`. Reason recorded for opencode (`opencode.plugin.ts:248-269`): must run before `ensureSessionFile`, else a placeholder record with agentSessionId 'unknown' wins. Side effect noted there: `handleSessionStart` runs `syncSkillsToClaude` (creates `{cwd}/.claude/skills/`) — applies to any wrapper-run `processEvent(SessionStart)`.
- Lifecycle inheritance by spread: `ClaudeAcpPluginMetadata` copies `lifecycle` by reference from Claude; overriding means replacing the `lifecycle` object, and `beforeRun` (with `this: BaseAgentAdapter`, `claude.plugin.ts:278`) must be preserved (spread `...ClaudePluginMetadata.lifecycle`). `claude` has no `onSessionStart/End`, so no duplicate exists today; duplicate risk arises only if the override were put on plain `claude` metadata (hook SessionStart also creates the record).
- ACP's real cwd: wrapper uses `process.cwd()` for record `workingDirectory` and codex lookups; the ACP client's `session/new` carries its own `cwd` (the evidence shows `claude-agent-acp` writes the transcript under `projects/<encoded session cwd>`).
- Transcript naming: Claude's own session id (e.g. `f34149dc...`), not the CodeMie id; `ensureSessionFile` records the CodeMie id as `agentSessionId` (EVIDENCE 4c).
- `claude-agent-acp` honours `CLAUDE_CONFIG_DIR` (EVIDENCE 4a), matching `getProjectsDir`.

### Task Statements Checked Against the Code
- "ClaudeAcpPlugin runs bare `claude-agent-acp`, `--plugin-dir` hook never runs": holds (`flagMappings: {}`, `defaultAgentHooks` keyed `'claude'`; EVIDENCE log line `Executing: claude-agent-acp`).
- "ClaudeSessionAdapter has no locateTranscript yet": holds (`claude.session.ts`: not defined; `BaseSessionAdapter.ts:234` optional).
- "Pattern: codex/opencode run lifecycle in the wrapper": holds (see Section 2).
- "Override only in ClaudeAcpPluginMetadata, never plain claude": consistent with code; claude record is made by the hook (`hook.ts:1030`). Keeps the inherited `lifecycle.beforeRun` in place (must be retained).
- "locateTranscript by cwd + run start time": `ClaudeSessionAdapter` has the projects dir, but the encoding helper is decode-only (`:32`); no encode function found in it. Encoding rule is evidenced only by `decodeClaudeProjectDir` docs and EVIDENCE (`/private/tmp/...` -> `-private-tmp-...`).
- "Transcript is fine (extractor correct)": holds per EVIDENCE section 3 (identical counts); `ClaudeSessionAdapter` itself not run on ACP transcript (EVIDENCE "Not run").
- "Wrapper cwd may differ from cwd the IDE sends": unverified; wrapper cwd is `process.cwd()`; the cwd in `session/new` is not visible to the wrapper. Evidence harness (`client.mjs`) used a work dir `work-acp` (see `acp-wire.jsonl`) distinct from the harness, i.e. a case where it can be checked.
- "onSessionEnd may not run if IDE kills the process": `endSessionAndCleanup` is described as running on signal exits (`BaseAgentAdapter.ts:930-932`); SIGKILL not covered. Reconciliation then relies on `locateTranscript` (`synthetic-session-end.ts:35`).
- "Several ACP sessions per process": `otherAgentEnd`/`SessionEndEvent` accept `transcript_paths`; but `recordTranscriptCorrelation` stores a single `agentSessionFile` and refuses a different one (`no-transcript-correlation.ts:78`); `processSession(filePath, sessionId, ctx)` takes one file. Handling several files means repeated `processSession` calls for the same CodeMie id; this is not exercised by any existing caller found.

### Consumers of Changed Contracts
- `SessionAdapter.locateTranscript` (`BaseSessionAdapter.ts:234`): sole consumer `synthetic-session-end.ts:13` (adapter from `AgentRegistry.getAgent(record.agentName)`); applies to `claude-acp` records, and to `claude` records too if the method is added on `ClaudeSessionAdapter` (both use that adapter via inheritance). For `claude` records, `otherAgentEnd` only locates when `correlation.agentSessionFile` is empty (hook-created records set it), so existing behaviour changes only for claude records with no recorded transcript.
- `ClaudePluginMetadata.lifecycle` / `ClaudeAcpPluginMetadata` consumers: `executeOnSessionStart/End` via `BaseAgentAdapter`, `AgentCLI.ts:753`, tests `claude-acp` in `cloud-provider-conflict/__tests__/adapter-check.test.ts`, `hook.session-delivery.test.ts`, `hook-routing-contract.test.ts`, `session-analytics-report-metadata.test.ts`, `registry.test.ts`.
- `processSession` requires a record by CodeMie id (`claude.session.ts:636`): if `onSessionStart` failed to create it, end processing fails closed.
- `finalizeOwnRecord` (`BaseAgentAdapter.ts:948`) runs after `onSessionEnd`; `ensureSessionFile` records have `ownerPid` of the wrapper.

### Architecture and Layers Affected
- Agents plugin layer (`src/agents/plugins/claude/`: `claude-acp.plugin.ts`, `claude.session.ts`), consuming core lifecycle (`src/agents/core/lifecycle-helpers.ts`, `BaseAgentAdapter`), session core (`src/agents/core/session/*`), CLI hook pipeline (`src/cli/commands/hook.ts` `processEvent`).

### Integration Points
- `processEvent` in `hook.ts` (dynamic import, as codex/opencode do); `recordTranscriptCorrelation`; `SessionStore`; reconcile pipeline; proxy session-sync timer (`sso.session-sync.plugin.ts`) pushes JSONL written by the processors.

### Patterns and Conventions
- ES modules with `.js` imports, `@/` alias, `logger` (not console; ACP stdout is JSON-RPC, `silentMode: true`), non-blocking try/catch around lifecycle steps, `buildHookConfig(env, sessionId)` helper per plugin (codex/opencode), `getCodemiePath()` for `~/.codemie`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/architecture/architecture.md`, `development/development-practices.md`, `testing/testing-patterns.md`, `integration/external-integrations.md` (ACP). Not read in full here. `docs/ARCHITECTURE-PROXY.md` mentioned in AGENTS.md.

### Architectural Decisions
- Comments in `opencode.plugin.ts:248-269` and `ensure-session.ts:57-58` (record owned by wrapper; ends via onSessionEnd or reconciliation).

### Derived Conventions
- See "Patterns and Conventions".

---

## 4. Testing Landscape

### Existing Coverage
- `src/agents/plugins/claude/__tests__/ClaudeSessionAdapter.test.ts`, `claude.session.corrupted-transcript.test.ts`, `claude-run-baseline.test.ts`, `claude.plugin.*.test.ts` (resume ownership etc.).
- `src/agents/plugins/opencode/__tests__/opencode.locate-transcript.test.ts`, `opencode-session-record.test.ts` — closest analogues for new tests.
- `src/agents/core/session/__tests__/stale-session-reconciliation.test.ts`, `src/cli/commands/__tests__/hook.session-delivery.test.ts`, `hook-routing-contract.test.ts`.
- Fixtures: `src/agents/plugins/claude/__tests__/fixtures/*.jsonl`; evidence fixture outside the repo: `~/dev/codemie-dev/EPMCDME-14384-evidence/transcripts/acp-fixture.jsonl` (also `acp-minimal.jsonl`, raw `acp/` and `reg/` transcripts).

### Testing Framework and Patterns
- Vitest; dynamic-import mocking after setup (AGENTS.md; `.ai-run/guides/testing/testing-patterns.md`); project "unit" per the task.

### Coverage Gaps
- No test of `claude-acp` lifecycle; no `locateTranscript` for Claude; an ACP-format Edit test passes on current code (EVIDENCE section 5), so it cannot show the bug.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_SESSION_ID`, `CODEMIE_AGENT`, `CODEMIE_PROVIDER`, `CODEMIE_PROJECT`, `CODEMIE_URL`, `CODEMIE_CLIENT_TYPE`, `CODEMIE_MODEL`, `CODEMIE_CLI_VERSION` (consumed by `ensureSessionFile`/`buildHookConfig`); `CLAUDE_CONFIG_DIR` (projects dir); `CODEMIE_CODEX_STARTED_AT` is codex's run-start carrier (no Claude equivalent found); `CODEMIE_SESSION_DRY_RUN`, `CODEMIE_CONV_SYNC_DISABLED` (evidence runs).

### Configuration Files
- `~/.codemie/sessions/<id>.json` (records), `~/.claude/projects/<encoded-cwd>/*.jsonl` (transcripts), `~/.claude/settings.json` (user hooks fire under ACP via `settingSources: user`, EVIDENCE 4b).

### Feature Flags and Deployment Concerns
- `sessionAnalyticsReport: true` inherited (`claude.plugin.ts:180`). No flags specific to ACP found.

---

## 6. Risk Indicators

- Two distinct session ids: CodeMie id vs Claude's own transcript id; `ensureSessionFile` stores CodeMie id as `agentSessionId`; `processEvent(SessionStart)` requires a `transcript_path`/`session_id` the wrapper does not know at start (codex/opencode pass `''`).
- Wrapper `process.cwd()` vs the IDE's `session/new` cwd: transcripts live under the latter; unverified (Section 2).
- `recordTranscriptCorrelation` accepts one file per record; several ACP sessions per process vs one `agentSessionFile` (`no-transcript-correlation.ts:78`) and one-file `processSession`.
- `onSessionEnd` not run on hard kill: relies on `locateTranscript` in reconciliation; a Claude `locateTranscript` also affects `claude` records lacking `agentSessionFile`.
- Encoded-cwd directory naming: no encode helper in code; decode is lossy; `realpath` (e.g. `/tmp` -> `/private/tmp`) appeared in the evidence directory name.
- Transcripts shared across runs in the same cwd (`ponytail` note at `codex.session.ts:377`): time-window attribution with concurrent ACP processes is ambiguous; `nextRecordStartInDirectory` is the existing bound.
- `handleSessionStart` side effects (`.claude/skills/` creation) will apply to ACP runs when SessionStart is routed through `processEvent`.
- Task statement "end-of-session processing only" keeps no mechanism in place for the same purpose except the inherited hook path (not run under ACP); no live incremental sync exists for Claude ACP (codex/opencode run `startCodexIncrementalSync`/`startOpenCodeIncrementalSync`).
- Speculative: overriding `lifecycle` in the ACP metadata must keep `beforeRun`, or the existing OTLP preflight / env defaults for ACP are lost.
- Speculative: lifecycle override test must prove `claude` metadata is unchanged (shared object by spread).
- ACP package: hooks configured by the IDE or `~/.claude/settings.json` would also fire (EVIDENCE 4b), a possible second creator of a record whose id the wrapper doesn't control; `handleSessionStart` has existing-record handling (`hook.ts:944-977`).

---

## 7. Summary for Complexity Assessment

The change sits in the agents plugin layer (`claude-acp.plugin.ts`, `claude.session.ts`) and reuses core lifecycle, session and hook pipeline code unchanged: codex and opencode already provide the end-to-end pattern, and `locateTranscript` is an existing optional adapter contract consumed by stale-session reconciliation. Expected file surface per the task is two source files plus new tests; shared pieces (`recordTranscriptCorrelation`, `processEvent`, reconcile) already exist.

Novelty is moderate: no Claude encode-cwd helper, one-transcript-per-record assumptions in `recordTranscriptCorrelation` and `processSession` versus the several-sessions-per-process decision, and a wrapper that cannot see the IDE's session cwd or Claude's session id. Adding `locateTranscript` to the shared `ClaudeSessionAdapter` also reaches `claude` records via reconciliation.

Test posture: Claude session adapter and opencode locate-transcript tests exist as templates; there is no coverage for claude-acp lifecycle. Key risks: cwd mismatch, kill without onSessionEnd, id mismatch, concurrent runs in the same directory.

---

## 8. External References

- `./EVIDENCE-EPMCDME-14384.md` (local evidence notes, not part of the repository): key facts: ACP launch is `claude-agent-acp` with no args; 0 records in `~/.codemie/sessions` for the ACP run; extractor counts identical to regular (Write 5 added; Edit 1+/1- twice); transcript dir `~/.claude/projects/-private-tmp-claude-501-acp-repro-work-acp/`; `claude-agent-acp` 0.113.0 merges only the client's `_meta.claudeCode.options` (plugins/hooks only from client), honours `CLAUDE_CONFIG_DIR`, loads user settings hooks (marker test). Not proven: whether any other creator besides SessionStart exists; real IDE behaviour; correlation of wrapper-created record to Claude transcript.
- `~/dev/codemie-dev/EPMCDME-14384-evidence/transcripts/acp-fixture.jsonl` (resolved by Glob, listed; content not opened): task states 5-line Write + 2 Edits, expected 7 added / 2 removed.
