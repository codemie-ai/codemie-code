# EPMCDME-17164 Plan: heal stale OTLP hook paths on every launch

**Goal:** On each launch via `defaultAgentHooks['*'].beforeRun`, repair stale CodeMie CLI paths in `claude-code-otlp` hook entries of `~/.claude/settings.json`.

Commit per task using the repository's existing convention. Tests are in scope because the ticket requires them (criterion 5).

## Acceptance criteria

Not repeated here: the ticket criteria 1-5 are the acceptance record, carried in the requirements.

## Assumptions

- (a) Heal runs from `defaultAgentHooks['*'].beforeRun`. It is non-fatal (try/catch, `logger.debug`) and never blocks launch. A missing file or invalid JSON is a no-op. It runs for every agent, before the early returns, because the OTLP hooks belong to Claude Code's shared settings and not to the launched agent.
- (b) The new function sits next to `localizeCodemieHookCommands` and reuses it and `writeAtomically`. Migration 011 stays untouched: its result semantics (`reason`, `success:false` to retry) differ, so sharing is not trivially safe.
- (c) Known limit: providers that do not spread `defaultAgentHooks` (bedrock, ollama, subscription, litellm) are not healed.
- (d) Cheap when nothing is stale: one small file read. `resolveHookCommand` keeps valid paths, so nothing is written.

## Task 1 — healClaudeSettingsHooks in the connector

**Files:** `src/cli/commands/proxy/connectors/claude-code-otlp.ts` (after `localizeCodemieHookCommands`, ~line 337); test in `src/migrations/__tests__/011-localize-otlp-hook-commands.migration.test.ts` as the model (temp HOME via mocked `os.homedir`, mocked `resolveCodemieBinary`), in a new file `src/cli/commands/proxy/connectors/__tests__/claude-code-otlp-heal.test.ts`.

Test-first: yes — with a seeded settings.json whose `hook --agent claude-code-otlp` command points at a nonexistent absolute path, `healClaudeSettingsHooks()` fails because the function does not exist and (once added) must return true and rewrite to the mocked current binary.

New symbol:

```ts
export async function healClaudeSettingsHooks(): Promise<boolean> {
  const file = getClaudeSettingsPath();
  let settings: { hooks?: Record<string, unknown> };
  try {
    settings = JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    return false; // missing or invalid JSON: leave the file alone
  }
  if (!settings?.hooks || !(await localizeCodemieHookCommands(settings.hooks))) return false;
  await writeAtomically(file, JSON.stringify(settings, null, 2) + '\n');
  return true;
}
```

Use the file's existing imports for `getClaudeSettingsPath`, `writeAtomically` and the fs read helper. Add them only if missing, with `.js` extensions.

Tests (Vitest, `vi.resetModules` + `vi.doMock` + dynamic import, per `.ai-run/guides/testing/testing-patterns.md`):
1. A removed executable (nonexistent absolute path) is rewritten to the current binary and returns true.
2. An already-valid path (use an existing file such as `process.execPath` in the command) returns false and the file's mtime/content are unchanged (no write).
3. A user hook in the same group and unrelated settings keys (e.g. `model`) are byte-preserved.
4. A missing file and invalid JSON both return false without throwing, and the invalid file is not modified.

## Task 2 — call it from defaultAgentHooks beforeRun

**Files:** `src/providers/core/default-agent-hooks.ts:20-22`; test in `src/providers/core/__tests__/providers-core.test.ts` (near line 298).

Test-first: yes — with `healClaudeSettingsHooks` mocked via `vi.doMock` of the connector module, running `defaultAgentHooks['*'].beforeRun(env, config)` must call it once. Currently it is not called, so the test fails.

At the top of `beforeRun`, before `if (!agentName) return env;`, add a try/catch block. It lazily imports the connector (`await import('@/cli/commands/proxy/connectors/claude-code-otlp.js')`) and the logger, awaits `healClaudeSettingsHooks()`, and on a throw calls `logger.debug` with the message only. The lazy import avoids the provider-to-connector cycle and the startup cost, as migration 011 does.

Second test: when `healClaudeSettingsHooks` rejects, `beforeRun` still resolves with env and the extension install path still runs.

## Self-check

- Coverage: criterion 1 and 2 map to Task 2 plus Task 1 test 1. Criterion 3 maps to Task 1 test 3. Criterion 4 maps to Task 1 test 2 and the atomic write. Criterion 5 maps to the Task 1 tests.
- negative-constraints: none stated beyond "other users' hooks and unrelated settings unchanged" (criterion 3, honored by Task 1: the marker-scoped `localizeCodemieHookCommands` plus test 3) and "do not rewrite a valid config" (Task 1 test 2).
