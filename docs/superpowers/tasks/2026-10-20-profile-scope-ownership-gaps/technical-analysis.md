# Technical Research

**Task**: config profile local-scope cli
**Generated**: 2026-10-20
**Research path**: filesystem

---

## 1. Original Context

Branch fix/profile-scope-ownership was created from PR #575 (Filip-Stastny-Philips, 'fix(config): respect profile ownership across scopes') merged with current main. PR #575 fixes: profile delete from the owning scope, dangling local activeProfile falling back to global, empty local activeProfile tolerated, switchProfile preserving local keys, setup updating profiles in their own scope. Remaining gaps to fix on this branch: (E1) profile command failures (delete/switch/rename/status) exit 1 with no visible message because logger.error only prints to console in debug mode (src/utils/logger.ts ~338-344, src/cli/commands/profile/index.ts catch blocks); (E2) renameProfile only edits the global config, leaving a local .codemie/codemie-cli.config.json activeProfile pointing at the old name, so the repo silently falls back to a different profile, and renameProfile cannot rename a local-only profile; (E4) switchProfile overwrites a local config file that is not recognised as multi-provider v2 (e.g. assistants/workspace-only or legacy file), losing codemieAssistants/codemieSkills/workspace. Also validate for any further gaps, bugs or mismatches against the PR #575 acceptance criteria and the client bug report (D:/Projects/codemie-bugs/codemie-cli-local-config-breaks-profiles.md).

---

## 2. Codebase Findings

### Existing Implementations
- `src/utils/config.ts` — `ConfigLoader` (static). All profile and scope logic lives here.
  - PR helpers: `getConfiguredActiveProfileName` 87-90, `loadLocalMultiProviderConfigIfAvailable` 92-98 (returns null for a non-v2 file), `getEffectiveActiveProfileName` 100-117 (silent fallback from local to global active).
  - `loadGlobalConfigProfile` 324-361: an explicit missing name returns `{}` (337-341).
  - `loadJsonConfig` 524-531 swallows read and parse errors and returns `{}`.
  - `loadMultiProviderConfig` 551-579 returns an empty skeleton for any unrecognised global file.
  - `loadLocalMultiProviderConfig` 581-598: missing file → `{activeProfile:'default', profiles:{}}`; any other non-v2 file → `ConfigurationError`.
  - `deleteProfile` 702-746 (scope-owned, repairs the cwd local reference).
  - `switchProfile` 754-783: for a non-v2 local file it writes a fresh object (E4).
  - `getProfileScope` 788-805 throws a plain `Error`.
  - `listProfiles` 811-876.
  - `renameProfile` 903-925: global only, no `workingDir` (E2).
  - `initProjectConfig` 955-995 writes the local file from scratch and never reads the existing one.
  - `saveAssistantsToProjectConfig` 997-1005, `saveSkillsToProjectConfig` 1062-1070.
- `src/cli/commands/profile/index.ts` — commander profile commands.
  - Catch blocks call only `logger.error` + `process.exit(1)`: list 69-72, status 92-95, switch 361-364, delete 435-438, rename 455-458.
  - The selection prompt rejects with `Error('Profile selection cancelled.')` (288-292).
  - Rename (444-462) passes no `workingDir`.
- `src/cli/commands/profile/auth.ts` — same silent catch pattern at 23, 40, 57.
- `src/cli/commands/setup.ts` — the update path uses `getProfileScope` (111-112). For a Local save it calls `initProjectConfig` (310-342), which is **destructive**: it rewrites the whole local file with one profile.
- `src/env/types.ts` — `isMultiProviderConfig` 211-224 (relaxed by the PR: `activeProfile` may be `''`; profiles must be plain objects).
- `src/utils/logger.ts` — `error` 326-356 prints to the console only in debug mode; `notice` 358-368 always prints a yellow ⚠.

### Architecture and Layers Affected
- CLI command layer: `src/cli/commands/profile/index.ts`, `auth.ts`, `setup.ts`.
- Utility/config service layer: `src/utils/config.ts` (`ConfigLoader`), `src/env/types.ts`.
- Persistence: JSON files, global `getCodemiePath('codemie-cli.config.json')` and local `<cwd>/.codemie/codemie-cli.config.json`.

### Integration Points
- Agent launch: `src/agents/core/AgentCLI.ts:211-219` → `ConfigLoader.load` (the effective-profile fallback applies to every agent run).
- Local writers: assistants setup (`assistants/setup/index.ts:321`), skills setup (`skills/setup/index.ts:209,336`), migrations 004/005/007, `deleteProfile`, `switchProfile`, `initProjectConfig`.
- `getActiveProfileName` consumers: doctor `AIConfigCheck.ts:36-37`, `proxy/connect-orchestrator.ts:222,404`.

### Patterns and Conventions
- Scope dispatch: `loadConfigByScope`/`saveConfigByScope` + `StorageScope`. The PR convention is that ConfigLoader profile methods return `StorageScope` so the CLI can name the scope.
- User success output: `console.log(chalk.green('\n✓ ...\n'))`.
- User failure output in other commands: `console.error(chalk.red(\`✗ ...: ${getErrorMessage(error)}\`))` + `process.exit(1)` (52 call sites, e.g. `self-update.ts:68`, `install.ts:328`). `printProxyError` (`proxy/connect-orchestrator.ts:267-279`) prints a concise red line for a `ConfigurationError`.
- Cancellations: a yellow message and return (delete confirmation, index.ts 411-414).
- Do not make `logger.error` print globally: it has 234 call sites, including the proxy daemon and hooks (TUI leakage).

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/usage/project-config.md` (P0). The PR updated the "Key rule" (line 63). It says nothing about rename.
- `.ai-run/guides/development/development-practices.md` 13-51: error pattern. The logging table at 94-100 is stale (it claims WARN/ERROR print to the console).
- `.ai-run/guides/testing/testing-patterns.md` 46-110: Vitest module mocks, lazy-getter note for ConfigLoader.

### Architectural Decisions
- Profile names should be unique across scopes. This is a maintainer decision; enforcement is in PR #585 (open), not here.
- `profile switch` writes `activeProfile` locally when `.codemie/` exists (by design).
- OpenWiki is generated; `openwiki/concepts/configuration-and-local-state.md:91` is stale but must not be hand-edited.

### Derived Conventions
- Use `ConfigurationError` for config-shape problems. Plain `Error` is used for "not found" today.
- Merge into existing JSON on every local write; never replace the file.

---

## 4. Testing Landscape

### Existing Coverage
- `src/utils/__tests__/config-project-override.test.ts` (real FS, global and local in a tmp dir).
  - The PR adds 4 tests at 170-265: switch to global with local present, delete global + repair, missing local active fallback, switch without local.
- `src/cli/commands/profile/__tests__/index.test.ts`: list action and display only, with a mocked ConfigLoader. The chalk mock has no `red`.
- `src/env/__tests__/types.test.ts` 16-82: `isMultiProviderConfig` (no `''` case, no malformed-profiles case).
- `tests/integration/cli-commands/profile.test.ts`: smoke only.

### Testing Framework and Patterns
- Vitest 4, project `unit` (`src/**/*.test.ts`, isolated `CODEMIE_HOME`).
- Path isolation: `vi.spyOn(paths,'getCodemieHome')` / `getCodemiePath`.
- Exit and stderr assertions: spy on `process.exit` (throwing) + `console.error`.

### Coverage Gaps
- No tests at all for `renameProfile`.
- None for local delete of the last profile, switch key preservation / non-v2 local file, `load()`-level Scenario 2, local-scope skills/assistants registration in a fresh dir, setup local update, or profile command error output.
- No `isMultiProviderConfig` `''`/malformed cases.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_DEBUG` — the only switch that makes `logger.error` reach the console.
- `CODEMIE_HOME` — global dir (test isolation).
- `CODEMIE_PROFILE_NAME` — statusline only.

### Configuration Files
- Global `~/.codemie/codemie-cli.config.json`.
- Local `<cwd>/.codemie/codemie-cli.config.json`. The repo itself commits one with `codemieAssistants`, `codemieSkills` and `workspace`.

### Feature Flags and Deployment Concerns
- None. CLI-only. CI runs license-check, lint (zero warnings), build, and unit + cli vitest.

---

## 6. Risk Indicators

- **Setup Local save is destructive** (`setup.ts:310-342` → `initProjectConfig`). Updating or adding a local profile wipes the other local profiles, `codemieAssistants`, `codemieSkills` and `workspace`. This contradicts PR #575's claim and is the same class of bug as E4. **New gap.**
- **E1**: silent failures in every profile/auth catch block. Fixing it centrally in `logger.error` is unsafe (234 call sites, TUI leakage).
- **E2**: `renameProfile` is global only. It leaves dangling local references, can't rename local profiles, and only checks uniqueness globally.
- **E3 (bug-report AC)**: the fallback from a dangling local `activeProfile` is silent. A warning inside `getEffectiveActiveProfileName` would repeat many times per command and print during agent launches. It must be emitted once.
- **E4**: `switchProfile` replaces a non-v2 local file (assistants/workspace-only, profiles array, legacy, unparseable).
- **Fresh-dir local registration** still writes `activeProfile:'default'`. If a global profile named `default` exists, it silently becomes the repo's active profile.
- The relaxed `isMultiProviderConfig` fixes global/local `''` files, but a malformed global file still falls back to an empty skeleton that later saves overwrite. This predates the PR; out of scope, note only.
- Branch builds only after the main merge. PR #575 alone fails to compile with current dependencies (TS2322 in `sdk/services/assistants.ts`).
- Test-coverage AC from the bug report is unmet (no Scenario 3/4 tests).

---

## 7. Summary for Complexity Assessment

The work touches two layers: CLI profile and setup commands (`src/cli/commands/profile/index.ts`, `auth.ts`, `setup.ts`) and the `ConfigLoader` service (`src/utils/config.ts`), plus possibly `src/env/types.ts`. The expected change surface is 4–6 source files plus 3–4 test files. Everything follows existing patterns: scope dispatch through `loadConfigByScope`/`saveConfigByScope`, `StorageScope` return values, and the established `console.error(chalk.red('✗ ...'))` user-error idiom. No new dependencies or external integrations.

The technical novelty is low, but the blast radius matters. `ConfigLoader.load` sits on every agent launch, and local-config writes can destroy committed team configuration, so every write path has to become a merge-into-existing-JSON. The main risks are the destructive setup path (`initProjectConfig`), the non-v2 local file handling in `switchProfile`, and emitting the fallback warning exactly once without polluting agent TUIs.

Test coverage in this area is thin: no rename tests, no command-level error tests, and no key-preservation tests. The real-filesystem `config-project-override.test.ts` harness and the command mock pattern in `profile/__tests__/index.test.ts` can be extended directly. Overall this is a medium-sized, well-bounded bug-fix task with clear acceptance criteria from the client bug report.
