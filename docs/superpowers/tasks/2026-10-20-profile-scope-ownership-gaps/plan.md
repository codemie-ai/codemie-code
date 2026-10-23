# Profile Scope Gaps Implementation Plan

> **For agentic workers:** Executed inline by `sdlc-standard` Stage 5 (`superpowers:test-driven-development`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining profile-scope gaps on top of PR #575. Local config writes never destroy data, profile failures are always visible, rename and setup act on the owning scope, and a dangling local `activeProfile` produces one visible warning.

**Architecture:** All local-config writes go through one read-modify-write helper in `ConfigLoader` that has an explicit fill/refuse classifier. Read paths stay as they are today, except Local skills/assistants, which use the same classifier. The CLI layer gets one shared error printer for profile, auth and setup commands. The fallback warning is opt-in per process and only goes to a TTY.

**Tech Stack:** TypeScript (ESM, Node ≥ 20), commander, chalk, inquirer, Vitest 4.

**Spec:** `docs/superpowers/tasks/2026-10-20-profile-scope-ownership-gaps/spec.md`

## Global Constraints

- ES modules, imports with a `.js` suffix; `@/` alias for new cross-tree imports; no `any` in new code; explicit return types on exports.
- Config-shape problems throw `ConfigurationError` (`src/utils/errors.ts`). It must name the file and say it was left unchanged.
- Mutating ConfigLoader profile methods return `StorageScope` (the #575 convention).
- Never change `logger.error` globally.
- Fallback warning text, exactly: `⚠ Local profile "<name>" not found in <local config path>; using global profile "<global>". Run: codemie profile switch`. Without a valid global active profile: `⚠ Local profile "<name>" not found in <local config path> and no global profile is active. Run: codemie setup`.
- Error line format: `✗ <label>: <reason>` in red to stderr, then exit 1. Cancellation prints `Cancelled.` in yellow and exits 0.
- Never run the built CLI against the real `~/.codemie`. Manual checks use isolated `CODEMIE_HOME`, `HOME` and `USERPROFILE`.
- Filip's commits stay untouched (no rebase or squash on this branch).
- Unit test command: `npx vitest run --project unit <file>`.

## Review Focus

1. **A local file saved by Windows editors with a UTF-8 BOM or CRLF** must be treated as valid JSON, not refused. Test in Task 1.
2. **An explicit `--profile <name>`** must bypass the fallback and never print the warning. Test in Task 5.
3. **`profile rename a a`** (same name) and renaming onto a name that exists only in the *other* scope must fail with a clear error and leave both files unchanged. Test in Task 4.
4. **Setup Update of a local profile in a directory whose local file is a "fill"-shape file** (assistants/workspace only) must succeed and keep those keys. Test in Task 3.
5. **The fallback warning must not print twice** when one command calls `getEffectiveActiveProfileName` several times (list → load → getActiveProfileName). Test in Task 5.

---

### Task 1: Safe local-write helper and classifier (B1, B3 for new files)

**Files:**
- Modify: `src/utils/config.ts`
  - `loadConfigByScope`/`saveConfigByScope` 73-85
  - `loadLocalMultiProviderConfig` 581-598
  - `saveLocalMultiProviderConfig` 604-609
- Create test: `src/utils/__tests__/config-local-write.test.ts` (copy the TEST_DIR, path-spy and env-cleanup harness from `config-project-override.test.ts` lines 1-51)

**Interfaces:**
- Produces:
  - `private static classifyLocalConfigForWrite(raw: unknown, configPath: string): MultiProviderConfig`. It returns a filled v2 object per the spec B1 table, or throws `ConfigurationError`.
  - `private static async readLocalConfigForWrite(workingDir: string): Promise<MultiProviderConfig>`:
    - A missing file returns `{version:2, activeProfile:'', profiles:{}}`.
    - Otherwise it reads the raw text, strips a leading BOM, `JSON.parse`s it (a parse error becomes `ConfigurationError`) and classifies it.
  - `static async updateLocalConfig(workingDir: string, mutate: (config: MultiProviderConfig) => void): Promise<MultiProviderConfig>`. It reads for write, mutates, saves and returns the saved object.
  - `loadConfigByScope(LOCAL)` now returns `readLocalConfigForWrite`, and `saveConfigByScope(LOCAL)` keeps using `saveLocalMultiProviderConfig`. This gives `loadSkillsByScope`, `loadAssistantsByScope` and `save*ToProjectConfig` the lenient classifier.
  - `loadLocalMultiProviderConfig`'s missing-file default becomes `activeProfile: ''` (B3).

**Test-first: yes** — `config-local-write.test.ts` cases fail because `updateLocalConfig` doesn't exist, and because a fresh-dir skill save writes `'default'`.

- [ ] **Step 1: Write the failing tests** in `describe('ConfigLoader.updateLocalConfig')`:
  - `keeps every other key of a valid v2 file` — local `{version:2, activeProfile:'a', profiles:{a:{provider:'sso'}}, codemieAssistants:[{slug:'jira'}], codemieSkills:[{slug:'s'}], workspace:{codeMieProject:'philips'}, custom:1}`. Mutate `c => { c.activeProfile = 'b' }`. Expect the file to deep-equal the input with `activeProfile:'b'`.
  - `fills a versionless assistants/workspace-only file` — `{codemieAssistants:[{slug:'jira'}], workspace:{codeMieProject:'philips'}}`. Mutate activeProfile `'work'`. Expect `version:2`, `profiles:{}`, `activeProfile:'work'`, and `codemieAssistants`/`workspace` kept.
  - `accepts a BOM + CRLF file` — write `'﻿' + JSON.stringify(v2,null,2).replace(/\n/g,'\r\n')`. The update succeeds.
  - `it.each` refuse cases: `'{not json'`, `'[]'`, a legacy `{provider:'openai', model:'gpt'}`, `{version:3, profiles:{}}`, `{version:2, profiles:[], activeProfile:''}`, `{version:2, profiles:{a:null}, activeProfile:''}`, `{version:2, profiles:{}, activeProfile:5}`.
    - Expect `rejects.toThrow(ConfigurationError)`, the message contains the local path and `left unchanged`, and the file is byte-identical (compare `readFile` before and after).
  - `creates a missing file with activeProfile ""` — `updateLocalConfig(dir, c => { c.codemieSkills = [] })` → `activeProfile:''`, `profiles:{}`.
  - `saveSkillsToProjectConfig in a fresh dir writes activeProfile ""` — call `ConfigLoader.saveSkillsToProjectConfig(dir, StorageScope.LOCAL, [])`. Expect the local file's `activeProfile` to be `''`, and `ConfigLoader.getActiveProfileName(dir)` to equal the global active profile.
- [ ] **Step 2: Run** `npx vitest run --project unit src/utils/__tests__/config-local-write.test.ts`. Expected: FAIL (`updateLocalConfig is not a function`; `activeProfile` is `'default'`).
- [ ] **Step 3: Implement** the Interfaces above in `src/utils/config.ts`. The classifier follows the spec B1 table row by row, reusing `isMultiProviderConfig` and `isLegacyConfig` from `src/env/types.ts`. `ConfigurationError` message: `` `Local config ${configPath} has an unsupported format (${reason}); it was left unchanged.` ``
- [ ] **Step 4: Run** the same command, plus `npx vitest run --project unit src/utils/__tests__/config-project-override.test.ts`. Expected: all PASS (the initProjectConfig tests 53-145 still pass).
- [ ] **Step 5: Commit** `fix(config): never overwrite local config on write (profile-scope-ownership-gaps T1)`.

### Task 2: switch/delete through the helper; delete repair writes "" (B1, B3 delete repair, AC3/4/9)

**Files:**
- Modify: `src/utils/config.ts` — `deleteProfile` 702-746 and `switchProfile` 754-783
- Modify test: `src/utils/__tests__/config-project-override.test.ts` (#575's "profile scope ownership" block, 170-265: update its repaired-value assertion to `''`)
- Test: `src/utils/__tests__/config-local-write.test.ts`

**Interfaces:**
- Consumes: `updateLocalConfig` (Task 1).
- Produces: no signature changes. `switchProfile(name, workingDir): Promise<StorageScope>` and `deleteProfile(name, workingDir): Promise<StorageScope>` keep their signatures.

**Test-first: yes** — `switch keeps codemieAssistants for a fill-shape file` fails because the current code writes a fresh object.

- [ ] **Step 1: Write the failing tests** in a new `describe('profile ops keep local data')` block:
  - `switch keeps codemieAssistants/workspace for a fill-shape file` — local `{codemieAssistants:[{slug:'jira'}], workspace:{codeMieProject:'p'}}`, global with profile `work`. Run `switchProfile('work', dir)`. The local file keeps both keys and has `activeProfile:'work'`.
  - `switch refuses a legacy local file and leaves it byte-identical` → rejects `ConfigurationError`.
  - `deleting the last local profile writes activeProfile "" and keeps other keys` (bug-report Scenario 3, first half).
  - `after deleting the last local profile, deleting a global profile succeeds` (Scenario 3, second half). The global file no longer has it.
  - `deleting the global profile the local active points to, with no local profiles, writes ""`.
  - `listProfiles marks the global active profile when the local active is dangling` (AC9). The local file is `{version:2, activeProfile:'gone', profiles:{}}`; expect `active === true` only on the global active profile.
- [ ] **Step 2: Run** `npx vitest run --project unit src/utils/__tests__/config-local-write.test.ts`. Expected: FAIL on the switch and delete-repair cases.
- [ ] **Step 3: Implement.**
  - `switchProfile` local branch → `updateLocalConfig(workingDir, c => { c.activeProfile = profileName })`.
  - `deleteProfile`:
    - Local scope: the whole mutation goes through `updateLocalConfig`.
    - When no local profile remains, set `activeProfile = ''` in both the local-scope branch and the global-delete repair branch. Remove the "copy global active name" branches.
    - The global scope path stays on `loadMultiProviderConfig`/`saveMultiProviderConfig`.
  - Update #575's assertion in `config-project-override.test.ts` that expects the copied global name so it expects `''`.
- [ ] **Step 4: Run** both test files. Expected: PASS.
- [ ] **Step 5: Commit** `fix(config): keep local keys on switch and delete (profile-scope-ownership-gaps T2)`.

### Task 3: Setup Local save merges (B2)

**Files:**
- Modify: `src/utils/config.ts` — add `saveLocalProfile`; `initProjectConfig` stays unchanged
- Modify: `src/cli/commands/setup.ts` 310-342 (the Local save branch)
- Test: `src/utils/__tests__/config-local-write.test.ts`

**Interfaces:**
- Consumes: `updateLocalConfig` (Task 1), `splitProfileAndWorkspace` (existing, private).
- Produces: `static async saveLocalProfile(workingDir: string, profileName: string, input: Partial<CodeMieConfigOptions>, options: { isUpdate: boolean }): Promise<{ activated: boolean }>`.
  - It writes `profiles[profileName]` (the provider half, `name` set, `codemieSkills`/`codemieAssistants` stripped as in `saveProfile`).
  - It shallow-merges the workspace half into the existing `workspace` (new values win).
  - Activation:
    - With `isUpdate: true`: activate only if the local `activeProfile` is `''` or exists in neither scope.
    - With `isUpdate: false`: also activate if this is the only local profile.
  - It returns whether it activated.

**Test-first: yes** — `saveLocalProfile keeps other profiles and keys` fails because `saveLocalProfile` doesn't exist.

- [ ] **Step 1: Write the failing tests** in `describe('saveLocalProfile')`. Use a local file with profiles `team` and `other`, `activeProfile:'team'`, `codemieAssistants`, `codemieSkills`, `workspace:{codeMieProject:'p', hooks:{x:1}}`.
  - `update keeps other profiles, keys and the active profile`:
    - `saveLocalProfile(dir,'other',{provider:'litellm', model:'m', codeMieProject:'q'},{isUpdate:true})`.
    - Expect `team` unchanged, `other.model === 'm'`, `workspace` = `{codeMieProject:'q', hooks:{x:1}}`, `activeProfile === 'team'`, `activated === false`.
  - `add when other local profiles exist does not activate` → `activated === false`, `activeProfile === 'team'`.
  - `add as the only local profile activates` (fresh dir) → `activated === true`.
  - `update activates when the local active is dangling`.
  - `add into a fill-shape file keeps assistants/workspace` (Review Focus 4).
- [ ] **Step 2: Run** `npx vitest run --project unit src/utils/__tests__/config-local-write.test.ts`. Expected: FAIL (`saveLocalProfile is not a function`).
- [ ] **Step 3: Implement** `saveLocalProfile`.
  - In `setup.ts`, replace the `initProjectConfig` call with `const { activated } = await ConfigLoader.saveLocalProfile(workingDir, finalProfileName!, config, { isUpdate })`.
  - Keep the existing "Switch to profile … in local config?" prompt, but gate it on `!isUpdate && !activated` (drop the `profiles.length > 1 && activeProfile !== finalProfileName` condition).
- [ ] **Step 4: Run** the same test file. Expected: PASS. Then `npm run typecheck`. Expected: no errors.
- [ ] **Step 5: Commit** `fix(setup): merge local profile saves instead of rewriting the file (profile-scope-ownership-gaps T3)`.

### Task 4: Scope-aware rename (B5)

**Files:**
- Modify: `src/utils/config.ts` — `renameProfile` 903-925
- Modify: `src/cli/commands/profile/index.ts` — rename action 444-462
- Test: `src/utils/__tests__/config-local-write.test.ts`

**Interfaces:**
- Consumes: `getProfileScope`, `listProfiles`, `updateLocalConfig`.
- Produces: `static async renameProfile(oldName: string, newName: string, workingDir: string = process.cwd()): Promise<StorageScope>`.
  - Errors: `Profile "<old>" not found. Available profiles: …` (from `getProfileScope`), and `Profile "<new>" already exists in local config|global config`.

**Test-first: yes** — `renames a local-only profile` fails with `Profile "x" not found`.

- [ ] **Step 1: Write the failing tests** in `describe('renameProfile')`:
  - `renames a local-only profile, keeps other keys, updates the local activeProfile` → returns `'local'`.
  - `renames a global profile and repairs the cwd local activeProfile reference` → the global file has the new key and `activeProfile` updated if it matched; the local `activeProfile` equals the new name; returns `'global'`.
  - `rejects a new name that exists in the other scope` → rejects with `already exists in local config`; both files are byte-identical.
  - `rejects rename onto the same name` (`a` → `a`) → rejects `already exists`.
  - `rejects an unknown old name and lists the available profiles`.
- [ ] **Step 2: Run** `npx vitest run --project unit src/utils/__tests__/config-local-write.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Owning scope = `getProfileScope(oldName, workingDir)`.
  - Uniqueness: `listProfiles(workingDir)` gives the merged names. Also check the raw global and local maps, because `listProfiles` collapses duplicates; name the scope in the error.
  - Local scope: rename inside `updateLocalConfig`.
  - Global scope: rename via `loadMultiProviderConfig`/`saveMultiProviderConfig`, then, if the cwd local file exists and its `activeProfile === oldName`, run `updateLocalConfig(… activeProfile = newName)`.
  - CLI: `const scope = await ConfigLoader.renameProfile(oldName, newName, process.cwd())`, then print `` `\n✓ Profile "${oldName}" renamed to "${newName}" in ${scope === 'local' ? 'local config' : 'global config'}\n` ``.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `fix(config): rename profiles in their owning scope (profile-scope-ownership-gaps T4)`.

### Task 5: One-time fallback warning (B4)

**Files:**
- Modify: `src/utils/config.ts` — `getEffectiveActiveProfileName` 100-117; add warning state
- Modify: `src/cli/commands/profile/index.ts` — `createProfileCommand` (28-44): add a `preAction` hook
- Modify: `src/agents/core/AgentCLI.ts` (~211): enable before `ConfigLoader.load`
- Test: `src/utils/__tests__/config-local-write.test.ts`

**Interfaces:**
- Produces:
  - `static enableFallbackWarning(): void` sets a static opt-in flag.
  - `static resetFallbackWarningForTests(): void` clears both the opt-in flag and the shown flag.
  - When a dangling **non-empty** local name is detected, `getEffectiveActiveProfileName`:
    - always calls `logger.warn(<message>)` (log file);
    - if opted in, `process.stderr.isTTY` is true and the warning hasn't been shown yet, prints `console.error(chalk.yellow(<message>))` and marks it shown.
  - `''` never warns.

**Test-first: yes** — `prints the warning once on a TTY` fails because nothing is printed.

- [ ] **Step 1: Write the failing tests** in `describe('fallback warning')`. Each test calls `resetFallbackWarningForTests()`, spies on `console.error`, and sets `process.stderr.isTTY` via `Object.defineProperty` (restored in `afterEach`). Local file: `{version:2, activeProfile:'gone', profiles:{}}`; global active `work`.
  - `prints the warning exactly once on a TTY when enabled` — call `listProfiles(dir)`, `load(dir)` and `getActiveProfileName(dir)`. `console.error` is called once with the exact text from Global Constraints, using the real local path.
  - `does not print when stderr is not a TTY`.
  - `does not print when not enabled` (the hook/daemon path).
  - `does not warn for activeProfile ""`.
  - `does not warn with an explicit profile` — `load(dir, { name: 'work' })` (Review Focus 2).
  - `uses the no-global-active wording when the global has no valid active profile`.
- [ ] **Step 2: Run** `npx vitest run --project unit src/utils/__tests__/config-local-write.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces.
  - `createProfileCommand()` adds `.hook('preAction', () => ConfigLoader.enableFallbackWarning())`.
  - `AgentCLI` calls `ConfigLoader.enableFallbackWarning()` right before `ConfigLoader.load(...)`.
  - Add `enableFallbackWarning: vi.fn()` to the ConfigLoader mock in `src/cli/commands/profile/__tests__/index.test.ts`, and to any AgentCLI test mock that lacks it (grep `ConfigLoader: {` under `src/agents/core/__tests__`).
- [ ] **Step 4: Run** the test file, `npx vitest run --project unit src/cli/commands/profile` and `npx vitest run --project unit src/agents/core`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(config): warn once when a local active profile is missing (profile-scope-ownership-gaps T5)`.

### Task 6: Visible errors and clean cancellation (B6)

**Files:**
- Create: `src/cli/commands/profile/command-error.ts`
- Modify: `src/cli/commands/profile/index.ts`
  - catch blocks: list 69-72, status 92-95, switch 361-364, delete 435-438, rename 455-458
  - picker reject at 291
- Modify: `src/cli/commands/profile/auth.ts` 22-24, 39-41, 56-58
- Modify: `src/cli/commands/setup.ts` 43-46
- Test: `src/cli/commands/profile/__tests__/index.test.ts` (add `red` to the chalk mock; add `switchProfile`, `deleteProfile`, `getProfileScope`, `renameProfile` and `enableFallbackWarning` to the ConfigLoader mock)

**Interfaces:**
- Produces:
  - `export class ProfileSelectionCancelledError extends Error` (message `Profile selection cancelled.`).
  - `export function exitWithCommandError(label: string, error: unknown): never`:
    - Always calls `logger.error(label, error)`.
    - For a `ProfileSelectionCancelledError`, prints `console.log(chalk.yellow('\nCancelled.\n'))` and calls `process.exit(0)`.
    - Otherwise prints `console.error(chalk.red(`✗ ${label}: ${getErrorMessage(error)}`))` and calls `process.exit(1)`.
- Labels: `Failed to list profiles`, `Failed to get profile status`, `Failed to switch profile`, `Failed to delete profile`, `Failed to rename profile`, `Login failed`, `Logout failed`, `Refresh failed`, `Setup failed`.

**Test-first: yes** — `delete of an unknown profile prints a red reason` fails because nothing is printed.

- [ ] **Step 1: Write the failing tests.** Spy on `process.exit` (mock throws `process.exit:<code>`), `console.error` and `console.log`.
  - `delete prints ✗ Failed to delete profile: <reason> and exits 1` — `getProfileScope` mock rejects `new Error('Profile "nope" not found. Available profiles: work')`; run `createProfileCommand().parseAsync(['delete','nope','--yes'],{from:'user'})`. Expect `console.error` called with `[red]✗ Failed to delete profile: Profile "nope" not found. Available profiles: work[/red]` and exit code 1.
  - `rename prints the reason on failure`.
  - `rename success names the scope` — `renameProfile` resolves `'local'`; expect output containing `renamed to "b" in local config`.
  - `switch picker cancel prints Cancelled. and exits 0` — `switchProfile` mock rejects `new ProfileSelectionCancelledError()`.
- [ ] **Step 2: Run** `npx vitest run --project unit src/cli/commands/profile`. Expected: FAIL.
- [ ] **Step 3: Implement** `command-error.ts`.
  - Replace each listed catch body with `exitWithCommandError('<label>', error)`.
  - Make the picker reject with `new ProfileSelectionCancelledError()`.
  - `auth.ts` and `setup.ts` import the helper (relative `.js` path, matching each file's existing imports).
- [ ] **Step 4: Run** `npx vitest run --project unit src/cli/commands/profile src/cli/commands/__tests__` (setup tests, if any). Expected: PASS.
- [ ] **Step 5: Commit** `fix(cli): show profile command failures without debug mode (profile-scope-ownership-gaps T6)`.

### Task 7: Guide update, gates and isolated end-to-end check

**Files:**
- Modify: `.ai-run/guides/usage/project-config.md`. Add these rules to the "Key rule" section near line 63:
  - every local write is a merge, and unsupported files are refused unchanged;
  - `activeProfile: ""` means "follow global";
  - the one-time fallback warning;
  - rename acts on the owning scope and repairs the cwd local reference;
  - setup Local add/update activation.

**Test-first: no** — documentation and verification only.

- [ ] **Step 1:** Update the guide as listed (prose only, matching the existing table and section style).
- [ ] **Step 2:** Run `npm run lint`, `npm run typecheck`, `npm run build` and `npx vitest run --project unit src/utils src/cli/commands/profile src/env src/agents/core`. Expected: all pass with zero lint warnings.
- [ ] **Step 3:** Isolated end-to-end check. Use the existing scratchpad runner (`CODEMIE_HOME`/`HOME`/`USERPROFILE` → scratchpad `repro/home`) to re-run bug-report scenarios 1–4 plus E1 (`profile delete nope --yes` shows a red reason), E2 (global rename repairs the local reference) and E4 (a fill-shape file keeps its keys on switch, a legacy file is refused unchanged). Expected: each matches the spec ACs.
- [ ] **Step 4: Commit** `docs(config): document profile scope rules (profile-scope-ownership-gaps T7)`.
