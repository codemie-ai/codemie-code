# EPMCDME-15307 Installers Must Not Rewrite the npm Prefix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` syntax.

**Goal:** Stop both installers from writing a user-wide npm `prefix`, migrate affected machines, keep CodeMie self-update pointed at the running copy, and warn in `codemie doctor`.

**Architecture:** A new `src/utils/npm-prefix.ts` works out CodeMie's own install prefix from its package path and detects the legacy override. `processes.ts` npm helpers and `cli-bin.ts` use it only for `@codemieai/code`. A new doctor check reuses the detection. The installers add `auto`/`--prefix` behavior and a migration path.

**Tech Stack:** TypeScript (ESM, Vitest), PowerShell, POSIX sh.

**Spec:** `docs/superpowers/tasks/2026-09-28-epmcdme-15307/spec.md` (design: `design-decisions.md`)

Commit per task using the repository's existing convention.

## Global Constraints

- Only `@codemieai/code` gets `--prefix`. The argv for every other package stays byte-identical to today's.
- A legacy override means the user-level prefix exactly equals `<InstallRoot>\npm-prefix` (Windows, default `%LOCALAPPDATA%\CodeMie\npm-prefix`) or `$HOME/.codemie/npm-prefix` (POSIX). Ignore every other value, `NPM_CONFIG_PREFIX`, and global or project `.npmrc`.
- Nothing may write `prefix` to any `.npmrc`. Every user-wide change is printed together with its revert command.
- Use `exec()` from `src/utils/exec.ts` with `shell: isWindows`. Imports use `.js` extensions and the `@/` alias.

## Review Focus

1. A Windows prefix comparison that differs only by letter case or a trailing `\` still counts as a match. Normalize with `path.resolve`, strip the trailing separator, and compare case-insensitively on win32 only. Test in Task 1.
2. A dev checkout or `npm link` path yields `null`, so no `--prefix` is added. Test in Task 1.
3. If `npm prefix -g` fails, keep today's argv and do not throw. Test in Task 2.
4. A custom user prefix such as `D:\npm` makes doctor report `ok`. Test in Task 4.
5. When the derived prefix equals `npm prefix -g`, including by case on Windows, no `--prefix` is added. Test in Task 2.

---

### Task 1: `npm-prefix` utility — self prefix derivation and legacy override detection

**Files:** Create `src/utils/npm-prefix.ts`. Test `src/utils/__tests__/npm-prefix.test.ts`.

**Interfaces (produces):**
```ts
export const CODEMIE_PACKAGE = '@codemieai/code';
export function deriveSelfPrefix(packageDir?: string, platform?: NodeJS.Platform): string | null;
export function getLegacyPrefixPath(platform?: NodeJS.Platform): string;
export function isSamePath(a: string, b: string, platform?: NodeJS.Platform): boolean;
export async function getUserNpmPrefix(): Promise<string | null>;
export async function getSelfPrefixArgs(packageName: string): Promise<string[]>;
```
- `deriveSelfPrefix`: `packageDir` defaults to the package root, reached through `getDirname(import.meta.url)`. On win32 it returns `<p>` when the dir is `<p>\node_modules\@codemieai\code`. On POSIX it returns `<p>` for `<p>/lib/node_modules/@codemieai/code`. Anything else returns `null`.
- `getLegacyPrefixPath`: on win32, `join(LOCALAPPDATA, 'CodeMie', 'npm-prefix')`. Otherwise `join(homedir(), '.codemie', 'npm-prefix')`.
- `getUserNpmPrefix`: `npm config get prefix --location user`, trimmed. Returns `null` on a nonzero exit or empty output.
- `getSelfPrefixArgs`: returns `[]` unless the package is `CODEMIE_PACKAGE`, the derived prefix is not null, and it differs (by `isSamePath`) from `npm prefix -g`. In that case it returns `['--prefix', derived]`. The `npm prefix -g` result is memoized. Any failure returns `[]`.

Test-first: yes. Failing tests cover `deriveSelfPrefix` for the win32 layout, the POSIX layout, and a dev checkout (`null`). They cover `isSamePath` case and trailing-separator handling. They cover `getSelfPrefixArgs` with `vi.mock('@/utils/exec.js')`: a different global prefix returns the args, an equal prefix returns `[]`, another package returns `[]`, and an exec failure returns `[]`.

- [ ] Write the failing tests and run `npx vitest run src/utils/__tests__/npm-prefix.test.ts`. They fail because the module does not exist.
- [ ] Implement the module and rerun the tests until they pass.

### Task 2: Pass the derived prefix in npm helpers for `@codemieai/code`

**Files:** Modify `src/utils/processes.ts:142-262`. Test `src/utils/__tests__/processes.test.ts`.

**Consumes:** `getSelfPrefixArgs(packageName)` from Task 1.

Test-first: yes. Failing tests mock `@/utils/npm-prefix.js` so that `getSelfPrefixArgs` returns `['--prefix','C:\\X']` for `@codemieai/code`. They then assert these argv values:
- `installGlobal('@codemieai/code',{version:'1.2.3'})` gives `['install','-g','--prefix','C:\\X','@codemieai/code@1.2.3']`.
- `uninstallGlobal` gives `['uninstall','-g','--prefix','C:\\X','@codemieai/code']`.
- `listGlobal` gives `['list','-g','--prefix','C:\\X','@codemieai/code']`.

The existing `test-package` assertions stay unchanged.

- [ ] Add the tests and confirm they fail.
- [ ] In each of the three helpers, splice `...(await getSelfPrefixArgs(packageName))` right after `'-g'`. In `installGlobal` this goes before `--force`. In `listGlobal` the call sits inside the existing `try`, so a failure still returns `false`. Rerun the processes tests.

### Task 3: `restoreCliBinLink` uses the running copy's prefix

**Files:** Modify `src/utils/cli-bin.ts:36-40`. Test `src/utils/__tests__/cli-bin.test.ts`.

Test-first: yes. The failing test mocks `deriveSelfPrefix` to return `/home/u/.codemie/npm-prefix`. It asserts that `lstat` is called on `/home/u/.codemie/npm-prefix/bin/codemie` and that `npm prefix -g` is never executed. The existing tests mock `deriveSelfPrefix` to return `null`, which keeps the current path.

- [ ] Add the test and confirm it fails.
- [ ] Use `deriveSelfPrefix()` when it is non-null, and fall back to the existing `npm prefix -g` lookup otherwise. Rerun the test.

### Task 4: Doctor check `NpmPrefixOverrideCheck`

**Files:** Create `src/cli/commands/doctor/checks/NpmPrefixOverrideCheck.ts`. Modify `checks/index.ts` (export) and `src/cli/commands/doctor/index.ts` (instantiate right after `NpmCheck`). Test `src/cli/commands/doctor/checks/__tests__/doctor-checks.test.ts`.

**Consumes:** `getUserNpmPrefix`, `getLegacyPrefixPath`, `isSamePath` from Task 1.

The check follows the `HealthCheck` shape in `checks/NpmCheck.ts`. It is named `npm prefix`. On a match it reports `warn` with the message `User npm prefix is set to CodeMie's legacy path <p>`. It then adds `info` details with these hints:
- `npm config delete prefix --location user`
- `npm ls -g --prefix "<p>" --depth=0` to see stranded packages
- reinstall them, for example `npm i -g @anthropic-ai/claude-code@latest`
- the old folder can be deleted afterwards

With no match or a `null` prefix it reports `ok`. It is read-only and runs no mutating command.

Test-first: yes. Failing tests mock `@/utils/npm-prefix.js` and cover three cases: a legacy match gives `success:true` with a `warn` detail that contains `npm config delete prefix --location user`; a custom prefix `D:\npm` gives only `ok`; a `null` prefix gives `ok`.

- [ ] Add the tests, confirm they fail, implement the check, register it, and rerun.

### Task 5: Windows installer — `auto` mode, scoped portable prefix, migration

**Files:** Modify `install/windows/install.ps1`.

Test-first: no — there is no installer harness (a spec non-goal). Run `-DryRun` by hand to check the printed commands.

- [ ] Make these changes:
  - `:3-4`: `ValidateSet('auto','npm-global','portable')`, default `'auto'`.
  - Add `Test-DirWritable($Path)`. It walks up to the nearest existing ancestor, then writes and deletes a random temp file inside `try/catch`.
  - Add `Resolve-InstallMode`. It returns `npm-global` if `npm config get prefix` is writable and `portable` otherwise. Print the result with `Write-Status 'Mode'`.
  - **Migration, before mode resolution:** if `npm config get prefix --location user` exactly equals `$PrefixDir` (case-insensitive, with the trailing `\` trimmed), then:
    1. List the stranded packages with `npm ls -g --prefix $PrefixDir --depth=0`.
    2. `Invoke-Checked npm config delete prefix --location user`, and print that it ran.
    3. After install, if the resolved mode is not `portable`, remove the `$Commands` shims from `$BinDir` and remove `$BinDir` from the user PATH (a new `Remove-UserPath` that mirrors `Add-UserPath:96-118`, with every mutation going through `Invoke-Checked`).
    4. Print the reinstall guidance (`npm i -g @anthropic-ai/claude-code@latest` as the example) and `Remove-Item -Recurse "<PrefixDir>"` as the optional cleanup. Leave the folder in place.
  - `:169-176`: delete the `npm config set prefix` call. Portable mode still creates the dirs.
  - `:189`: for portable, add `--prefix $PrefixDir`.
  - `:178-180`: after setting `@codemieai:registry`, print `Revert: npm config delete @codemieai:registry --location user`.

### Task 6: macOS/Linux installer — `--prefix` user-prefix and migration

**Files:** Modify `install/macos/install.sh`.

Test-first: no — no bats harness (non-goal). Check with `sh -n install/macos/install.sh`.

- [ ] Make these changes:
  - Before auto resolution (`:58-65`), migrate when `npm config get prefix --location user` equals `$HOME/.codemie/npm-prefix`. List the stranded packages (`npm ls -g --prefix <old> --depth=0`), run `npm config delete prefix --location user`, and print that it ran. At the end, print the reinstall guidance and the optional `rm -rf <old>`.
  - `:69-80`: drop `npm config set prefix` (`:71`) but keep the `$USER_PREFIX/bin` PATH hint.
  - `:97`: in user-prefix mode, add `--prefix "$USER_PREFIX"`.
  - After `CODEMIE_SCOPE_REGISTRY_URL` is written, print its revert command.

### Task 7: README — modes, defaults, revert, migration

**Files:** Modify `install/README.md:67-106`.

Test-first: no — this task only changes docs.

- [ ] Make these changes:
  - `-Mode` row: `auto|npm-global|portable`, default `auto`.
  - Add a table of what each mode changes (Windows and macOS/Linux), noting that no mode writes `prefix` to `.npmrc`.
  - Add the revert commands for `@codemieai:registry`.
  - Add an "Upgrading from an older installer" section: the rerun migration steps, `codemie doctor` detection, the manual `npm config delete prefix --location user`, and reinstalling stranded packages.
  - Fix "Windows Defaults" / "Default Paths" so they match the new behavior.
