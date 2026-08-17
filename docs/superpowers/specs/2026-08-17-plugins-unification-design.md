# Plugins Unification — Design Spec

**Date:** 2026-08-17  
**Scope:** `src/agents/plugins/` — Claude, Codex, Gemini, Kimi, OpenCode plugins

---

## Problem

The five agent plugins share structural and behavioural patterns that were copy-pasted rather than shared. This means:
- Bugs fixed in one plugin stay broken in others.
- Adding a sixth plugin (e.g. Cursor, Windsurf) requires knowing which boilerplate to copy and which to omit.
- There is no single place to learn the rules.

---

## Goals

1. Eliminate the four most impactful duplications (see below).
2. Introduce a `PLUGIN_GUIDE.md` that makes the contract explicit for future plugin authors.

Non-goals: unifying agent-specific session parsing logic (tool formats differ too much), or touching the providers layer.

---

## Unification 1 — Extract `getExplicitModelArg()` utility

**Affected files:** `codex/codex.plugin.ts:429`, `kimi/kimi.plugin.ts:384`

Both files define an identical module-private function that scans CLI args for `-m`/`--model`/`--model=<val>`.

**Design:**
- Create `src/agents/core/utils/args.ts` exporting `getExplicitModelArg(args: string[]): string | undefined`.
- Delete the two private copies; import from the shared utility.
- No behaviour change.

---

## Unification 2 — Abstract `BaseSessionAdapter` class

**Affected files:** all five `*.session.ts` / `*session-adapter.ts` files

`BaseSessionAdapter` is currently only an interface. All five adapters independently declare:
```ts
private processors: SessionProcessor[] = [];
private initializeProcessors(): void { ... }
registerProcessor(processor: SessionProcessor): void {
  this.processors.push(processor);
  this.processors.sort((a, b) => a.priority - b.priority);
}
```

**Design:**
- Convert `BaseSessionAdapter` to an abstract class (keep the interface type for external consumers via a re-export or type alias).
- The abstract class owns `processors`, `registerProcessor()`, and the sort.
- Declare `protected abstract initializeProcessors(): void` — each adapter overrides to register its own processors.
- All five adapters extend the class instead of implementing the interface.

**Estimated reduction:** ~15 lines × 5 adapters = 75 lines eliminated.

---

## Unification 3 — Centralise semver parsing in `BaseAgentAdapter.getVersion()`

**Affected files:** Claude (`:319`), Gemini (`:224`), Kimi (`:292`), Codex (`:497`), OpenCode (bug: returns raw stdout)

All four overriding plugins extract a semver from stdout using `/(\d+\.\d+\.\d+)/`. The base currently returns raw stdout. OpenCode does not override and silently returns raw stdout — a latent compatibility bug.

**Design:**
- Add an optional `dataPaths.binary` field to `AgentMetadata` (Kimi already has it; Claude will add `'.local/bin/claude'`).
- Update `BaseAgentAdapter.getVersion()` to:
  1. On non-win32, if `metadata.dataPaths.binary` is set, try `resolveHomeDir(dataPaths.binary)` first.
  2. Fall back to `exec(cliCommand)`.
  3. Extract semver via `/(\d+\.\d+\.\d+)/` from stdout; return raw string if no match.
- Remove the four plugin overrides (Claude, Gemini, Kimi, Codex).
- OpenCode gains correct semver parsing for free.

---

## Unification 4 — Centralise native binary `isInstalled()` in base

**Affected files:** `claude/claude.plugin.ts:382`, `kimi/kimi.plugin.ts:139`

Both follow the same pattern: on non-win32, try the native binary full path first; fall back to `commandExists(cliCommand)`.

**Design:**
- Reuse `dataPaths.binary` from Unification 3 (Claude adds it; Kimi already has it).
- Update `BaseAgentAdapter.isInstalled()` to check `resolveHomeDir(dataPaths.binary)` before PATH lookup.
- Remove both plugin overrides.

---

## Addition — `PLUGIN_GUIDE.md`

**Location:** `src/agents/plugins/PLUGIN_GUIDE.md`

### Checklist for a new plugin

Every new agent plugin requires:
- `<agent>.plugin.ts` — metadata object + class extending `BaseAgentAdapter`
- `<agent>.session.ts` — class extending `BaseSessionAdapter`
- `session/processors/<agent>.metrics-processor.ts`
- `session/processors/<agent>.conversations-processor.ts`
- `__tests__/` with at least: plugin lifecycle smoke test, enrichArgs unit test, metrics processor fixture test

### What the base handles (do not override)

| Behaviour | Mechanism |
|---|---|
| npm install / uninstall | `BaseAgentAdapter.install()` / `uninstall()` |
| Version compatibility check | `BaseAgentAdapter.checkVersionCompatibility()` |
| Native binary path check (`isInstalled`) | Set `dataPaths.binary` in metadata |
| Semver parsing (`getVersion`) | Set `dataPaths.binary` in metadata |
| Processor registration and priority sort | Extend `BaseSessionAdapter` |

### When you MUST override

- **Native installer** — override `install()` / `installVersion()` if the agent uses a shell script installer rather than npm (e.g. Claude, Kimi).
- **Custom arg enrichment** — override `lifecycle.enrichArgs` for any arg transformation beyond flag mapping.
- **Hook transformer** — implement `getHookTransformer()` if the agent emits non-standard hook event names (e.g. Gemini's `AfterAgent` → `Stop`).

### Metadata required fields

```ts
{
  name,           // snake_case, used as CLI selector
  displayName,    // human-readable
  description,
  cliCommand,     // binary name
  supportedVersion,
  minimumSupportedVersion,  // rule: 10 patch/minor versions below supportedVersion
  dataPaths: { home },      // e.g. '.claude'
  envMapping: { baseUrl, apiKey, model },
  supportedProviders,
  ssoConfig,
  extensionsConfig: { project, global, skillsEntryFile },
}
```

### Async rules

- **Dynamic imports in lifecycle hooks are intentional.** `await import(...)` inside `beforeRun` / `onSessionEnd` avoids circular dependencies at module load time. Do not hoist to top-level imports.
- **Fire-and-forget pattern:** use `void promise.catch(err => logger.debug(...))` for non-blocking side effects (e.g. stale session reconciliation). Never leave a bare `void` with no `.catch()`.
- **`isInstalled()` must be side-effect free.** No stdout writes, no mutations, no logging to the console. Logging to `logger.debug` (file-only) is acceptable.
- **`onSessionEnd` failures must never throw.** Metrics or sync failure must be caught and swallowed — an uncaught error here blocks agent exit.

### Testing rules

- **Unit-test `enrichArgs` and version parsing** — these are pure transformations; test without any I/O or mocks.
- **Use fixture JSONL/JSON files for processor tests** — place fixtures in `__tests__/fixtures/`, named for the scenario (`history-multi-clear.jsonl`, not `fixture-2026-05.jsonl`).
- **Mock the filesystem, not the adapter** — pass a fixture file path to the processor; don't mock the session adapter itself.
- **Don't test lifecycle hooks with real subprocesses** — inject env vars and spy on `processEvent`; no end-to-end agent invocations in unit tests.
- **One fixture per edge case** — each fixture covers exactly one scenario (empty session, multi-turn, error recovery, etc.).

---

## Summary of files changed

| File | Change |
|---|---|
| `src/agents/core/utils/args.ts` | **new** — `getExplicitModelArg()` |
| `src/agents/core/session/BaseSessionAdapter.ts` | interface → abstract class |
| `src/agents/core/BaseAgentAdapter.ts` | update `getVersion()`, `isInstalled()` |
| `src/agents/core/types.ts` | add optional `dataPaths.binary` |
| `claude/claude.plugin.ts` | add `dataPaths.binary`, remove `getVersion()` + `isInstalled()` overrides |
| `codex/codex.plugin.ts` | remove `getExplicitModelArg()`, remove `getVersion()` override |
| `gemini/gemini.plugin.ts` | remove `getVersion()` override |
| `kimi/kimi.plugin.ts` | remove `getExplicitModelArg()`, `getVersion()`, `isInstalled()` overrides |
| `opencode/opencode.plugin.ts` | no change needed (gains fix for free) |
| All five `*.session.ts` | extend `BaseSessionAdapter` class, remove processor boilerplate |
| `src/agents/plugins/PLUGIN_GUIDE.md` | **new** |
