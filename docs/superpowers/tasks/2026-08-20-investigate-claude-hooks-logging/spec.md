# Spec: Test-log isolation + visible hook-failure warnings

## Problem

Confirmed via direct inspection of a real `~/.codemie/logs/debug-*.log` (2026-08-17 → 2026-08-20),
cross-referenced with the test suite:

1. **Test-log pollution.** `Logger.writeToLogFile` (`src/utils/logger.ts:167-216`) always writes
   INFO/WARN/ERROR entries to the real `~/.codemie/logs/debug-<date>.log` via
   `getCodemiePath('logs')` (`src/utils/paths.ts:356-376`), which only honors a `CODEMIE_HOME`
   override if `process.env.CODEMIE_HOME` is already set. `vitest.config.ts`'s three `defineProject`
   blocks (`unit`, `cli`, `agent`) set `NODE_ENV: 'test'` but never `CODEMIE_HOME`, so every test
   run writes real `[ERROR]`-formatted fixture strings into the developer's production log,
   indistinguishable from genuine hook failures.
2. **Invisible real failures.** `HookExecutor.executeSingleHook` fails open on every hook error and
   reports it only via `logger.error()` (`src/utils/logger.ts:314-344`), whose console half is
   gated behind `isDebugMode()`. `info()`/`warn()` never print to console at all. A genuine hook
   failure is therefore recorded to the file log but silent in a normal terminal.
3. **Invisible config errors.** `loadPluginHooks`'s JSON-parse failure path
   (`src/plugins/loaders/hooks-loader.ts`) logs at `debug` only, so a broken plugin `hooks.json`
   produces zero visible signal even in the file log at default settings.

## Design

### A. Test log isolation

Set `CODEMIE_HOME` in each of the three `vitest.config.ts` project `env` blocks
(`unit`/`cli`/`agent`, currently `vitest.config.ts:23-26`, `:58-61`, `:80-83`) to a directory under
the OS temp dir, computed once at config-eval time and shared by all three projects for a given
`vitest` invocation. This relies on `getCodemieHome()`/`getCodemiePath()` reading
`process.env.CODEMIE_HOME` at call time (`src/utils/paths.ts:356-361`) and `Logger` resolving its
log directory lazily on first write (`initializeLogFile()`, `src/utils/logger.ts:67-95`), not at
module import — so a config-level env var is sufficient without touching `logger.ts`.

Existing per-test overrides that already `mkdtemp` and set/restore `process.env.CODEMIE_HOME`
directly (e.g. `codex.reconciliation.test.ts:13-51`) are unaffected — they narrow isolation further
per test file and continue to work unmodified.

### B. Visible hook-failure warnings

Add one new `Logger` method — a "notice" level that behaves like `error()`/`warn()` for the file
log (always written, same `[LEVEL] [agent] [session]` format so it stays greppable and blends with
existing entries) but, unlike `error()`, **always** prints to console regardless of
`isDebugMode()`, using a distinct symbol/color (`⚠`, yellow) so it reads apart from `success()`'s
`✓` and `error()`'s debug-gated `✗`. The printed line stays short (hook identifier + one-line
reason) and points to `getLogFilePath()` for full detail; it does not dump stack traces to the
console.

Wire this new method into exactly two call sites, replacing their current `logger.error`/`logger.debug`
calls:

- `HookExecutor.executeSingleHook`'s catch block (`src/hooks/executor.ts`), on every hook execution
  failure — the fail-open `decision: 'allow'` behavior itself is unchanged, only the reporting.
- `loadPluginHooks`'s JSON-parse-failure branch (`src/plugins/loaders/hooks-loader.ts`), replacing
  the current `debug`-level call.

No other call sites of `logger.error`/`logger.warn`/`logger.debug` change. This keeps the fix
scoped to the two places the task names as symptomatic, rather than changing console-visibility
policy for the other ~228 callers of the logger.

## Acceptance Criteria

- Running the test suite (any of the three vitest projects) writes zero new lines to the real
  `~/.codemie/logs/debug-*.log`; all logger file output during tests lands under an isolated
  `CODEMIE_HOME`.
- Existing per-test `CODEMIE_HOME` overrides (e.g. `codex.reconciliation.test.ts`) still pass
  unmodified.
- A `HookExecutor` command/prompt hook that throws prints a `⚠`-prefixed, one-line warning to the
  terminal on a normal run (`CODEMIE_DEBUG` unset), in addition to the full detail still landing in
  the debug log file.
- A malformed plugin `hooks.json` produces the same visible `⚠` warning instead of a debug-only,
  invisible-by-default log line.
- `HookExecutor`'s fail-open decision (`allow`) and `AggregatedHookResult` shape are unchanged.
- New characterization/regression tests cover: `HookExecutor` failure → file log + console notice;
  `loadPluginHooks` malformed JSON → console notice; a smoke test proving logger file writes honor
  a `CODEMIE_HOME` override during a representative test run.
- Zero lint/typecheck/build regressions; no new `any`, no bypassed sanitization
  (`sanitizeLogArgs` still applied to file-logged args).

## Non-goals

- Changing hook fail-open semantics or `AggregatedHookResult`/`HookResult` shapes.
- Unifying `src/mcp/proxy-logger.ts` with the main `Logger`, or touching MCP proxy logging/env
  gates (`CODEMIE_DEBUG`/`MCP_PROXY_DEBUG`).
- Adopting `createErrorContext`/`formatErrorForLog` structured error formatting in the hooks path —
  a separate, pre-existing inconsistency this task does not resolve.
- Changing console-visibility behavior for `logger.info()`/`logger.warn()`/`logger.debug()` or any
  caller outside the two named hook call sites.
- Refactoring `hook.ts`'s size/structure, `HookExecutor`'s dedup/parallel-execution logic, or
  `HookMatcher`/`DecisionParser`.
- Adding a new log-verbosity configuration surface beyond the existing `CODEMIE_DEBUG` switch.
- Correlating hook errors against `~/.codemie/sessions/*.json` session files.

## Open Risks

- The new always-visible `⚠` notice could be noisy in setups with expected/benign hook failures;
  accepted as in-scope per the task's explicit ask for real failures to be visible by default.
- `getCodemieHome()`/`getCodemiePath()` are read at call time in the processes observed
  (`logger.ts`, `paths.ts`), but this has not been exhaustively verified across every consumer of
  `CODEMIE_HOME` (e.g. `SessionStore`, migrations) — implementation should confirm no other module
  caches a home-derived path at import time in a way that would leak into a test's real home before
  `CODEMIE_HOME` is applied.
