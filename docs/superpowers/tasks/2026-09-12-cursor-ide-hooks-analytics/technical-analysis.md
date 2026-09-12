# Technical Research

**Task**: hooks cursor-ide agent-plugin proxy-connect
**Generated**: 2026-09-12T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

Implement Cursor IDE Hooks + Analytics Ingestion. Goal: `codemie proxy connect --cursor-ide --analytics` writes `.cursor/hooks.json` wiring Cursor's full native hook surface to `codemie hook --agent cursor-ide`, and every delivered event is normalized into the internal hook pipeline and captured verbatim to a project-local JSONL file. Architecture: three seams - (1) `codemie hook` gains an explicit `--agent <name>` flag; (2) a registered `cursor-ide` agent plugin supplies `hookConfig.eventNameMapping` and a `HookTransformer` (conversation_id -> session_id); (3) a `cursor-ide.ts` connector in the existing per-target dispatch writes/merges `.cursor/hooks.json`. Full detailed implementation plan already exists at /Users/Uladzislau_Mamantau/projects/epam/codemie-code-fork/plan.md covering 10 tasks: adding --agent flag to codemie hook (src/cli/commands/hook.ts), reordering transform-before-validate and removing exit-code-2 blocking behavior for cursor-ide, creating a cursor-ide agent plugin + hook transformer (src/agents/plugins/cursor-ide/), extending InternalHookEventName to cover all 21 Cursor events and routeHookEvent switch, a Cursor stdout response contract module, raw event capture to a project-local JSONL log with a new resolveProjectRoot() helper, an --analytics flag on `codemie proxy connect` (src/cli/commands/proxy/index.ts, connect-orchestrator.ts), a cursor-ide.ts connector (src/cli/commands/proxy/connectors/) writing .cursor/hooks.json, a disconnect target, and manual e2e verification. No new dependencies; TypeScript/Commander/chalk/Vitest stack.

---

## 2. Codebase Findings

### Existing Implementations

**`src/cli/commands/hook.ts`** (1552 lines) - the single unified hook entry point:
- `createHookCommand()` (`:1454-1552`) - the `.action` body: reads stdin, `JSON.parse`, two pre-transform field checks (`session_id` at `:1479-1483`, `hook_event_name` at `:1485-1489`) each calling `process.exit(2)`, a JSON-parse-failure `process.exit(2)` at `:1475`, then `initializeHookContext()`, `applyHookTransformation()` (`:1499`), `validateHookEvent()` (`:1503`), `normalizeAndLogEvent()`, `routeHookEvent()`.
- `initializeLoggerContext()` (`:133-164`) - throws if `process.env.CODEMIE_AGENT` is absent; no flag-based override exists today. Also sets `logger.setSessionId`/`setAgentName` from env only.
- `initializeHookContext(config?)` (`:1352-1374`) - branches on presence of a `HookProcessingConfig` (programmatic mode, used by `processEvent`) vs CLI/env mode; CLI mode currently only calls `initializeLoggerContext()` and reads `CODEMIE_AGENT` from env directly at `:1370` (`agentName = process.env.CODEMIE_AGENT || 'unknown'` — inconsistent with the throwing behavior in `initializeLoggerContext`).
- `validateHookEvent(event, config?)` (`:1307-1345`) - checks `session_id`, `hook_event_name`, and `transcript_path`/`transcript_paths` (exempting only `SessionStart`/`SessionEnd` via a hardcoded `transcriptOptionalEvents` array at `:1333`). In CLI mode (`config` undefined) it sets `process.exitCode = 2` rather than throwing.
- `applyHookTransformation(event, agentName)` (`:1382-1403`) - looks up `AgentRegistry.getAgent(agentName)`, calls `(agent as any).getHookTransformer?.()`, applies `transformer.transform(event)`; swallows errors and falls back to the original event.
- `normalizeEventName(eventName, agentName)` (`:615-651`) - reads `agent.metadata?.hookConfig?.eventNameMapping`; returns the original name unchanged if no agent/mapping/entry is found (this is a local variable — it does not mutate `event.hook_event_name`, confirmed at `:668-672`).
- `routeHookEvent(event, rawInput, sessionId, agentName, config?)` (`:663-739`) - a `switch` over the normalized name with exactly 7 branches (`SessionStart`, `SessionEnd`, `PermissionRequest`, `Stop`, `UserPromptSubmit`, `SubagentStop`, `PreCompact`); `default:` logs "Unsupported event ... (silently ignored)" and returns (`:703-705`).
- `enforceAnalyticsAuthGate(config?)` (`:517-578`) - called from `handleUserPromptSubmit` (`:500`); on missing/invalid CodeMie SSO auth it calls `console.error(message)` then `process.exit(2)` at `:568-570` in CLI mode (throws instead in programmatic/`config` mode at `:565`).
- `performIncrementalSync` (`:293-...`) bails with a warning if `event.transcript_path`/`transcript_paths` are both empty (`:317-320`) — confirmed as the transcript-degradation path Cursor will hit.
- `getConfigValue(envKey, config?)` (around `:100-119`) reads either from a `HookProcessingConfig` map or `process.env`, keyed by fixed `CODEMIE_*` names — this is the mechanism `buildCopilotHookConfig` (copilot-cli plugin) uses to run the hook pipeline without real environment variables.
- `logger.debug` and unconditional `logger.success` both call `console.log` (`src/utils/logger.ts`, `debug` branch ~`:295-309`, `success` at `:317-319`) — `success` is not gated by `isDebugMode()`, confirmed unused on the current hook path but not structurally prevented from writing to stdout.

**`src/agents/core/types.ts`** (848 lines):
- `InternalHookEventName` (`:640-647`) - exactly the union `'SessionStart' | 'SessionEnd' | 'PermissionRequest' | 'Stop' | 'UserPromptSubmit' | 'SubagentStop' | 'PreCompact'`.
- `AgentHookConfig` (`:652-667`) - currently only `eventNameMapping?: Record<string, InternalHookEventName>`; no `transcriptOptional` field exists yet.
- `HookTransformer` (`:622-634`) - `{ transform(event: unknown): BaseHookEvent; readonly agentName: string }`.
- `BaseHookEvent` (`:675-687`) - `session_id`, `transcript_path`, `transcript_paths?`, `permission_mode`, `hook_event_name`, `cwd?`, `source?`, `reason?`, `agent_id?`, `agent_transcript_path?`, `stop_hook_active?`. No `tool_name`/`tool_input`/`tool_output`/`tool_use_id` fields exist on the shared type today.
- `AgentMetadata.analyticsOnly?: boolean` (`:338`) - doc comment: "True for agents CodeMie only reads analytics for and never installs, launches, or manages (e.g. GitHub Copilot CLI)." This is the sole gate consumed by `AgentRegistry.getManageableAgents()` (`registry.ts:92-97`) and referenced by `isAnalyticsOnlyAgent()` in `src/cli/commands/analytics/native-loader.ts`.

**`src/agents/registry.ts`** (133 lines) - `AgentRegistry.initialize()` (`:30-48`) statically constructs and registers 11 plugins including `CopilotCliPlugin`; no `cursor-ide` plugin registered today, so `AgentRegistry.getAgent('cursor-ide')` currently returns `undefined`. `getManageableAgents()` (`:92-97`) filters on `analyticsOnly !== true`; `getAllAgents()` (`:68-71`) does not filter, and is what the hook pipeline's `AgentRegistry.getAgent()` lookups use.

**`src/agents/plugins/copilot-cli/copilot-cli.plugin.ts`** - the precedent for an analytics-only plugin: `hookConfig.eventNameMapping` maps 6 Copilot-native names onto 4 of the 7 internal names (including a many-to-one `PreToolUse`/`Notification` -> `UserPromptSubmit`/`PermissionRequest` mapping, confirming the mapping table is not required to be 1:1). It has a real `cliCommand` and is NOT `analyticsOnly` in metadata shown (`sessionAnalyticsReport: true` present but no `analyticsOnly` key) — actually installable/listed, unlike what `cursor-ide` needs. Its `lifecycle.onSessionStart`/`onSessionEnd` call `processEvent()` (the programmatic entry point) with a `HookProcessingConfig` built by `buildCopilotHookConfig(env, sessionId)`, bypassing environment variables entirely — this is the working precedent for driving the hook pipeline without `CODEMIE_AGENT`/`CODEMIE_SESSION_ID` in `process.env`.

**`src/agents/plugins/gemini/gemini.hook-transformer.ts`** and **`src/agents/plugins/kimi/kimi.hook-transformer.ts`** - both minimal `HookTransformer` implementations (add `permission_mode: 'default'`; Kimi additionally computes a `transcript_path` the raw payload lacks via `getKimiMainWirePath(cwd, sessionId)`, the closest existing precedent for a transformer deriving a field the raw agent payload omits).

**`src/utils/hook-command.ts`** - `resolveCodemieBinary()` (`:28-48`) resolves a PATH-independent absolute binary path (PATH shim, then `argv[1]`, then bare `codemie`, with Windows `node <script>` quoting). `resolveHookCommand(command, binary)` (`:51-55`) and `rewriteHooksCommandTree(node, binary)` (`:59-86`) recursively rewrite any `command` string field in an arbitrary hooks JSON tree — a shape-agnostic precedent directly reusable (or adaptable) for merging/rewriting `.cursor/hooks.json`.

**`src/cli/commands/proxy/index.ts`** (386 lines) - `UnifiedConnectOptions` (`:33-44`) already has `cursorIde?: boolean` and no `analytics` field. The `connect` command's option chain (`:291-301`) already registers `--cursor-ide` with help text `'Configure Cursor IDE — analytics only for now'`; no `--analytics` option exists. `disconnect` (`:319-325`) only wires `--codex-desktop`.

**`src/cli/commands/proxy/connect-orchestrator.ts`** (714 lines) - `ConnectTargets`/`ConnectOptions` (`:56-73`) already include `cursorIde?: boolean` but no `analytics` field. `TARGET_LIST` (`:266-282`) already lists `--cursor-ide`. `hasAnyTarget` (`:284-286`) and `describeTargets` (`:289-299`) already account for `cursorIde`. `deriveDaemonIdentity` (`:99-107`) has no `cursorIde` branch (falls through to the `vscode-byok` default only if reached — but it is never reached today because of the short-circuit below). `connectTargets` (`:593-714`) has a hardcoded short-circuit at `:600-603`: if `cursorIde` is requested alongside no other target, it prints `'Note: Only analytics is supported for --cursor-ide.'` and returns *before* any daemon/profile logic — this is the "already in place" no-op state the plan's global constraints describe. The per-target dispatch block (`:688-700`) has branches for `claudeDesktop`, `vscode`, `vscodeClaudeCode`, `codexDesktop` — no `cursorIde` branch, so today the target is silently absent from `printSummary` if ever combined with another (currently impossible given the short-circuit).

**Connector precedents** in `src/cli/commands/proxy/connectors/`:
- `vscode-claude-code.ts` - `writeVsCodeClaudeCodeConfigAtPath(configPath, ...)` test seam plus `writeVsCodeClaudeCodeConfig(...)` wrapper; read-merge-write via `readSettings()` (tolerates missing/malformed file), a pure upsert helper (`upsertManagedEnvVars`), and `writeAtomically()` from `./vscode.js`. No backup mechanism in this connector.
- `codex-desktop.ts` - has the backup precedent: `BACKUP_SUFFIX = '.codemie-backup'` (`:84`), `backupIfUnmanaged(configPath, currentText)` (`:94-...`) which is keyed on "managed marker presence" rather than "backup file presence" to avoid re-enshrining an already-CodeMie-modified file as the "original"; `removeCodexDesktopConfig` supports a surgical strip with backup-restore fallback (referenced by `disconnect-orchestrator.ts`).
- `vscode.ts` - `writeAtomically(configPath, content)` (`:204`), the shared atomic-write primitive both other connectors use.
- No shared `ConnectResult`/`DisconnectResult` type exists; each connector returns its own result shape and the orchestrator normalizes into its own private `TargetResult` (`connect-orchestrator.ts:379-383`).

**`src/cli/commands/proxy/disconnect-orchestrator.ts`** - `DisconnectTargets` (`:14-16`) has only `codexDesktop?: boolean` today; `disconnectTargets()` (`:31-58`) is a single-target `if` (not a per-target dispatch loop like `connectTargets`), printing a target list when no target is set.

**`src/utils/paths.ts`** - `resolveLocalTargetPath(baseTargetDir = '.codemie')` (`:106-108`) is `path.join(process.cwd(), baseTargetDir)` — confirmed CWD-relative, not project-root-detecting, as the plan's "project root gap" section states. No existing `resolveProjectRoot()` helper exists anywhere in `src/utils/`.

**`src/utils/security.ts`** - `sanitizeLogArgs(...args)` (`:235-...`) exists and is the established sanitization entry point referenced throughout `connect-orchestrator.ts` and elsewhere (e.g. `:308`, `:585`).

### Architecture and Layers Affected

- **CLI command layer**: `src/cli/commands/hook.ts` (new `--agent` option on `createHookCommand()`), `src/cli/commands/proxy/index.ts` (new `--analytics` option, `disconnect` option wiring).
- **Orchestration layer**: `src/cli/commands/proxy/connect-orchestrator.ts` (`ConnectOptions.analytics`, replacing the `cursorIde`-alone short-circuit with a real per-target runner, `TARGET_LIST` text update), `src/cli/commands/proxy/disconnect-orchestrator.ts` (new target).
- **Connector layer**: new `src/cli/commands/proxy/connectors/cursor-ide.ts`, modeled on `vscode-claude-code.ts` (read/merge/write shape) and `codex-desktop.ts` (backup mechanics).
- **Agent plugin layer**: new `src/agents/plugins/cursor-ide/` (plugin metadata, hook transformer, constants, types), registered in `src/agents/registry.ts`.
- **Core hook-event-type layer**: `src/agents/core/types.ts` (`InternalHookEventName` extension, `AgentHookConfig.transcriptOptional?`, new optional fields on `BaseHookEvent`).
- **Shared utility layer**: new `src/utils/project-root.ts`; existing `src/utils/hook-command.ts` (`resolveCodemieBinary`, hooks-tree rewriting) and `src/utils/security.ts` (`sanitizeLogArgs`) are consumed, not modified.

### Integration Points

- `AgentRegistry.getAgent(agentName)` — consumed by `applyHookTransformation` and `normalizeEventName` in `hook.ts`; both are registry lookups requiring no call-site changes once `cursor-ide` is registered.
- `processEvent()` (`hook.ts`, exported) — the programmatic entry point Copilot's plugin already uses via `lifecycle.onSessionStart`/`onSessionEnd`; not directly required by this plan (Cursor drives the CLI `.action` path via real subprocess hooks) but is the pattern to be aware of for anything invoking the hook pipeline without a real stdin subprocess.
- `enforceAnalyticsAuthGate` → `CodeMieSSO.getStoredCredentials`, `getAnalyticsAuthStatus()` (`src/utils/analytics-auth-status.js`) — reachable from Cursor's `beforeSubmitPrompt` → `UserPromptSubmit` mapping; a stale/missing token path calls `process.exit(2)` today.
- `SessionSyncer.sync` (`src/providers/plugins/sso/session/SessionSyncer.js`) — invoked from `handleSessionEnd` → `syncPendingDataToAPI`; posts metrics to `/v1/metrics` via `metrics-api-client` per the plan's "Daemon" note (no daemon involvement for cursor-ide).
- `getCommandPath` (`src/utils/processes.js`) — underlies `resolveCodemieBinary()`, used by the new connector to resolve the absolute hook command.
- No third-party SDK/HTTP client is imported directly by the hook/connector code researched; metrics posting goes through the existing internal `metrics-api-client` module (not read in this pass — out of scope per the plan's "Follow-up backlog" item 1, which explicitly defers backend metrics mapping).

### Patterns and Conventions

- **Declarative agent extension points, no `if (agentName === ...)` branches**: every agent-specific behavior in `hook.ts` is expressed through `AgentRegistry` lookups of `metadata.hookConfig.eventNameMapping` and `getHookTransformer()` — confirmed by `applyHookTransformation` and `normalizeEventName` implementations.
- **`analyticsOnly: true` gate**: the sole mechanism (`AgentMetadata.analyticsOnly`, `types.ts:338`) that excludes an agent from `codemie install/list/uninstall/update`; `cliCommand` being unset is not sufficient on its own (confirmed — `CopilotCliPlugin` metadata omits `analyticsOnly` and does set a real `cliCommand`, remaining fully manageable; some other lookup path would need checking for whether Copilot itself sets `analyticsOnly` elsewhere, but the type declaration and registry filter are the definitive gate).
- **Connector return-shape convention**: `{ written: boolean; path: string }` at minimum (`vscode-claude-code.ts`), extended with `backupPath`/state fields in `codex-desktop.ts`; no shared interface.
- **Backup-before-modify, restore-on-disconnect**: `codex-desktop.ts`'s marker-keyed `backupIfUnmanaged` plus `disconnect-orchestrator.ts`'s backup-restore fallback is the direct precedent for `cursor-ide.ts`'s planned `.cursor/hooks.json.codemie-backup`.
- **Non-blocking error handling with `logger.debug`/`logger.warn` and explicit comments** ("Don't throw — X failure should not block Y") is the dominant idiom throughout `hook.ts` (`startActivityTracking`, `accumulateActiveDuration`, `syncPendingDataToAPI`, `syncSkillsToClaude`) — the same idiom the plan's non-blocking-analytics requirement for cursor-ide must extend.
- **Dynamic `import()` for optional/heavy dependencies** inside handlers (e.g. `SessionStore`, `SessionSyncer`, `session-origin-audit`) rather than top-level imports — used throughout `hook.ts`.

---

## 3. Documentation Findings

### Guides and Architecture Docs

No guide file under `.ai-run/guides/` was found covering Cursor IDE, hook event routing internals, or the proxy connector pattern specifically. `external-integrations.md` contains exactly one incidental Cursor mention (`:287`, unrelated `--agent cursor` marker in `skill-detection.ts`, explicitly called out in the plan as out of scope). No architecture doc describes the hook pipeline's internal event-name routing or the connector merge/backup convention — these were derived entirely from code (Section 2).

### Architectural Decisions

None found as formal ADRs. The plan document itself (`/Users/Uladzislau_Mamantau/projects/epam/codemie-code-fork/plan.md`) is the authoritative design record for this task (see Section 8). A related prior task directory, `docs/superpowers/tasks/2026-09-10-codemie-proxy-connect-cursor-ide/`, contains a `technical-analysis.md`, `plan.md`, and gate/review artifacts for the earlier work that added the bare `--cursor-ide` flag and its "analytics only for now" short-circuit — i.e. the current state this plan builds on. Not re-read in full (out of scope for this pass; the current-state facts it produced are already reflected in Section 2 via direct source reads).

### Derived Conventions

- Agent plugins that are analytics-only but not installable set `metadata.analyticsOnly = true` and typically omit a real `cliCommand` (inferred from `types.ts:330-338`'s doc comment, though `CopilotCliPlugin` is the one counter-example that sets a real `cliCommand` while still being read for analytics — Copilot is fully manageable, unlike the planned `cursor-ide`).
- Every hook event handler in `hook.ts` takes `(event, sessionId, config?)` and is `async`; each is dispatched from one `switch` case in `routeHookEvent`.
- New internal event names are added to the `InternalHookEventName` union and mirrored in `AgentHookConfig`'s JSDoc listing valid mapping values (`types.ts:657-658`) — both must be updated together to avoid stale documentation.

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts:247-259` — `'--cursor-ide alone prints the analytics-only note and does no daemon/profile work'`, asserting the current short-circuit behavior at `connect-orchestrator.ts:600-603`. This test will fail once the short-circuit is replaced with a real per-target runner, per the plan's Global Constraints.
- `src/cli/commands/proxy/__tests__/connect-wiring.test.ts:47,52-62` — asserts `--cursor-ide` maps into `ConnectTargets.cursorIde` via the CLI wiring (`createProxyCommand().parseAsync(['connect', '--cursor-ide'], ...)`), and a combined-targets test at `:47` includes `cursorIde: false`. These wiring assertions should stay valid but need the `--analytics` combination added; the plan explicitly calls out both files as needing updates to stay green.
- No test files exist yet under `src/agents/plugins/cursor-ide/__tests__/` (directory does not exist) — confirmed via directory listing showing only `claude-acp`, `codemie-code`, `codex`, `gemini`, `kimi`, `openwiki`, `opencode`, `pi`, `copilot-cli` plugin directories (no `cursor-ide`).
- No test file exists for `src/cli/commands/hook.ts`'s `--agent` flag, the transform-before-validate reordering, or the 21-event router extension — these are new-plan-only behaviors.
- No test file exists for a `resolveProjectRoot()` helper (module does not exist).
- `src/cli/commands/proxy/connectors/__tests__/` exists and presumably covers `codex-desktop.ts`/`vscode-claude-code.ts` (directory confirmed present; contents not enumerated in this pass) — no `cursor-ide.ts` connector test exists yet.

### Testing Framework and Patterns

Vitest (`vitest.config.ts`, `package.json` scripts: `test`, `test:coverage`, `test:watch`, `test:ui`; three named projects — `unit`, `cli`, `agent`). `connect-wiring.test.ts` drives the real Commander command via `createProxyCommand().parseAsync([...], { from: 'user' })` and asserts on a mocked `connectTargets` call's arguments — the pattern to follow for any new `--analytics`/`--agent` wiring test.

### Coverage Gaps

- The entire `cursor-ide` agent plugin, hook transformer, stdout response contract, event-log appender, `resolveProjectRoot()`, and connector are greenfield with zero existing tests (all optional-TDD per the plan; AGENTS.md rule 2 — no new test authoring unless the user explicitly asks).
- The two existing test files that assert the current `--cursor-ide` short-circuit behavior are a **known regression point** the plan calls out by file and line — any implementation must update them to stay green even without adding new tests.
- The `hook.ts` `.action` body's reordering (transform-before-validate) and exit-code-2 removal for `cursor-ide` are behavior changes to a 1552-line file with no dedicated hook.ts unit test file identified in this pass (none found by name in the directory listing) — a high-risk area to modify without direct test coverage.

---

## 5. Configuration and Environment

### Environment Variables

Env vars consumed via `getConfigValue`/direct `process.env` reads in `hook.ts`: `CODEMIE_AGENT`, `CODEMIE_SESSION_ID`, `CODEMIE_PROVIDER`, `CODEMIE_BASE_URL`, `CODEMIE_API_KEY`, `CODEMIE_CLIENT_TYPE`, `CODEMIE_CLI_VERSION`, `CODEMIE_PROFILE_NAME`, `CODEMIE_PROJECT`, `CODEMIE_MODEL`, `CODEMIE_URL`, `CODEMIE_SYNC_API_URL` (mapping table at `hook.ts:100-112`). None of these are settable via Cursor's `hooks.json` schema (no `env` key per the plan's Global Constraints) — this is the documented reason the new `--agent` flag is needed. `CODEMIE_DEBUG` gates `logger.debug()`'s `console.log` in `src/utils/logger.ts`.

### Configuration Files

- `.cursor/hooks.json` — the file the new connector will write/merge (does not exist in this repo; target is the *user's project*, not this repo).
- No CodeMie-side config file references Cursor today (`config.example.json` not grepped for "cursor" in this pass, but no hits surfaced in guide/architecture searches).
- `.gitignore` (this repo's own) already ignores `.codemie` (bare, line 63) and `/.cursor/` (line, confirmed) at the repo root — both broad enough to already cover `.codemie/logs/` if a `.codemie` or `.cursor` directory were ever created inside this repo for local testing; the plan's Task 6 instruction to "add `.codemie/logs/` to `.gitignore`" may be redundant with the existing `.codemine` bare-name ignore, worth confirming pattern-matching semantics before adding a duplicate line.

### Feature Flags and Deployment Concerns

- `CODEMIE_CURSOR_HOOK_TRACE` — a new flag proposed by the plan (Task 6 Step 5) to gate the raw event-capture log, default-on for this release; does not exist yet anywhere in the codebase (not found in `hook-command.ts`, `hook.ts`, or elsewhere).
- No CI/CD or Dockerfile reference to Cursor was found.
- No secrets-management pattern is implicated — the raw event log capture explicitly requires `sanitizeLogArgs()` before writing untrusted file/command content (per the plan and consistent with `security-practices.md` conventions already used in `connect-orchestrator.ts`).

---

## 6. Risk Indicators

- Speculative: Reordering `hook.ts`'s `.action` body (transform-before-validate) and scoping `process.exit(2)`/`process.exitCode = 2` sites to skip `cursor-ide` touches a single 1552-line file with three separate historical exit-2 sites (`:1475` parse failure, `:1479-1489` pre-transform field checks, `validateHookEvent`'s three assignments at `:1315`, `:1326`, `:1342`, plus `enforceAnalyticsAuthGate`'s `:570`) and no dedicated `hook.ts` unit test file was found in this pass — a missed site would silently reintroduce blocking behavior for Cursor.
- The two existing proxy tests (`connect-orchestrator.test.ts:247-259`, `connect-wiring.test.ts:47,52-62`) assert the *current* `--cursor-ide`-alone short-circuit and will need direct updates to stay green; no automated safety net currently exists to catch a regression in the opposite direction (accidentally re-adding the short-circuit) once the real target runner lands.
- `normalizeEventName`'s fallback ("no mapping found — use event name as-is", `hook.ts:643-645`) means any of the 21 Cursor event names *not* added to `InternalHookEventName`/`eventNameMapping`/the `routeHookEvent` switch will silently hit the `default:` branch and be logged as "Unsupported event ... (silently ignored)" rather than erroring — a mapping omission is not fail-loud.
- `AgentRegistry.getAgent('cursor-ide')` currently returns `undefined`; both `applyHookTransformation` and `normalizeEventName` degrade gracefully (log-and-continue) when the agent is missing, meaning a registration bug (e.g. typo'd agent name in the connector's generated `command` string vs the registry key) would silently disable transformation/mapping rather than fail visibly.
- No existing `resolveProjectRoot()` helper exists; the plan requires both the new event-log writer and the new connector to share it so the two file locations (`.codemie/logs/cursor-hook-events.jsonl` and `.cursor/hooks.json`) can never diverge — a divergent implementation in either consumer would defeat this guarantee silently.
- `logger.success()` at `src/utils/logger.ts` writes unconditionally to `console.log` (not gated by `CODEMIE_DEBUG`) and is confirmed unreachable from the current hook path, but nothing structurally prevents a future code path (including anything added by this plan) from calling it and corrupting Cursor's stdout-as-response-channel contract.
- The raw event-capture log's stated payload sources (`beforeReadFile` full file content, `afterFileEdit` old/new strings, `beforeShellExecution` raw commands) are exactly the kind of content `sanitizeLogArgs()` was built for elsewhere in this codebase, but no prior capture-to-project-local-JSONL precedent exists to confirm sanitization sufficiency for full-file-content-sized payloads (size capping/truncation is new, not reused from an existing pattern).
- Two connectors (`vscode-claude-code.ts`, `codex-desktop.ts`) diverge on backup strategy (none vs marker-keyed backup-and-restore); the plan directs `cursor-ide.ts` to follow the `codex-desktop.ts` backup precedent specifically — a reasonable but non-uniform choice across the connector family that increases the chance of subtly copying the wrong precedent's edge-case handling.

---

## 7. Summary for Complexity Assessment

The task spans five architectural layers with a wide, well-scoped file-change surface: the CLI command layer (`hook.ts` flag addition and control-flow reordering, `proxy/index.ts` new option and disconnect wiring), the orchestration layer (`connect-orchestrator.ts` replacing a hardcoded short-circuit with a real per-target runner, `disconnect-orchestrator.ts` adding a second target), a brand-new agent plugin (`src/agents/plugins/cursor-ide/`, four new files plus registry registration), a core type extension (`InternalHookEventName` from 7 to 14 values, `AgentHookConfig.transcriptOptional`, `BaseHookEvent` field additions), and two new shared utilities (`src/utils/project-root.ts`, a Cursor stdout-response module). Every one of these layers has a direct, already-read precedent to model from (Gemini/Kimi transformers, Copilot's analytics-only plugin, the `vscode-claude-code.ts`/`codex-desktop.ts` connectors, `hook-command.ts`'s hooks-tree rewriter), which meaningfully de-risks the implementation pattern even though the surface area is large.

The highest-risk concentration is in `hook.ts` itself: it is a single 1552-line file with three independent, historically load-bearing `process.exit(2)` sites that must all be scoped to skip `cursor-ide` without altering behavior for Claude/Gemini/Kimi/Copilot, and no dedicated unit test file for this module was found in this research pass — meaning the safety net for this reordering is whatever manual/e2e verification the plan's Task 10 provides plus the two proxy-layer tests that must be edited anyway. `normalizeEventName`'s silent-fallback behavior compounds this: a mapping gap for any of the 21 Cursor events fails silently (logged, not errored), so completeness of the mapping table is a correctness property that automated tests, if written, would need to check exhaustively rather than spot-check.

Novelty is concentrated in three genuinely new mechanisms with no direct in-repo precedent: a project-root-detection helper shared between two consumers, a raw-payload JSONL event log with size-capping/truncation and sanitization for payloads that can contain full file contents, and a stdout-response contract that must guarantee zero non-JSON bytes reach stdout across both the success and error paths of a 1552-line command. Combined with the two existing tests that will regress by design and the complete absence of tests for every new file, this is a substantial, multi-file, cross-layer change with real (if precedented) technical depth rather than a simple additive feature.

---

## 8. External References

**`/Users/Uladzislau_Mamantau/projects/epam/codemie-code-fork/plan.md`** — resolved, read in full (327 lines). This is the task's canonical source of truth, an already-complete 10-task implementation plan. Key facts a downstream spec/plan must carry forward without re-deriving:

- **Upstream reference**: `https://cursor.com/docs/hooks` (canonical; `/docs/agent/hooks` redirects here), verified 2026-09-11 by the plan's author — not independently re-verified in this research pass.
- **Global constraints** (plan.md:17-29): stdout is Cursor's response channel (nothing but the deliberate response object may reach it); exit code 2 blocks the user's action in Cursor and there are exactly **three** exit-2 sites to neutralize (`.action` body parse/validate checks, `validateHookEvent`'s `process.exitCode = 2`, `enforceAnalyticsAuthGate`'s `process.exit(2)` at `hook.ts:570`); Cursor's `hooks.json` schema has no `env` key (per-hook keys are `command`, `type`, `timeout`, `loop_limit`, `failClosed`, `matcher`, plus `prompt`/`model` for prompt hooks); `transcript_path` is nullable and there is no Cursor transcript parser; hooks are merged additively from all config sources by Cursor so the connector must upsert, never clobber; no token/cost data exists on any Cursor hook payload except `preCompact`'s `context_tokens`/`context_window_size`/`context_usage_percent`; canonical agent name is `cursor-ide` everywhere.
- **21-event mapping table** (plan.md:140-165): the full Cursor-event-to-internal-event table, including which of the 7 new internal names (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `AgentResponse`, `AgentThought`, `WorkspaceOpen`) each of the 14 additional Cursor events maps to, and which can block upstream (`preToolUse`, `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `beforeTabFileRead`, `subagentStart`, `beforeSubmitPrompt`).
- **Transformer field mapping** (plan.md:108-117): `session_id` = `conversation_id` (fallback `session_id`, then `generation_id`); `transcript_path` = `transcript_path ?? ''`; `permission_mode` = `'default'`; `cwd` = `cwd ?? workspace_roots[0] ?? process.cwd()`; `hook_event_name` left as the Cursor-native name (not renamed by the transformer — `normalizeEventName` handles that separately).
- **Response matrix** (plan.md:190-193): `preToolUse`/`beforeShellExecution`/`beforeMCPExecution`/`beforeReadFile`/`beforeTabFileRead`/`subagentStart` emit `{"permission":"allow"}`; `beforeSubmitPrompt` emits `{"continue":true}`; every other event emits nothing; always exit 0.
- **Connector file shape** (plan.md:272): `version: 1`, one entry per event key of the form `{ command: "<resolved binary> hook --agent cursor-ide", timeout: 10, failClosed: false }`; no `matcher`, no per-event argv; backup to `.cursor/hooks.json.codemie-backup`.
- **Acceptance criteria** (plan.md:31-46) and the **10-task breakdown with file-level line references** (plan.md:49-317) are the authoritative task decomposition and should be used directly by the planning stage rather than re-derived.
- **Follow-up backlog** (plan.md:321-326): backend metrics mapping (`ToolUsageAttributes`/`SessionLifecycleAttributes`) is explicitly out of scope for this run — `--analytics` installs the hooks but no new data reaches `/v1/metrics` until that follow-up lands.
