# Technical Research

**Task**: hooks logging claude sessions
**Generated**: 2026-08-20T00:00:00Z
**Research path**: codegraph

---

## 1. Original Context

Investigate recent Claude Code sessions and CodeMie logs — Claude hooks sometimes throw errors but it's unclear what's happening. Review existing logs/sessions to find the root cause, plan and fix the issue, and revisit the logging approach so hook behavior is clear to users in their environment.

---

## 2. Codebase Findings

### Existing Implementations

**Hook execution engine** (`src/hooks/`):
- `src/hooks/executor.ts` — `HookExecutor` class. Orchestrates `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart` hook lifecycles. Deduplicates hooks by SHA-256 hash of `{type, command, prompt, timeout}` (`hashHook`). Executes hooks in parallel via `Promise.allSettled` (`executeHooks`). `executeSingleHook` wraps command/prompt execution in try/catch and **fails open**: any thrown error is caught, logged via `logger.error('Hook execution failed: ${error}')`, and converted into `{ decision: 'allow', reason: 'Hook failed: <message>' }` — the hook error never propagates or blocks execution.
- `executeCommandHook` runs shell commands via `exec()` (`src/utils/exec.ts`), passing sanitized hook input JSON through the `CODEMIE_HOOK_INPUT` env var; stdout/stderr are logged only at `debug` level (`logger.debug('Hook stdout: ...')` / `'Hook stderr: ...'`).
- `executePromptHook` runs LLM-based hooks via `PromptHookExecutor` (`src/hooks/prompt-executor.ts`); if no LLM config was supplied, it logs a `warn` and defaults to `allow`.
- `src/hooks/decision.ts` — `DecisionParser.parse`/`merge`, interprets hook stdout/exit code into an `AggregatedHookResult`.
- `src/hooks/matcher.ts` — `HookMatcher.matches` for tool-name pattern matching.
- `src/hooks/types.ts` — `HooksConfiguration`, `HookConfig`, `HookInput`, `HookResult`, `AggregatedHookResult`, `HookExecutionContext`.

**CLI hook entry point** (`src/cli/commands/hook.ts`, ~1550 lines):
- `createHookCommand()` — the `codemie hook` Commander command; this is what agent plugins (including Claude) invoke as their hook script. Reads JSON from stdin, parses it, validates required fields (`validateHookEvent`), initializes logger context (`initializeHookContext`), applies an agent-specific transformer (`applyHookTransformation`), normalizes the event name, then dispatches via `routeHookEvent`.
- Top-level `try/catch` around the whole command: on any thrown error it logs `'[hook] Failed to handle ${eventName} event (${duration}ms): ${message}'` at `error` level (plus stack at `debug` level only), flushes the logger, and sets `process.exitCode = 1`.
- `initializeHookContext(config?)` sets `logger.setAgentName`, `logger.setSessionId`, `logger.setProfileName` from either an explicit config object or `CODEMIE_AGENT`/env vars — this is what stamps every subsequent log line with `[agent][session][profile]`.
- `applyHookTransformation` wraps `AgentRegistry.getAgent(agentName)` + `getHookTransformer()` in its own try/catch; a transform failure is logged at `error` level and silently falls back to the untransformed event.
- `processEvent()` is the programmatic (non-CLI) entry point with the same flow, used by e.g. a VS Code plugin integration.

**Plugin hooks loading** (`src/plugins/loaders/hooks-loader.ts`):
- `loadPluginHooks(pluginDir, manifest)` — reads a plugin's `hooks/hooks.json` (or inline manifest `hooks` field), expands `${CLAUDE_PLUGIN_ROOT}` in command strings (`expandHooksCommands`). A JSON parse failure here is caught and only logged at `debug` level (`'[plugin] Failed to parse hooks from ${path}: ...'`), then the loop silently continues to the next candidate path — a malformed plugin hooks file produces no hooks and no visible error unless `CODEMIE_DEBUG` is on.
- `mergeHooks(base, pluginHooks)` — appends plugin hooks after profile hooks per event.

**Claude-specific session/plugin code** (`src/agents/plugins/claude/`):
- `claude.plugin.ts` — `ClaudePlugin extends BaseAgentAdapter`; `claude-acp.plugin.ts` — `ClaudeAcpPlugin`.
- `claude.session.ts` — `ClaudeSessionAdapter implements SessionAdapter`. Discovers native sessions under `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` (`discoverSessions`), registers `MetricsProcessor` and `ConversationsProcessor` (priority order), parses transcript JSONL via `readJSONL`.
- `claude.models.ts` — live-catalog Claude model resolution (`resolveClaudeModel`), unrelated to hooks but shares the same plugin directory and logger usage pattern.

**Logging infrastructure** (`src/utils/logger.ts`):
- Single `Logger` class, exported as a module-level singleton `logger`. Two independent output paths:
  - **File**: `writeToLogFile()` always writes every `debug`/`info`/`warn`/`error` call to `~/.codemie/logs/debug-YYYY-MM-DD.log`, prefixed `[timestamp] [LEVEL] [agent] [sessionId] [profile]`, with args passed through `sanitizeLogArgs()` before serialization. File logging happens **regardless of debug mode**.
  - **Console**: `debug()` and `error()` only print to the console when `isDebugMode()` is true (`CODEMIE_DEBUG=true|1`); `info()`/`warn()` never print to console at all, file-only. `success()` always prints to console (no file write). This asymmetry means a hook failure logged via `logger.error(...)` from `executeSingleHook` (see above) is written to the daily debug log file but is **invisible in the terminal unless `CODEMIE_DEBUG` is set** — matching the ticket's "unclear what's happening" symptom.
  - Log file rotation is date-based (`rotateLogFileIfNeeded`, fire-and-forget, guards against `ERR_STREAM_WRITE_AFTER_END`), with a `cleanupOldLogs` pass deleting `debug-*.log` files older than 5 days on every `initializeLogFile()` call.
  - `getLogFilePath()` exposes the active log path programmatically.
- `src/mcp/proxy-logger.ts` — a **separate**, independent file logger (`~/.codemie/mcp-proxy.log`) for the MCP proxy bridge, gated by `CODEMIE_DEBUG` or `MCP_PROXY_DEBUG`; not wired into the main `logger` singleton's file, so proxy-side and hook-side logs live in different files.

**Session persistence** (`src/agents/core/session/SessionStore.ts`):
- `SessionStore` persists one JSON file per session at `~/.codemie/sessions/{sessionId}.json`; `loadSession` falls back to a `completed_{sessionId}.json` name (handles a rename race with `handleSessionEnd`). All read/write failures go through `logger.error` with `createErrorContext`/`formatErrorForLog`.

**Error taxonomy** (`src/utils/errors.ts`):
- `CodeMieError` base class; `ConfigurationError`, `AgentNotFoundError`, `AgentInstallationError`, `ToolExecutionError`, `PathSecurityError`, `AnalyticsSourceError`, `NpmError` all extend it. `createErrorContext()` builds a structured `{error, system, client, session, timestamp}` object used for richer error logging in some call sites (`SessionStore`), but `HookExecutor.executeSingleHook` and `hook.ts`'s top-level catch use plain `error.message`/`error.stack` string interpolation instead of this structured context.

### Architecture and Layers Affected

- **CLI Layer** — `src/cli/commands/hook.ts` (the `codemie hook` command invoked by agent hook scripts, including Claude's `hooks.json` commands).
- **Core/Engine Layer** — `src/hooks/executor.ts`, `src/hooks/prompt-executor.ts`, `src/hooks/decision.ts`, `src/hooks/matcher.ts` (hook execution engine, agent-agnostic).
- **Plugin Layer** — `src/plugins/loaders/hooks-loader.ts` (plugin hooks discovery), `src/agents/plugins/claude/*` (Claude-specific session parsing, plugin adapter, hook transformer lookup via `AgentRegistry.getAgent(agentName).getHookTransformer()`).
- **Utils Layer** — `src/utils/logger.ts` (Logger singleton), `src/utils/errors.ts` (error classes), `src/utils/security.ts` (`sanitizeLogArgs`, `sanitizeValue`), `src/mcp/proxy-logger.ts` (separate proxy log).

Per `.ai-run/guides/architecture/architecture.md`, the declared communication rule is `CLI → Registry → Plugin → Core → Utils`; `hook.ts` calling `AgentRegistry.getAgent()` directly and `HookExecutor` living under `src/hooks/` (not under a `core/` subpath) are consistent with this generally, though `src/hooks/` sits outside the `agents/core` tree the guide otherwise documents.

### Integration Points

- `exec()` (`src/utils/exec.ts`) — shells out to run command-type hooks with a timeout (default 60s) and `shell: true`.
- `AgentRegistry.getAgent(agentName)` — used by `applyHookTransformation` in `hook.ts` to fetch an agent-specific hook event transformer.
- `PromptHookExecutor` — calls an LLM for `type: 'prompt'` hooks; requires `PromptHookLLMConfig` (apiKey, baseUrl, model, timeout, debug) to be supplied to `HookExecutor`'s constructor, otherwise prompt hooks default to `allow` with a `warn`-level log.
- `getCodemiePath('logs')` (`src/utils/paths.ts`) — resolves `~/.codemie/logs` for both the main logger and (independently) `src/mcp/proxy-logger.ts`.

### Patterns and Conventions

- **Fail-open hook execution**: every hook execution error is caught and converted to `{decision: 'allow', ...}` rather than propagated — by design, but combined with console-invisible `logger.error`, this is the likely reason hook errors are described as unclear ("throw errors but it's unclear what's happening" — they don't actually surface to the user's terminal by default).
- **Debug-gated console output**: `logger.debug()` and the console half of `logger.error()` only print when `CODEMIE_DEBUG` is truthy; `logger.info()`/`logger.warn()` never print to console at all in the current implementation.
- **Structured error context** exists (`createErrorContext`/`formatErrorForLog` in `src/utils/errors.ts`) and is used by `SessionStore`, but not consistently by the hooks execution path (`executor.ts`, `hook.ts`).
- **Sanitization before logging**: `sanitizeLogArgs()`/`sanitizeValue()` (`src/utils/security.ts`) are applied before hook input/output is logged or written to the file log.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — Plugin-based 5-layer architecture (CLI → Registry → Plugin → Core → Utils), directory structure, layer responsibilities. Confirms `src/utils/logger.ts` and `src/utils/errors.ts` as the canonical Utils-layer logging/error primitives.
- `.ai-run/guides/development/development-practices.md`, `.ai-run/guides/standards/code-quality.md`, `.ai-run/guides/testing/testing-patterns.md`, `.ai-run/guides/security/security-practices.md`, `.ai-run/guides/integration/external-integrations.md`, `.ai-run/guides/integration/exposed-api.md`, `.ai-run/guides/usage/project-config.md`, `.ai-run/guides/project.md`, `.ai-run/guides/standards/git-workflow.md`, `.ai-run/guides/quality-gates.md` all exist under `.ai-run/guides/` but were not individually opened beyond the architecture guide given the scope of this research pass; none of their filenames indicate a hooks-specific or logging-specific guide beyond what `architecture.md` and `development-practices.md`/`security-practices.md` (per the AGENTS.md Guide Map) already cover generically (error handling/logging patterns; credential sanitization).

### Architectural Decisions

No ADRs or dedicated hooks-logging design doc were found via codegraph exploration. The fail-open behavior and debug-gated console visibility are established through inline code comments in `executor.ts` and `logger.ts` (e.g. "Fail open (allow execution to continue)") rather than a separate decision record.

### Derived Conventions

- Hook errors are intentionally non-fatal to the agent session (fail-open), inferred from the `executeSingleHook` catch block and consistent `decision: 'allow'` fallback across `executeCommandHook`/`executePromptHook`/unknown-type branches.
- Console output is treated as a debug-mode-only surface; the file log (`~/.codemie/logs/debug-YYYY-MM-DD.log`) is the only channel that unconditionally captures everything, inferred from `logger.ts`'s `debug()`/`info()`/`warn()`/`error()` implementations.

---

## 4. Testing Landscape

### Existing Coverage

- No test files were found for `src/hooks/executor.ts`, `src/hooks/prompt-executor.ts`, `src/hooks/decision.ts`, `src/hooks/matcher.ts`, `src/cli/commands/hook.ts`, `src/plugins/loaders/hooks-loader.ts`, or `src/agents/plugins/claude/claude.session.ts` — codegraph's blast-radius results flagged all of these with "no covering tests found."
- `src/utils/logger.ts`'s `logger` singleton is referenced by 228 callers across the codebase and indirectly exercised inside many other test files (e.g. `src/cli/commands/assistants/chat/__tests__/claudeUploadsDetector.test.ts`, `src/providers/plugins/sso/proxy/plugins/__tests__/claude-request-normalizer.plugin.test.ts`, `src/providers/plugins/sso/proxy/plugins/__tests__/endpoint-blocker.plugin.test.ts`), but no dedicated `logger.test.ts` was surfaced — these are consumers mocking/using the logger, not tests of the `Logger` class's own file-write/rotation/debug-gating behavior.
- `src/providers/plugins/sso/session/utils/__tests__/jsonl-utilities.test.ts` covers the generic `readJSONL`/`writeJSONLAtomic` utilities that `claude.session.ts` depends on for transcript parsing, but not the Claude-specific adapter logic itself.

### Testing Framework and Patterns

Per `AGENTS.md`/Guide Map, Vitest is the project's test framework (`.ai-run/guides/testing/testing-patterns.md`); observed test files use `describe`/`it`/`expect`/`beforeEach`/`afterEach` from `vitest` with temp-directory fixtures (`mkdtemp`/`tmpdir`) for filesystem-touching code, matching the pattern in `jsonl-utilities.test.ts`.

### Coverage Gaps

- `HookExecutor` (dedup, parallel execution, fail-open error path, timeout handling) — no tests.
- `hook.ts` (`validateHookEvent`, `initializeHookContext`, `applyHookTransformation`, `createHookCommand`'s top-level error handling and exit-code behavior) — no tests.
- `hooks-loader.ts` (`loadPluginHooks`, `mergeHooks`, malformed-JSON fallback path) — no tests.
- `ClaudeSessionAdapter` (`discoverSessions`, session parsing) — no tests.
- `Logger` class itself (file rotation, cleanup-old-logs, debug-mode gating, sanitization-before-write) — no dedicated unit tests found.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_DEBUG` (`'true'`/`'1'`) — gates console output for `logger.debug()`/`logger.error()`'s console half; also gates `src/mcp/proxy-logger.ts`.
- `MCP_PROXY_DEBUG` — additional gate for the separate MCP proxy log file.
- `CODEMIE_AGENT` — read by `initializeHookContext()` in CLI mode to set the logger's agent-name context when no explicit config object is passed.
- `CODEMIE_SESSION_ID`, `CODEMIE_PROJECT_DIR`, `CODEMIE_HOOK_EVENT`, `CODEMIE_TOOL_NAME`, `CODEMIE_AGENT_NAME`, `CODEMIE_PROFILE_NAME`, `CODEMIE_TRANSCRIPT_PATH`, `CODEMIE_PERMISSION_MODE`, `CODEMIE_HOOK_INPUT` — environment variables `HookExecutor.buildEnvironment()`/`executeCommandHook()` inject into command-hook child processes.

### Configuration Files

- `~/.codemie/logs/debug-YYYY-MM-DD.log` — the main daily debug/info/warn/error log file (5-day retention, auto-rotated at midnight).
- `~/.codemie/mcp-proxy.log` — separate MCP proxy log file, independent retention/rotation (none observed — no cleanup logic found in `proxy-logger.ts`).
- `~/.codemie/sessions/{sessionId}.json` (and `completed_{sessionId}.json`) — per-session state written by `SessionStore`.
- Plugin `hooks/hooks.json` (or inline manifest `hooks` field) — per-plugin hook definitions consumed by `hooks-loader.ts`.

### Feature Flags and Deployment Concerns

No feature-flag mechanism specific to hooks or logging was found via codegraph exploration; behavior is controlled entirely through the environment variables listed above.

---

## 6. Risk Indicators

- **Silent hook failures**: `HookExecutor.executeSingleHook` swallows all hook errors and downgrades them to `decision: 'allow'`; the corresponding `logger.error()` call only reaches the console when `CODEMIE_DEBUG` is set, so by default a user sees no indication a hook failed at all — directly matching the ticket's "unclear what's happening" symptom. Speculative: any fix that wants failures visible without full debug mode will need to either add a dedicated non-debug-gated warning surface or change what `logger.error()`/`logger.warn()` prints to console by default — this is a design decision for spec/plan, not something this research asserts is required.
- **Malformed plugin hooks.json is nearly invisible**: `loadPluginHooks` only logs JSON-parse failures at `debug` level and silently continues to the next path/returns `null` — a broken plugin hooks file produces no hooks with no non-debug trace.
- **Zero test coverage on the entire hooks path**: `executor.ts`, `hook.ts`, `hooks-loader.ts`, `prompt-executor.ts`, `matcher.ts`, `decision.ts`, and `ClaudeSessionAdapter` all show "no covering tests found" per codegraph's blast-radius analysis — any fix here ships without a regression safety net unless tests are added.
- **Two independent, unsynchronized log files**: the main `logger` (`~/.codemie/logs/debug-*.log`) and `src/mcp/proxy-logger.ts` (`~/.codemie/mcp-proxy.log`) are separate implementations with separate env-var gates (`CODEMIE_DEBUG` vs. `CODEMIE_DEBUG`/`MCP_PROXY_DEBUG`) and no shared rotation/retention logic — investigating "recent sessions and logs" end-to-end may require correlating across both files plus `~/.codemie/sessions/*.json`.
- **Inconsistent error-context richness**: `SessionStore` uses the structured `createErrorContext`/`formatErrorForLog` helpers from `src/utils/errors.ts`; `HookExecutor` and `hook.ts` use raw `error.message`/`error.stack` string interpolation instead — a "revisit the logging approach" effort will find two different error-formatting conventions already in use in adjacent code.
- **`hook.ts` is large (~1550 lines)** and mixes CLI parsing, validation, transformation, routing, and top-level error handling in one file — any logging-format change touching this file has a correspondingly large blast surface to review manually given the lack of tests.
- **Runtime log/session files live outside the repository** (`~/.codemie/logs/`, `~/.codemie/sessions/`) and were not inspected as part of this repo-scoped research pass — actual root-cause diagnosis of "hooks sometimes throw errors" requires reading a specific user's/session's log and session files, which the calling task did not supply a path for.

---

## 7. Summary for Complexity Assessment

This task touches four architectural layers: the CLI layer (`src/cli/commands/hook.ts`, the ~1550-line `codemie hook` entry point every agent hook script invokes), the hook-engine core (`src/hooks/executor.ts`, `prompt-executor.ts`, `decision.ts`, `matcher.ts`), the plugin layer (`src/plugins/loaders/hooks-loader.ts` for plugin-supplied hooks, plus `src/agents/plugins/claude/*` for Claude-specific session parsing and hook transformation lookup), and the utils layer (`src/utils/logger.ts`'s `Logger` singleton, `src/utils/errors.ts`'s `CodeMieError` hierarchy, and the entirely separate `src/mcp/proxy-logger.ts`). The root-cause half of the task ("Claude hooks sometimes throw errors but it's unclear what's happening") is explained by a clear, concrete mechanism already visible in the code: `HookExecutor` fails open on every hook error and only surfaces it via `logger.error()`, whose console half is gated behind `CODEMIE_DEBUG` — so failures are recorded to `~/.codemie/logs/debug-*.log` but invisible in a normal terminal session. A parallel, smaller gap exists in plugin hooks loading, where a malformed `hooks.json` is swallowed at `debug` level.

Technical novelty is low — this is an established, working subsystem with clear, single-responsibility functions (`executeSingleHook`, `writeToLogFile`, `loadPluginHooks`) rather than unfamiliar domain logic; the fail-open pattern and debug-gated console output are consistent, intentional design choices documented via inline comments rather than an ADR. The main complexity driver is breadth, not depth: touching the logging approach credibly means coordinated changes across `logger.ts`, `executor.ts`, `hook.ts`, and possibly `hooks-loader.ts` and `proxy-logger.ts`, several of which are large or high-fan-in (`logger` has 228 callers).

Test-coverage posture is the standout risk: codegraph found zero existing tests for `HookExecutor`, `hook.ts`, `hooks-loader.ts`, `prompt-executor.ts`, `matcher.ts`, `decision.ts`, and `ClaudeSessionAdapter` — any fix in this area ships without a regression safety net absent new tests. Key risk factors for planning: (1) the two independent log files (main logger vs. MCP proxy logger) with different env-var gates and no shared rotation, which any "revisit logging" work must reconcile or explicitly scope around; (2) the inconsistent use of structured error context (`createErrorContext`) between `SessionStore` and the hooks path; (3) the large, untested `hook.ts` file as the central blast-radius point for any error-handling/logging-format change; and (4) actual root-cause confirmation requires reading real `~/.codemie/logs/` and `~/.codemie/sessions/` files from an affected environment, which this repo-scoped research pass did not have a path for and could not inspect.
