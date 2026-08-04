# Spec: `--print-config` for codemie-opencode

**Date**: 2026-07-31
**Slug**: opencode-print-config
**Branch**: feat/opencode-print-config

## Problem

`codemie-opencode` generates an opencode config on the fly (provider map, model routing, plugins) and injects it into the opencode process via `env.OPENCODE_CONFIG_CONTENT` (or a temp file for large configs) before spawning `opencode`. There is no way to see that generated config without actually starting opencode, which makes debugging config generation (wrong provider, wrong model routing, missing headers) harder than it needs to be.

## Goal

Add a `--print-config` flag to `codemie-opencode` that prints the actual generated config to the console (redacted for secrets) and exits without starting opencode.

## Scope

- **In scope**: `codemie-opencode` only.
- **Out of scope**: `--print-config` for other agent CLIs (claude, codex, gemini, kimi). The flag is declared once in the shared `AgentCLI.ts` (there is no per-agent CLI file), but is only functional for the opencode adapter; for any other agent it prints a "not supported for this agent" error and exits 1.

## Design

### Mechanism

`beforeRun()` in `src/agents/plugins/opencode/opencode.plugin.ts` already writes the exact generated config JSON into `env.OPENCODE_CONFIG_CONTENT` (primary channel) or a temp file referenced by `env.OPENCODE_CONFIG` (fallback, when JSON exceeds the 32KB `MAX_ENV_SIZE` threshold in `temp-config.ts`). `--print-config` reuses this channel instead of restructuring the plugin:

1. `AgentCLI.setupProgram()` declares `--print-config` (boolean flag, no value) alongside the other shared options.
2. `AgentCLI.handleRun()`: if `options.printConfig` is set and the current agent is not `opencode`, print `--print-config is not supported for <agent>` to stderr and exit 1. For opencode, forward the intent to the adapter (a `dryRun`-style option passed into `adapter.run()`).
3. `BaseAgentAdapter.run()`: executes the normal pipeline up through `executeBeforeRun` unchanged — the real config is built and the real network call (`fetchDynamicModelConfigs` against the CodeMie API) happens, so the printed config matches exactly what a real run would use. Only when the dry-run intent is set:
   - Read `env.OPENCODE_CONFIG_CONTENT` and `JSON.parse` it. If not present, read and parse the file at `env.OPENCODE_CONFIG` instead.
   - If neither is present (the early-return case in `beforeRun` when `CODEMIE_BASE_URL` is missing/malformed), print an error to stderr (`Could not generate opencode config: CODEMIE_BASE_URL is missing or invalid`) and exit 1.
   - Redact the parsed config (see below).
   - Print `JSON.stringify(redacted, null, 2)` to stdout.
   - Return before reaching `spawn()` — spawn, signal handlers, and the `afterRun`/exit-code lifecycle hooks are skipped entirely. Exit 0.
4. `opencode.plugin.ts` is **not modified**. No plugin/lifecycle-hook signature changes.
5. Existing temp-file cleanup (`process.on('exit', ...)` registered in `temp-config.ts`) is unchanged and still removes the fallback temp file when one was created.

### Redaction

Recursively walk the parsed config object. For any key whose name matches `/apikey|token|secret|authorization/i` (case-insensitive), replace its value with the literal string `"***REDACTED***"` regardless of nesting depth — this covers `provider[*].options.apiKey` and any `Authorization`/bearer-token entry inside `provider[*].options.headers`. Key names are left untouched so the shape of the config is still visible.

### Error handling

| Condition | Behavior |
|---|---|
| `--print-config` passed for a non-opencode agent | stderr message, exit 1, no config generation attempted |
| `CODEMIE_BASE_URL` missing/invalid (beforeRun early-returns) | stderr message naming the cause, exit 1 |
| Config generated normally (inline or temp-file channel) | redacted JSON to stdout, exit 0 |

### Non-goals

- Not a general "preview any agent's config" feature.
- Not a persistent/cached config viewer — it always regenerates and prints the live config for the current environment/args, including the real network call.
- Does not change the on-the-wire format opencode itself receives; printing is read-only and additive.

## Testing

Per user request, tests are included for this task (overriding the "tests only on explicit request" default). Coverage to add:

- `AgentCLI`: `--print-config` is parsed; short-circuits before `adapter.run()`'s spawn path for opencode; prints a "not supported" error and exits 1 for a non-opencode agent. Follows the existing fake-adapter pattern (`AgentCLI-resume.test.ts`).
- `BaseAgentAdapter.run()`: with dry-run intent set, `spawn` is never called (reusing the `child_process` mock pattern from `BaseAgentAdapter.test.ts`); config is read from `env.OPENCODE_CONFIG_CONTENT` when present, and from the temp-file path in `env.OPENCODE_CONFIG` when the inline channel isn't populated; redaction masks `apiKey`/`headers.Authorization`-style fields; missing/invalid `CODEMIE_BASE_URL` produces the documented error and exit code 1.
- New integration test under `tests/integration/opencode/` (currently empty) exercising the flag end-to-end against the opencode plugin's real `beforeRun`.

## Files expected to change

- `src/agents/core/AgentCLI.ts` — flag declaration, non-opencode guard, forwarding the intent to `adapter.run()`.
- `src/agents/core/BaseAgentAdapter.ts` — dry-run short-circuit, config extraction, redaction, printing, early return before `spawn()`.
- New/updated test files under `src/agents/core/__tests__/` and `tests/integration/opencode/`.
