# Technical Research

**Task**: hooks installer BaseExtensionInstaller hook-command
**Generated**: 2026-10-09
**Research path**: filesystem

---

## 1. Original Context

# CodeMie CLI: Claude Code hooks keep pointing at a codemie that was removed

## Problem
When `codemie-claude` runs with a CodeMie SSO, JWT or Anthropic subscription profile, the CLI installs its Claude Code plugin into `~/.codemie/claude-plugin`. While installing, it writes the absolute path of the `codemie` it finds at that moment into `~/.codemie/claude-plugin/hooks/hooks.json` (`localizeInstalledHooks` / `resolveCodemieBinary`, EPMCDME-14035).

That path is only rewritten when the plugin version changes. If the user later removes that CLI, the hooks keep pointing at a file that no longer exists. Every Claude Code start then shows: `SessionStart:startup hook error ... /bin/sh: /opt/homebrew/bin/codemie: No such file or directory`. None of CodeMie's hooks run.

## Reproduced
1. Install plugin with `codemie` at path A: action `copied`, hooks point at A.
2. Remove A, put another `codemie` on PATH, install again: action `already_exists`, hooks still point at A.
3. Delete `~/.codemie/claude-plugin` and install again: hooks point at new codemie.

## Expected
When the plugin is already up to date but a `codemie` path written into its hooks no longer exists, the CLI rewrites the hooks to the current `codemie` on next start. A path that still exists is left untouched.

## Acceptance criteria
1. With `hooks.json` pointing at a removed `codemie`, next start rewrites every such command to the current `codemie`, keeping the arguments (`hook`, `sound SessionStart`).
2. A `codemie` path that still exists is not rewritten, and `hooks.json` is not written at all.
3. Commands that do not start with a `codemie` path are never changed.
4. The check runs on every start without a PATH lookup; current `codemie` only resolved when a rewrite is needed.
5. Covers the Windows form, where node.exe and codemie.js are two separately quoted paths before `hook`, and quoted paths with spaces.
6. Works for every agent extension installed through `BaseExtensionInstaller`, not only Claude.
7. Unit tests for both cases (stale rewritten, valid untouched) that fail when the fix is removed.

## Notes / user-provided hints
- Code: `src/utils/hook-command.ts` (`resolveHookCommand`, `rewriteHooksCommandTree`, `isShadowedCodemieShim`, `resolveCodemieBinary`), `src/agents/core/extension/BaseExtensionInstaller.ts` (`install`, `already_exists` branch, `localizeInstalledHooks`).
- resolveCodemieBinary() writes two shapes: `/abs/codemie hook` (quoted when path has spaces) and on Windows `"C:/.../node.exe" "C:/.../codemie.js" hook`. Only touch a command whose leading absolute path is a codemie (or node + codemie*.js pair) and is missing on disk. Bare `codemie`, relative paths, other programs stay.
- Kimi's extension has no hooks/hooks.json: skip quietly when file isn't there, no warning per start.
- Migration 006 and codemie-code.plugin.ts call same helpers.
- Existing test harness: src/agents/core/extension/__tests__/BaseExtensionInstaller.hooks.test.ts (mocked getCommandPath).
- Repo guides under .ai-run/guides/ (architecture, development-practices, testing-patterns) apply. Research only; do not edit code.

---

## 2. Codebase Findings

### Existing Implementations
- `/Users/mert_efe/codemie-installers/codemie-code/src/utils/hook-command.ts` (130 lines)
  - `isShadowedCodemieShim(commandPath)` (L26): strips surrounding quotes, checks raw and `realpathSync` path for `/@codemieai/codemie-opencode/`. Never throws.
  - `resolveCodemieBinary()` (L59): `getCommandPath('codemie')` (spawns `which`/`where.exe`), rejects shadowed shim; else `process.argv[1]`; else bare `codemie`. Output shapes: `/abs/codemie` (via `quoteIfNeeded`, which wraps in `"` only if `NEEDS_QUOTING` matches: space, tab, `,;=()&|<>^%[]{}`) or, on win32 with a `.js/.mjs/.cjs` argv[1], `"<execPath>" "<argv1>"` (both always quoted, forward slashes).
  - `resolveHookCommand(command, binary)` (L84): rewrites bare `codemie` / `codemie ` prefix; otherwise takes first token (quoted-aware: up to closing `"`, else up to first space) and rewrites if it is a shadowed shim. It has no existence check and does not handle the two-token Windows prefix.
  - `rewriteHooksCommandTree(node, binary)` (L102): shape-agnostic recursion, mutates every string `command` field in place, returns changed flag. Calls `resolveHookCommand`.
  - No existing function tests whether a leading absolute path exists on disk (`existsSync`/`access` is not imported in this file; only `realpathSync`).
- `/Users/mert_efe/codemie-installers/codemie-code/src/agents/core/extension/BaseExtensionInstaller.ts` (781 lines)
  - `install()` (L618): determines `action` = `copied` (no `getInstalledInfo`), `updated` (version differs), else `already_exists`. Only for non-`already_exists` does it `rm` target, `cp`, `verifyInstallation`, then `localizeInstalledHooks(targetPath)` (L697). The `already_exists` branch (L698-700) only logs "Skipping copy - extension already up-to-date". This is the gap.
  - `localizeInstalledHooks(targetPath)` (L522): dynamic-imports `resolveCodemieBinary`/`rewriteHooksCommandTree`, reads `<target>/hooks/hooks.json`, calls `resolveCodemieBinary()` unconditionally (PATH lookup), rewrites `parsed.hooks`, writes with `JSON.stringify(parsed, null, 2)` only if changed. All wrapped in try/catch that does `logger.warn("Could not localize hook commands (non-fatal)")`. A missing hooks.json (ENOENT) would therefore warn.
  - `getInstalledInfo()` (L549): default requires target dir, manifest and `hooks/hooks.json` readable.
- Subclasses (all `extends BaseExtensionInstaller`):
  - `src/agents/plugins/claude/claude.plugin-installer.ts` (critical files: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `README.md`; target `~/.codemie/claude-plugin`)
  - `src/agents/plugins/gemini/gemini.extension-installer.ts` (`gemini-extension.json`, `hooks/hooks.json`, `README.md`; target `~/.gemini/extensions/codemie`)
  - `src/agents/plugins/kimi/kimi.extension-installer.ts` (critical files `manifest.json`, `SKILL.md`; overrides `getInstalledInfo` with no hooks check; target `<kimi skills dir>/codemie-kimi`). Kimi has no `hooks/hooks.json`, so a new `already_exists` hook check on Kimi would hit ENOENT on every start; also note the existing copy path already calls `localizeInstalledHooks` for Kimi on `copied`/`updated` and would log the non-fatal warn there today (existing behaviour).
- `/Users/mert_efe/codemie-installers/codemie-code/src/migrations/006-resolve-hook-command-paths.migration.ts`: reads claude-plugin and gemini hooks.json, calls `resolveCodemieBinary` lazily (`binary ??=`), `rewriteHooksCommandTree`, writes if changed; treats ENOENT silently. Pattern to mirror for "skip quietly when file missing". Shares helpers with this task (any change to `resolveHookCommand` semantics affects it).
- `/Users/mert_efe/codemie-installers/codemie-code/src/agents/plugins/codemie-code.plugin.ts` L16, L313: imports `resolveCodemieBinary`, `resolveHookCommand`; `buildDefaultHooks(codemieBinary)` builds injected hooks. Also a consumer of `resolveHookCommand`.

### Architecture and Layers Affected
- Agents layer / core extension (`src/agents/core/extension/BaseExtensionInstaller.ts`): `install()` already_exists branch.
- Utils layer (`src/utils/hook-command.ts`): hook command parsing/rewrite helpers.
- Callers (read-only awareness): `src/providers/core/default-agent-hooks.ts` L34 (`installer.install()` on SSO/JWT env setup), `src/providers/plugins/anthropic-subscription/anthropic-subscription.template.ts` L76, `src/cli/commands/setup.ts` L739, `src/cli/commands/skills/setup/sync-plugin.ts` L25. Every start of codemie-claude goes through `install()`.
- Migrations layer: 006 uses the same helpers.

### Integration Points
- `getCommandPath` in `src/utils/processes.ts` L47 (spawns `which` / `C:\Windows\System32\where.exe` through `exec`) is the PATH lookup acceptance criterion 4 requires be avoided on the check path.
- Node `fs` (`existsSync` already imported in BaseExtensionInstaller from `fs`; `access`/`readFile`/`writeFile` from `fs/promises`).
- Consumers of the written hooks.json: Claude Code plugin loader and Gemini extension loader (external).

### Patterns and Conventions
- Template Method base class with 4 abstract methods; subclass overrides only paths (Kimi additionally overrides `getInstalledInfo`).
- Non-fatal hook handling: try/catch around hook work, `logger.warn`/`logger.debug`, never break install.
- Dynamic `import()` of `hook-command.js` inside the base class (used in tests with `vi.doMock` + `vi.resetModules`).
- Lazy binary resolution in migration 006 (`binary ??=`), after confirming a file exists.
- ES modules, `.js` import extensions, `logger` not `console`, no `any` (AGENTS.md).
- hooks.json is written as `JSON.stringify(parsed, null, 2)`; commands live under `parsed.hooks.<Event>[].hooks[].command`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/` exists: `architecture/architecture.md`, `development/development-practices.md`, `testing/testing-patterns.md`, `standards/code-quality.md`, `quality-gates.md`, `security/security-practices.md`, `integration/external-integrations.md`. The task notes name architecture, development-practices and testing-patterns as applicable. Not exhaustively read here beyond a grep of testing-patterns for Windows (line 154: use `path.join` for expected paths because backslashes on Windows; a regression reached CI twice in PR #418).
- `docs/HOOKS.md` and `docs/HOOKS_TESTING.md` cover the user hooks feature, not the plugin hooks.json localization.

### Architectural Decisions
- EPMCDME-14035 recorded only as inline comments in `hook-command.ts`, `BaseExtensionInstaller.ts` L520-521 and migration 006: absolute, PATH-independent codemie prefix; forward slashes for Git Bash/WSL; reject bundled agent shim `@codemieai/codemie-opencode`.
- No ADR found for the "only rewrite on version change" decision; it is implicit in the `already_exists` branch.

### Derived Conventions
- Hook rewriting must never throw or block launch; failures degrade to warn/debug.
- Quoted-token handling: quote only when `NEEDS_QUOTING`, except Windows pair which is always quoted.

---

## 4. Testing Landscape

### Existing Coverage
- `src/agents/core/extension/__tests__/BaseExtensionInstaller.hooks.test.ts`: single test, `TestInstaller` subclass over temp src/home dirs (`mkdtemp`), `vi.resetModules()` and `vi.doMock('../../../../utils/processes.js', ...)` giving `getCommandPath` -> `/abs/codemie`; asserts first install rewrites bare `codemie` commands. No `already_exists` test.
- `src/utils/__tests__/hook-command.test.ts`: tests for `resolveHookCommand` (bare, non-codemie, already-absolute unchanged: `/usr/local/bin/codemie hook` passes through), `resolveCodemieBinary` (PATH, argv fallback, win32 via platform stubbing, quoting), `rewriteHooksCommandTree` (rewrites / returns false).
- `src/migrations/__tests__/006-resolve-hook-command-paths.migration.test.ts`: migration coverage.

### Testing Framework and Patterns
- Vitest ^4.1.5; projects `unit`, `cli`, `agent` (`npm test`); `@group unit` header; `vi.resetModules()` + `vi.doMock` + dynamic import; real temp dirs for filesystem. Windows behaviour tested by stubbing `process.platform`. Tests only on explicit request per AGENTS.md; this task's acceptance criterion 7 explicitly requests them.

### Coverage Gaps
- No test of `already_exists` + hooks.json behaviour in the installer.
- No test for stale (missing-on-disk) absolute codemie path, quoted-with-spaces path, or Windows node+codemie.js pair in `resolveHookCommand`.
- No test that an unchanged file is not written (no write spy/mtime check exists today).
- No test for Kimi (no hooks.json) quiet skip; no installer test for Gemini/Kimi at all.

---

## 5. Configuration and Environment

### Environment Variables
- None specific to this area. `CODEMIE_<AGENT>_EXTENSION_DIR` is set from `result.targetPath` in `default-agent-hooks.ts`. `CODEMIE_DEBUG=true` for debug logs.

### Configuration Files
- Installed state: `~/.codemie/claude-plugin/hooks/hooks.json` (via `getCodemiePath`), `~/.gemini/extensions/codemie/hooks/hooks.json`. Source templates are bundled per plugin dir (`plugin/`, `extension/`). `<agent>.extension.json` version file is for local copy only.
- `package.json` scripts: `test`, `lint` (zero-warning), `build`, `ci`.

### Feature Flags and Deployment Concerns
- No flags. Migrations registry (`src/migrations/index.ts`) exists but is run-once; it cannot fix this recurring condition.
- Platform: macOS/Linux and Windows path forms both generated; Git Bash style forward slashes in hooks.json.

---

## 6. Risk Indicators

- `resolveHookCommand` is shared by migration 006 and `codemie-code.plugin.ts` (via `buildDefaultHooks`/hook merging); changing its semantics (e.g. adding existence checks) can alter their behaviour. Speculative: a separate stale-detection function avoids this coupling.
- Existing test asserts `/usr/local/bin/codemie hook` is left unchanged by `resolveHookCommand` with a fabricated, non-existent path; that is exactly the stale shape. Speculative: that test must stay valid or be consciously changed if the existing function is modified.
- Parsing the Windows two-token prefix (`"node.exe" "codemie.js" hook`) and quoted paths with spaces needs care: the current first-token logic only handles one token; node.exe + `codemie*.js` pairing must not rewrite other node commands (criterion 3).
- Detecting "a codemie path" by basename (`codemie`, `codemie.cmd`, `codemie.js`?) with no PATH lookup must avoid touching other programs, relative paths and bare `codemie`; Windows drive paths (`C:/...`) must be recognised as absolute on POSIX test runners.
- Kimi (no `hooks/hooks.json`): `localizeInstalledHooks` currently warns on ENOENT (logger.warn); running a check every start would produce a warning per start unless ENOENT is handled quietly. Existing warn on Kimi's copy path is pre-existing.
- `getCommandPath` mock in the existing harness hides the PATH lookup; criterion 4 requires proving it is not called when nothing is stale (needs a spy assertion).
- Write-avoidance (criterion 2): current code only writes if the tree changed, so keep that; a test needs a way to prove no write (mtime/content spy).
- Dev-checkout case: `resolveCodemieBinary` can return bare `codemie` or argv[1]; rewriting stale paths to bare `codemie` would reintroduce the EPMCDME-14035 PATH problem but is the existing fallback.
- Concurrency: several processes starting simultaneously may rewrite hooks.json at once (non-atomic `writeFile`); same as existing behaviour.
- Cross-platform CI: tests with Windows paths must not depend on host `path` semantics (testing-patterns.md L154).
- Scope: 3 installers (claude, gemini, kimi), 2 source files, 2 test files plus likely a new test case in hook-command tests.

---

## 7. Summary for Complexity Assessment

The change sits in two files: `src/agents/core/extension/BaseExtensionInstaller.ts` (the `already_exists` branch of `install()` and/or `localizeInstalledHooks`) and `src/utils/hook-command.ts` (hook command parsing and rewrite helpers). It touches the agents-core and utils layers only; no DB, API, config or migration. Callers (`default-agent-hooks.ts`, anthropic-subscription template, setup, sync-plugin) reach it through `install()` and need no change. Migration 006 and `codemie-code.plugin.ts` share the same helpers, which is the main coupling concern. The inheriting installers (Claude, Gemini, Kimi) benefit automatically from a base-class change, with Kimi needing a quiet skip for the missing hooks.json.

Technical novelty is low-to-moderate: the architecture and tests already exist, but the command parsing is subtle (quoted tokens, spaces, Windows two-path form, absolute vs bare vs relative, cross-platform path recognition when run on POSIX CI). Test posture: a working harness exists (temp dirs, `vi.doMock` on processes), but there is no coverage of the `already_exists` branch, stale-path detection, write avoidance, or Kimi; criterion 7 requires new tests that fail without the fix.

Key risks are shared-helper coupling, Windows-form parsing correctness, avoiding PATH lookup and file writes when nothing is stale, and per-start warn noise for Kimi. Overall this reads as a small-to-medium change (2 source files, 1-2 test files) with well-bounded blast radius.

---

## 8. External References

None named by the task. (Task references only in-repo files and the repo guides under `.ai-run/guides/`; all resolved.)
