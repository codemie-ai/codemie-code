# Technical Research

**Task**: session-ownership resume scanSessionsForClaudeId session-id
**Generated**: 2026-11-13
**Research path**: filesystem (codegraph MCP tool not available; one orientation agent plus four parallel Explore threads)

---

## 1. Original Context

Jira EPMCDME-17189 (Bug): "[CodeMie CLI] --resume rejects CodeMie session IDs displayed by CLI Analytics".

`codemie analytics`, `codemie log list-sessions`, and `codemie log session <id>` display CodeMie session IDs (UUIDs such as deafeccf-a164-4656-84fd-ca0f57507347). Passing one to `codemie-claude --resume <id>` fails with:
  "✗ Session <id> was not created through CodeMie. Non-interactive mode: resume blocked."
Resuming with the native Claude Code session ID (f9dd1a0b-3594-4421-a610-2bfbb21ead3c, only visible under ~/.claude/projects/<path>/) works.

Root cause per the ticket: src/agents/core/session/session-ownership.ts, function scanSessionsForClaudeId(claudeSessionId: string) scans ~/.codemie/sessions/*.json and only checks record.correlation?.agentSessionId (native Claude ID). The completed session record also has record.sessionId (the CodeMie ID), which is never checked. A marker file ~/.codemie/sessions/<...>-codemie-marker.json (containing "codemieSessionId") is also unused by this function. Evidence: ~/.codemie/sessions/completed_deafeccf-....json has sessionId="deafeccf-..." and correlation.agentSessionId="f9dd1a0b-...".

Acceptance criteria:
1. `codemie-claude --resume <codemie-session-id>` resumes correctly with full CodeMie tracking, for IDs from `codemie analytics`, `codemie log list-sessions`, `codemie log session`.
2. scanSessionsForClaudeId (or replacement) also checks record.sessionId in completed session files, resolves CodeMie ID -> native ID, and passes the NATIVE id to the agent's --resume.
3. Native session ID is used for the `claude --resume` call; CodeMie session ID used only for analytics attribution.
4. Resume preserves session identity and analytics attribution without duplicating telemetry (see EPMCDME-16537, and recent fix EPMCDME-16992/16993 on continued/reopened sessions re-reporting).
5. Interactive mode: a CodeMie ID resolving to a known session no longer shows the "not created through CodeMie" warning.
6. Non-interactive (--task): a CodeMie ID proceeds without blocking.
7. Unit tests: (a) CodeMie ID resolves and succeeds, (b) native ID resolves and succeeds, (c) unknown ID returns correct "not found" error.
8. Integration test: session started via `codemie-claude --task` can be resumed by the CodeMie ID shown in `codemie log list-sessions`.
Only confirmed for Claude Code via codemie-claude wrapper; other agents (codex, gemini, opencode, etc.) not investigated — note whether other agents share this code path.

---

## 2. Codebase Findings

### Existing Implementations

- `src/agents/core/session/session-ownership.ts` (32 lines) — single export `scanSessionsForClaudeId(claudeSessionId: string, sessionsDir?: string): boolean`.
  - Dir = `sessionsDir ?? getCodemiePath('sessions')`. It reads every `*.json` except names ending `_metrics.json`. (That filter is effectively a no-op, since metrics files are `.jsonl`.)
  - It matches only `record.correlation?.agentSessionId === claudeSessionId` and returns a boolean, so there is no id mapping.
  - Unreadable or unparsable files are skipped with `logger.debug('[session-ownership] Skipping unreadable session file: ...')`. A missing dir returns false.
  - It already reads `completed_*.json`, `completed_<id>-<generation>*.json` and `*-codemie-marker.json`. Marker files have no `correlation`, so they never match.
  - It never reads `record.sessionId`. That is the root cause.
- `src/agents/plugins/claude/claude.plugin.ts:704-719` — `ClaudePlugin.resolveResumeOwnership(input)`. It is the SOLE production caller (dynamic `import('../../core/session/session-ownership.js')` at :707, call at :708).
  - It returns `{supported:true, owned, fallbackResumeCommand:'claude --resume <id>', auditData:{nativeAgent:'claude', nativeResumeId: input.resumeId}}`.
  - It passes `input.resumeId` straight through, with no CodeMie-to-native mapping.
  - `ClaudeAcpPlugin` (`claude-acp.plugin.ts:65`) extends `ClaudePlugin` and inherits the method.
- `src/agents/core/AgentCLI.ts` — resume parsing, ownership gate, prompts, pass-through args (details below).
- `src/agents/core/types.ts:725-736, 771-794` — `ResumeOwnershipInput` / `ResumeOwnershipResult`, plus the optional adapter hooks `resolveResumeOwnership`, `extractNativeResumeId`, `continuesNativeSession`.
- `src/agents/core/BaseAgentAdapter.ts:583,605,707-712` — generates a FRESH CodeMie session UUID per launch (`randomUUID()`), exports it as `CODEMIE_SESSION_ID`, then applies `transformFlags` with `flagMappings`.
- `src/agents/core/session/session-origin-audit.ts` — `isExternalOrigin`, `appendAuditEvent`, `writeOwnershipMarker` (lines 64-98).
- `src/agents/core/session/SessionStore.ts` — reusable helpers:
  - `loadSession(sessionId)` (line ~248) falls back to `completed_<id>.json` but NOT to generation-suffixed files.
  - `findSessionByExternalId(agentName, externalId)` (~279) and `indexSessionsByExternalId` (~323) match `runtimeCheckpoint.externalSessionId`.
  - `realNativeId` (~59) treats `agentSessionId === record.sessionId` or `'unknown'` as "no real native id".
  - There is no list-all or find-by-agentSessionId method, and all methods are async. `session-ownership.ts` uses a sync `readdirSync` scan.
- `src/agents/core/session/session-generation.ts` — `renameSessionFiles` (:192) and `completed_<id>-<generation>[-n].json` handling.
- `src/agents/core/session/types.ts:154-221` — `Session` interface. `sessionId` is the CodeMie UUID. `correlation:{status, agentSessionFile?, agentSessionId?, detectedAt?, retryCount}`. Also `origin?`, `resumeSessionId?`, `continuesPriorSession?` and `runtimeCheckpoint?`. Env key constants are at :57, :64 and :71, and `SESSION_ORIGIN` at :44-49.
- `src/agents/core/session/ensure-session.ts:54,75-80` — creates session files for opencode and codemie-code (no hook). It sets `correlation.agentSessionId = sessionId` as a placeholder equal to the CodeMie id.
- `src/cli/commands/hook.ts` (~920-1077) — the SessionStart handler. It creates the `Session` record (native id written at :1034, `correlation.agentSessionId = event.session_id`), writes the ownership marker (:969, :1056-1060) and stamps `baselineCutoffMs` (:1038-1047).
- `src/agents/plugins/claude/session/claude-baseline.ts` (`applyClaudeBaseline`, lines 24-90) — the no-re-report mechanism.
- ID display: `src/cli/commands/analytics/data-loader.ts` (:157, :186, :195), `src/cli/commands/log/reader.ts` (:258-311) and `src/cli/commands/log/index.ts` (:81-83, :94, :244).

#### Callers of scanSessionsForClaudeId / session-ownership.ts (complete)
- `src/agents/plugins/claude/claude.plugin.ts:707-708` (production).
- `src/agents/core/__tests__/session-ownership.test.ts:5` (static import; calls at lines 22, 27, 31, 35, 41, 46, 51).
- There is no other importer in `src/` or `tests/`.
- Design doc `docs/superpowers/specs/2026-07-06-generic-resume-ownership-validation-design.md` says the helper name "can stay temporarily" and that shared CLI must not reference it directly.

#### --resume parsing and rewriting flow (AgentCLI.ts)
1. :99 declares `.option('--resume <session-id>')` with `.allowUnknownOption()` and `[args...]` (:102-103). Commander parses both `--resume X` and `--resume=X` into `options.resume`. A bare `-r X` is NOT a declared option. It lands in the pass-through `args` and is not ownership-checked for Claude, because the Claude plugin has no `extractNativeResumeId`.
2. :283-287 validates that `--resume` has a non-empty value.
3. :447-457 calls `adapter.extractNativeResumeId?.(args)` only when `!options.resume`. Implementers are codex (`codex.plugin.ts:496`), opencode (:626), codemie-code (:521) and copilot-cli (:374). Claude is NOT one of them.
4. :462 `resumeId = (options.resume ?? nativeResumeId ?? '').replace(/\p{Cc}/gu,'')`. Only control characters are stripped. The id format is deliberately NOT validated (slugs and ticket ids are valid).
5. :463 `providerEnv[RESUME_SESSION_ENV_KEY] (CODEMIE_RESUME_SESSION_ID) = resumeId`. This happens BEFORE the ownership check.
6. :464 `providerEnv[CODEMIE_CONTINUE_SESSION]` is set from `adapter.continuesNativeSession?.(args)`.
7. :466-515 is the ownership gate:
   - `resolveResumeOwnership({resumeId, cwd, env})` at :473.
   - If the resolver throws, it fails open (:478-484, debug log, launch proceeds).
   - `isExternal = supported===true && owned===false` at :486, then `promptExternalResume(resumeId, fallbackResumeCommand)` at :489.
   - If not confirmed, it writes a `resume_blocked` audit event and calls `process.exit(1)` (:500-503).
   - If confirmed, `Object.assign(providerEnv, buildResumeEnvOverride(true))` sets `CODEMIE_SESSION_ORIGIN=external-resume` (:505-512, helper at :902-904).
8. :521 `collectPassThroughArgs(args, options)` (defined :654-680) re-emits every option except the config-only list as `--resume <String(options.resume)>`. NOTHING rewrites the id today. To pass the native id, the fix must change `options.resume` (or what `collectPassThroughArgs` reads) before :521, and also `providerEnv[RESUME_SESSION_ENV_KEY]` set at :463.
9. :527 `adapter.run(agentArgs, providerEnv, ...)`. In `BaseAgentAdapter.run`, a new `sessionId = randomUUID()` is created at :583 and exported as `CODEMIE_SESSION_ID` at :605. `transformFlags` then maps Claude `--resume` to `-r` (`claude.plugin.ts:220-223`). It is contract-tested in `flag-transform-contract.test.ts:106` and `plugin-effort-resume.test.ts:36`.
10. `CODEMIE_RESUME_SESSION_ID` is stored as `Session.resumeSessionId` (`hook.ts:1003,1029`; `ensure-session.ts:54,75`). It is consumed for transcript lookup by opencode (`opencode.run-session.ts:196-233`) and copilot-cli (`copilot-cli.transcript-lookup.ts:122`). The Claude path only stores it. It should hold the native id after the fix.

#### "not created through CodeMie" message sites
Both are in `AgentCLI.promptExternalResume` (AgentCLI.ts:764-806):
- Non-interactive (:772-779) prints `✗ Session <id> was not created through CodeMie.` + `Non-interactive mode: resume blocked.` + the fallback command, then returns false.
- Interactive (:788) prints `⚠ Warning: Session <id> was not created through CodeMie.` and a readline "Continue with CodeMie? (y/N)".
- `shouldBlockNonInteractiveResume()` (:906-908) is `!process.stdin.isTTY || CODEMIE_NO_PROMPTS==='1'`. **`--task` alone does NOT trigger the block.** Blocking is driven by non-TTY stdin or `CODEMIE_NO_PROMPTS`. This differs from the ticket's wording, which says "Non-interactive (--task)". The test and spec must define "non-interactive" in terms of stdin TTY.
- There is no literal "not found" error today. An unknown id gives the same "not created through CodeMie" message and exit 1 (acceptance criterion 7c).

#### Session file naming, marker and record details
- Live record: `~/.codemie/sessions/<codemieSessionId>.json`, with `_metrics.jsonl` and `_conversation.jsonl` siblings.
- On SessionEnd it is renamed to `completed_<id>.json`. If a different generation already exists, it becomes `completed_<id>-<generation>[-n].json`. The generation is the native agent session id, else the start time, with unsafe characters replaced by `_`.
- `record.sessionId` inside any of these files is the bare CodeMie UUID. A lookup by `record.sessionId` is more robust than by filename, since filenames can carry the `completed_` prefix and a `-<gen>` suffix.
- Marker: `<sha256(transcriptPath)[0:8]>-<codemieSessionId>-codemie-marker.json`.
  - Content: `{transcriptPath, codemieSessionId, codemieAgent, timestamp}`.
  - Written with `flag:'wx'` (first write wins). Skipped for external-resume origin and shared `.db` stores.
  - It does NOT contain the native Claude id, only `transcriptPath` (whose basename is usually `<native>.jsonl`). It is therefore a poor source for CodeMie-to-native resolution. Readers: `analytics/native-loader.ts:161-184` (ownership index by `transcriptPath`). `data-loader.ts:162,186` and `codex.correlation.ts:130` skip marker files. Nothing resolves ids from it.
- Displayed IDs:
  - `analytics/data-loader.ts:195` uses filename minus `.json` minus `completed_`, so generation files show as `<uuid>-<gen>`. `matchesSessionIdFilter` (:157) accepts a full UUID or `<uuid>-*`.
  - `log/reader.ts:258-311` tries `<id>.json` then `completed_<id>.json`. Its list regex allows the `-<generation>` suffix (:294).
  - A fix should therefore accept `<uuid>-<gen>` input, or match on the in-file `record.sessionId`.

### Architecture and Layers Affected

- CLI layer: `AgentCLI` (Commander option parsing, ownership gate, prompts, pass-through arg building).
- Plugin/adapter layer: `ClaudePlugin.resolveResumeOwnership` (optional capability on the `AgentAdapter` interface in `core/types.ts`); `ClaudeAcpPlugin` inherits it.
- Core/session layer: `core/session/session-ownership.ts` (plain sync fs scan, no `SessionStore`).
- Persistence: JSON session files under `~/.codemie/sessions`. Touch points are `SessionStore`, `session-generation.ts` and the marker file.
- Telemetry/analytics layer: `hook.ts` SessionStart, `claude-baseline.ts` and the `external-resume` origin gate. They are not changed, but they constrain the fix.

### Integration Points

- Dependency direction: `claude.plugin.ts` -> `core/session/session-ownership.ts` -> `utils/paths.js` (`getCodemiePath`) and `utils/logger.js`. `AgentCLI` -> `adapter.resolveResumeOwnership` (interface in `core/types.ts`) -> `session-origin-audit.ts` (`appendAuditEvent`). There are no third-party packages in `session-ownership.ts`; AgentCLI uses commander, chalk and node:readline.
- Origin gate (important constraint): `SessionSyncer.ts:198-205` and `conversations/syncProcessor.ts:54` skip syncing when `origin==='external-resume'`. If a CodeMie id were wrongly treated as external, ALL telemetry for the run would be dropped. The fix must return `owned=true` for a resolved CodeMie id.
- Dedupe (acceptance criterion 4):
  - EPMCDME-16537: each resume creates a NEW CodeMie record that shares the native transcript. `hook.ts:1038-1047` stamps `runtimeCheckpoint.baselineCutoffMs`, and `claude.session.ts:630-661` calls `applyClaudeBaseline`, which seeds `processedRecordIds` and the conversation pointer for everything before the cutoff. A resumed run therefore emits only its own deltas.
  - EPMCDME-16992/16993 (OTLP continued/reopened): `claude-code-otlp.plugin.ts:381-385` (`isSessionReopenedIdle`), :431-435 (`pass.reopened`), `transcript/parse-state.ts:86,135`, `transcript/orchestrator.ts:114` and `otlp-spool/reopen-hold.ts:14`. These are keyed on the NATIVE session id, so they work as long as the native id reaches Claude.
  - Conclusion: resolving to the native id and passing it to `claude -r` keeps the existing dedupe working. The fresh `CODEMIE_SESSION_ID` from `BaseAgentAdapter` continues to attribute the new run.
- Placeholder hazard: for opencode and codemie-code, `ensure-session.ts` sets `correlation.agentSessionId` equal to the CodeMie id. A resolver must treat a missing, `'unknown'` or self-equal `agentSessionId` as "no native id".
- Other agents (shared code path?):
  - The resume ownership validation is Claude-specific. Only `ClaudePlugin.resolveResumeOwnership` exists (plus `ClaudeAcpPlugin` by inheritance). Agents without the method fail open.
  - The generic parts that all agents share are the `--resume` option, the `RESUME_SESSION_ENV_KEY` env and the `promptExternalResume` UX. Without a resolver nothing is validated, so only Claude hits this error.
  - `--resume` flag mappings: claude `-r`; kimi `-S`; opencode `-s`; codex `exec resume <id>` / `resume <id>` (`codex.plugin.ts:257-276`, with `extractNativeResumeId`); pi special handling (`pi.plugin.ts:70-77`); copilot-cli `--session-id` / `--resume`.
  - `claude-code-otlp` has no resume ownership.

### Patterns and Conventions

- Resume ownership is an OPTIONAL plugin capability (`resolveResumeOwnership(ResumeOwnershipInput{resumeId,cwd,env}) -> ResumeOwnershipResult{supported, owned?, fallbackResumeCommand?, auditData?}`). Resolvers must not throw. Failure is fail-open with a debug log.
- Resume ids are format-agnostic (only control characters are stripped).
- Shared messages in AgentCLI must not hardcode `claude`. The audit payload is generic (`{agent, resumeId, ...auditData}`). No agent-name guards in AgentCLI (an explicitly rejected alternative).
- Likely extension points suggested by the research (for the planner to decide):
  - Add an optional field such as `nativeResumeId?` to `ResumeOwnershipResult` (`core/types.ts:731`).
  - Make `AgentCLI.ts:466-515` rewrite `options.resume` and `providerEnv[RESUME_SESSION_ENV_KEY]` to the native id when it is returned.
  - Change `scanSessionsForClaudeId` to return `{owned, nativeId?}`, or add a new function.
  - Keep `auditData.nativeResumeId` accurate.
- Code style: ESM with `.js` import suffixes, `@/` alias for deep imports, `logger.debug` (never `console.log`), explicit return types on exports, no `any`. Failures use specific error classes (`src/utils/errors.ts`: `CodeMieError` base, `SessionRecordNotFoundError` at :154, and others). Ownership failure is NOT an exception today (chalk message plus `process.exit(1)` in `promptExternalResume`).

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/development/development-practices.md` (high relevance) — error handling table (lines 13-50), logging levels (~line 100).
- `.ai-run/guides/standards/code-quality.md` (medium) — `logger.debug`, TypeScript conventions (lines 139-147).
- `.ai-run/guides/integration/external-integrations.md` (medium) — session pipeline (lines 143-320), `SessionStore.saveSession()`, `stale-session-reconciliation.ts`, EPMCDME-16537/correlation content.
- `.ai-run/guides/architecture/architecture.md` (low), `.ai-run/guides/security/security-practices.md` (low; audit correlation must not be broken, lines 28-39), `.ai-run/guides/testing/testing-patterns.md` (test conventions).
- `openwiki/workflows/agent-launch-and-session-telemetry.md` lines 96-108 — SessionStore, `completed_` rename, ownership markers keyed by native transcript basename, external-resume ingestion boundary.
- User docs likely needing an update: `docs/COMMANDS.md:536-552` ("Resuming a Session (`--resume`)") does not distinguish CodeMie ids from native ids. Related: `docs/ANALYTICS-REPORT.md:317-321`, `README.md:536`, `CHANGELOG.md:258` (externally resumed sessions excluded from analytics).

### Architectural Decisions

- `docs/superpowers/specs/2026-07-06-generic-resume-ownership-validation-design.md` (PR #403 CR-001) is the key decision record:
  - ownership is an optional plugin capability and agents without it fail open;
  - ids are format-agnostic;
  - a resolver throw or malformed result is treated as unsupported;
  - non-interactive external resume is blocked;
  - shared messages must not hardcode `claude`.
  - Rejected alternatives: metadata-only config, a validator registry, agent-name guards in AgentCLI.
- Related plans and specs: `docs/superpowers/plans/2026-07-06-generic-resume-ownership-validation.md`, `docs/superpowers/plans/2026-07-01-EPMCDME-12992-session-origin-validation.md`, `docs/superpowers/specs/2026-07-07-analytics-exclude-external-sessions-design.md`.
- EPMCDME-16537 records (`docs/superpowers/tasks/2026-10-31-epmcdme-16537-claude-baseline-codex-pending/code-review-*.json`): after `--resume/--continue`, synced deltas must not contain a `recordId` already synced for the same Claude session. Deferred finding DF-003 is that in-REPL `/resume` re-entry via `SessionStart(source=resume)` with a new `transcript_path` gets no baseline (`hook.ts:869`).
- EPMCDME-16992/16993: no docs or task directory named for them were found under `docs/` or `.ai-run`. The behavior is only discoverable in code (see Integration Points).

### Derived Conventions

- The task dir `docs/superpowers/tasks/2026-11-13-epmcdme-17189-resume-codemie-session-id/` contains only `.state.json` (flow `sdlc-light`, branch `fix/EPMCDME-17189-resume-codemie-session-id`). There is no spec or plan yet.
- Inline notes: `AgentCLI.ts:441-446` (Codex native positional resume via `extractNativeResumeId`), :459-461 (resume id formats must not be validated), :505-509 (origin persisted on the Session record gates ingestion), `core/types.ts:771-785` (docs for the optional resolver hooks). `session-ownership.ts` has no TODO or NOTE comments.

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/core/__tests__/session-ownership.test.ts` — the only direct test of `scanSessionsForClaudeId`. 7 tests:
  - match on `correlation.agentSessionId`;
  - no match;
  - empty dir;
  - nonexistent dir;
  - malformed JSON is skipped;
  - `*_metrics.json` is skipped;
  - `my_metrics_session.json` is not skipped.
  - No test for a `record.sessionId` match.
- `src/agents/core/__tests__/AgentCLI-resume.test.ts` — AgentCLI resume flow with a fully mocked `resolveResumeOwnership`: `buildResumeEnvOverride`, `shouldBlockNonInteractiveResume`, `promptExternalResume` (prints "was not created through CodeMie" plus the fallback in non-interactive mode, because stdin is not a TTY under vitest), and `handleRun` with owned, external-confirmed, blocked and throwing resolvers. It checks that `adapter.run` receives `['--resume', id]`, so it will need updating if the id is rewritten.
- `src/agents/plugins/__tests__/plugin-effort-resume.test.ts` (:36) and `flag-transform-contract.test.ts` (:106) — contract tests for `--resume` mapped to `-r`.
- `src/agents/core/__tests__/session-origin-audit.test.ts` — audit events.
- Integration: `tests/integration/agent-task-session.test.ts` is the closest pattern for criterion 8.
  - It spawns `bin/codemie-claude.js --task "<uuid prompt>" --permission-mode acceptEdits` via `spawnSync(process.execPath, ...)`.
  - It uses `pollForSession(sessionsDir, uuid)` from `tests/helpers/session-poll.ts`.
  - It validates `completed_<id>.json`, `_metrics.jsonl` and `_conversation.jsonl` against the schemas in `tests/integration/models/`.
  - Auth is SSO (`CI_IS_LOCAL_RUN=true`, `setupSsoAutotestProfile`, `ssoCleanEnv`) or JWT (`fetchJwtToken`, `writeJwtProfile`, `CODEMIE_HOME=jwtHome`, `jwtCleanEnv`). It is guarded by `describe.runIf(process.env.SSO_AVAILABLE !== 'false')`.
  - Other helpers: `tests/helpers/cli-runner.ts`, `claude-tui.ts`, `pty-session.ts`, `temp-workspace.ts`, `test-isolation.ts`. Sibling tests are `agent-task.test.ts`, `agent-negative.test.ts` and `agent-shortcuts.test.ts`.

### Testing Framework and Patterns

- vitest `^4.1.5`, Node ESM TypeScript. `vitest.config.ts` has three projects:
  - `unit` (`src/**/*.test.ts` and `*.spec.ts`);
  - `cli` (`tests/integration/**/*.test.ts` excluding `agent-*.test.ts`);
  - `agent` (`tests/integration/agent-*.test.ts`, real network and auth, global setup `tests/setup/agent-build-setup.ts`, `testTimeout` 180s, max 2 workers).
  - All projects set `CODEMIE_HOME` to `os.tmpdir()/codemie-test-home-<pid>`.
- Scripts: `test` runs unit, cli, then agent. `ci` runs license-check, lint (`--max-warnings=0`), build, then the unit and cli projects. There is no `test:integration` script. A single file runs with `npx vitest run --project unit <file>`.
- session-ownership.test.ts uses a real filesystem with no mocking: `TMP = join(tmpdir(), 'codemie-ownership-test-' + process.pid)`, `mkdirSync` in `beforeEach` and `rmSync` in `afterEach`, and the injected `sessionsDir` parameter. Its only factory is `writeSession(id, claudeSessionId)`, which writes `{correlation:{agentSessionId}}` only, with no `sessionId`.
- AgentCLI tests use a `createAdapter(overrides)` stub, `vi.spyOn` on `ConfigLoader.load`, `exportProviderEnvVars`, `ProviderRegistry.getProvider`, `process.exit` (throwing an `ExitError`), `console.error` and `auditModule.appendAuditEvent`. Private methods are reached through `as unknown as {...}` casts, with `vi.restoreAllMocks()` in `afterEach`.
- Guide conventions: dynamic `await import()` after spies are set up; `path.join` and `pathToFileURL` rather than POSIX literals (a Windows CI lesson); integration tests use the real FS; targets are 80% overall and 90% for core logic; names read `should ...` with Arrange-Act-Assert.

### Coverage Gaps

- No test for `record.sessionId` matching. Needed cases:
  - CodeMie id resolves;
  - native id resolves;
  - unknown id returns not found;
  - a `completed_<id>.json` file;
  - a generation-suffixed file `completed_<id>-<gen>.json`;
  - a record with neither field;
  - a record whose `agentSessionId` is missing or a placeholder (equal to `sessionId`, or 'unknown');
  - marker files being skipped.
- No unit test of `ClaudePlugin.resolveResumeOwnership` itself (owned mapping, `fallbackResumeCommand`, `auditData`).
- No test that AgentCLI rewrites the id passed to `adapter.run` or `CODEMIE_RESUME_SESSION_ID`.
- The "not found" wording: today there is only the "not created through CodeMie" text. Confirm the expected message for criterion 7c.
- `codemie log list-sessions` has no tests (grep for `list-sessions` in tests and `*.test.ts` finds nothing). The command is at `src/cli/commands/log/index.ts:94`.
- No end-to-end resume test in the `cli` or `agent` projects. `tests/e2e/subscription-analytics/drive.mjs` resume scenarios concern analytics hooks and are unrelated.
- A new integration test must match `tests/integration/agent-*.test.ts` to run in the agent project. It needs real auth and network. It needs `--resume <codemie-id> --task ...`, with the session id taken from `list-sessions` after handling the `completed_` prefix. In `spawnSync`, stdin is not a TTY, so an unowned resume blocks automatically.
- Possible inactive tests: a few unit tests exist under `tests/unit/cli/...`. That path is matched by neither the `unit` (`src/**`) nor the `cli` (`tests/integration/**`) project include, so they may not run. Verify before adding tests there.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_SESSION_ID` — the CodeMie session id. It is set at `BaseAgentAdapter.ts:605`, injected into hooks at `hooks/executor.ts:518`, and read at `BaseAgentAdapter.ts:97,1137`, `cli/commands/hook.ts:212` (required) and `agents/core/evidence/routing.ts:55`. Several plugins read it (pi, opencode, codex, codemie-code, copilot-cli, assistants chat, skills-metrics).
- `CODEMIE_RESUME_SESSION_ID` — the agent session id named by `--resume`. It is set at `AgentCLI.ts:463` and read at `ensure-session.ts:54`, `hook.ts:1003` and `copilot-cli.plugin.ts:54`. Key constant at `session/types.ts:64`. It should carry the NATIVE id after the fix.
- `CODEMIE_CONTINUE_SESSION` — '1' for continue-style launches (`AgentCLI.ts:464`; read at `ensure-session.ts:55` and `hook.ts:1004`).
- `CODEMIE_SESSION_ORIGIN` — `codemie` (default) or `external-resume` (`buildResumeEnvOverride`; read at `hook.ts:964,987` and `session-origin-audit.ts:26`). `external-resume` means the session is never synced.
- `CODEMIE_NO_PROMPTS` — '1' forces non-interactive behavior (`AgentCLI.ts:907`, `utils/interactive.ts:25`).
- `CODEMIE_HOME` — overrides `~/.codemie` (`utils/paths.ts:368`). Tests set it for isolation.
- `CODEMIE_DEBUG` — `true` or `1` turns on console debug logging (`utils/logger.ts:320`). The session-ownership "Skipping unreadable session file" message is debug level.
- Unrelated: `CODEMIE_SESSION_SYNC_ENABLED`, `CODEMIE_SESSION_DRY_RUN`, `CODEMIE_SESSION_SYNC_INTERVAL`, `CODEMIE_SESSION_ANALYTICS_REPORT`, `CODEMIE_SESSION_END_SYNC_BUDGET_MS`.

### Configuration Files

- `src/utils/paths.ts:341-387` — `getCodemieHome()` and `getCodemiePath(...)`. `getCodemiePath('sessions')` is `<home>/sessions`.
- `src/migrations/002-consolidate-sessions.migration.ts:20-23` — consolidates sessions into `<home>/sessions` (files `<CODEMIE_SESSION_ID>.json`, `_metrics.json`, `_pi-run.jsonl`).
- `package.json` — scripts (`test`, `ci`, `lint` with `--max-warnings=0`). `vitest.config.ts` — project definitions.
- `.ai-run/guides/usage/project-config.md` — nothing relevant to resume.

### Feature Flags and Deployment Concerns

- There are no dedicated feature flags. The relevant runtime switches are `shouldBlockNonInteractiveResume()` (`!process.stdin.isTTY || CODEMIE_NO_PROMPTS==='1'`) and the origin gate.
- `AgentCLI.ts:201-203` computes `isNonInteractiveMode = !!options.task || isNonInteractiveEnvironment() || !process.stdout.isTTY`, but that only drives silent mode. The ownership gate does not use it.
- Audit events `resume_blocked` and `resume_external_confirmed` are written via `session-origin-audit.ts`.
- There are no deployment, CI or secrets concerns beyond the agent integration tests needing SSO/JWT credentials. `npm run ci` runs the unit and cli projects only. The agent project is not part of it.

---

## 6. Risk Indicators

- Origin gate hazard: if a resolved CodeMie id were not reported as `owned=true`, `origin=external-resume` would silently drop ALL telemetry for the run (`SessionSyncer.ts:198-205`, `syncProcessor.ts:54`). The test must assert both the owned result and the absence of the external-resume env override.
- The native id must be rewritten in several places. `options.resume` (read by `collectPassThroughArgs`, `AgentCLI.ts:654-680`), `providerEnv[CODEMIE_RESUME_SESSION_ID]` (:463, which is set BEFORE the ownership check) and the audit `auditData.nativeResumeId`. Missing any one leaves the CodeMie id reaching `claude -r` or the Session record.
- Interface change risk: `ResumeOwnershipResult` (`core/types.ts:731`) is shared across agents. Any new field must be optional and must not hardcode `claude` in shared messages (design-doc constraint).
- Ambiguity of the "non-interactive (--task)" criterion: the block is stdin-TTY driven, not `--task` driven (see Section 2). Criterion 5 (interactive warning) and 6 differ in code path (`promptExternalResume` readline vs block).
- Bare `-r <id>` bypasses `options.resume` entirely. Claude has no `extractNativeResumeId`, so `-r <codemie-id>` is neither ownership-checked nor rewritten. Decide whether it is in scope.
- Resolution edge cases:
  - generation-suffixed files `completed_<id>-<gen>*.json` (the filename id shown by analytics and `list-sessions` can be `<uuid>-<gen>`);
  - multiple records for one CodeMie id;
  - a record without a native id (still `correlation.status` pending, or placeholder `agentSessionId == sessionId`);
  - a CodeMie id of a non-Claude agent;
  - a native-id/CodeMie-id collision (a CodeMie id equal to another record's native id is practically impossible but should have a defined precedence).
- Marker file is a poor source: it has no native id (only `transcriptPath`), so resolution should use the session record's `correlation.agentSessionId`. `SessionStore.loadSession` cannot find generation-suffixed files and is async, while the existing scan is sync.
- Known deferred gap: DF-003, in-REPL `/resume` re-entry gets no baseline (`hook.ts:869`). This is unaffected by the fix but is relevant to "no duplicated telemetry" claims.
- Tests: the only direct unit test fixtures write `correlation.agentSessionId` only, without `sessionId`. Integration test criterion 8 needs real auth and network (agent project, 180s timeout, not part of `npm run ci`). `list-sessions` has no test coverage.
- The tests-on-request policy in AGENTS.md applies to agents running tests, but the ticket explicitly requires writing them (criteria 7 and 8).
- Documentation: `docs/COMMANDS.md:536-552` does not distinguish the id types and would be stale after the fix.
- Research gaps: no results for the EPMCDME-16992/16993 docs. Mechanism details come from code only. codegraph was unavailable, so no call-graph tooling was used. Callers were found by grep.

---

## 7. Summary for Complexity Assessment

This is a small, well-localized bug fix that crosses three layers: the core session helper (`session-ownership.ts`, 32 lines, sole production caller `ClaudePlugin.resolveResumeOwnership`), the Claude plugin, and the shared CLI layer (`AgentCLI.ts` ownership gate and `collectPassThroughArgs`). The expected change surface is about 4-5 source files (`session-ownership.ts`, `claude.plugin.ts`, `core/types.ts` for an optional result field, `AgentCLI.ts`, and likely `docs/COMMANDS.md`). It also needs 3-4 test files (`session-ownership.test.ts`, `AgentCLI-resume.test.ts`, a new `claude.plugin` resolver test and one new `tests/integration/agent-*.test.ts`). It does not touch the persistence format, the SSO/proxy layer or the telemetry pipeline. The codebase already has the supporting machinery: `SessionRecord.correlation.agentSessionId`, the baseline dedupe (EPMCDME-16537) and OTLP reopen handling (16992/16993) are keyed on the native id, so passing the native id to `claude -r` preserves them.

Technical novelty is low. The resume-ownership capability is an established optional-hook pattern with a written design doc, and the scan follows an existing sync fs pattern. The nontrivial part is the cross-layer plumbing. The native id must replace the user-supplied id in `options.resume`, in `CODEMIE_RESUME_SESSION_ID` and in the audit data, while keeping `owned=true` so the `external-resume` origin gate does not drop telemetry. Edge cases (generation-suffixed completed files, placeholder or missing native ids, bare `-r`, the TTY-vs-`--task` meaning of "non-interactive") need explicit decisions but do not require new architecture. Only Claude and Claude-ACP are affected. Other agents have no resolver, fail open and do not share the failing path, although the generic `AgentCLI` code is shared, so the change must stay agent-agnostic.

Test coverage posture is mixed. The scanner has a focused 7-test unit file (but no `sessionId` cases), and `AgentCLI` resume flow is well covered via a mocked resolver. There is no test for the Claude resolver, no end-to-end resume test and no `list-sessions` test. The ticket requires both unit and integration tests. The integration test depends on real SSO/JWT auth and network, which makes it the highest-effort and flakiest part, and it is outside `npm run ci`. Overall this is a low-to-medium complexity change with moderate risk concentrated in telemetry-origin correctness and the multi-point id rewrite.
