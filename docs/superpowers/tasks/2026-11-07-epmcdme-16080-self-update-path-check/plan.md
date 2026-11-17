# EPMCDME-16080 Implementation Plan: warn when self-update leaves a stale `codemie` first on PATH

**Goal:** after a successful `updateCli`, read the version of the first `codemie` on PATH (no spawn) and warn if it is older than the version just installed.
**Spec:** `spec.md` (approved). Reuse findings in `technical-analysis.md`; arch-review `plan_notes` are folded in below.
**Conventions:** ES modules, `.js` import extensions, `@/` alias in new files, explicit return types on exports, no `any`, `logger.debug` for diagnostics. Do not touch `.codemie/codemie-cli.config.json`, `getCommandPath`, `commandExists`, `bin/codemie.js`, or `NpmPrefixOverrideCheck`.
**Git:** no git operations in any task (repo policy: only on explicit user request).
**Tests:** none are written or run (repo policy: only on explicit user request); validation is the flow's qa-gates stage.

## Task 1: Package-layout helpers in `npm-prefix.ts`

Files: modify `src/utils/npm-prefix.ts` (near the `WIN32_LAYOUT`/`POSIX_LAYOUT` consts at `:16-17`, and after `getCodemieNpmPrefix` at `:71`).

Add two exported, platform-parameterised functions so the layout lives in one place (plan note "one home for the package layout"):
- `getCodemiePackageDir(prefix, platform = process.platform): string` joins the prefix with the existing layout for that platform (win32 `node_modules\@codemieai\code`, POSIX `lib/node_modules/@codemieai/code`), using `getPathModule(platform)`.
- `getNpmBinDir(prefix, platform = process.platform): string` returns the prefix itself on win32 and `<prefix>/bin` on POSIX.

Do not change `getCodemieNpmPrefix`, and do not export `getGlobalNpmPrefix`.

Test-first: no — tests only on explicit user request (project policy)

## Task 2: Active-install check module `src/utils/active-cli.ts` (new)

Files: create `src/utils/active-cli.ts`. Imports use the `@/` alias: `getCommandPath` from `processes.js`; `getCodemieNpmPrefix`, `getCodemiePackageDir`, `getNpmBinDir`, `getCodemieOrGlobalNpmPrefix`, `getLegacyNpmPrefixPath` from `npm-prefix.js`; `compareVersions`, `isValidSemanticVersion` from `version-utils.js`; `isSamePath` from `paths.js`; `getPathModule`, `isWindows` from `platform.js`; `logger`.

Types and entry points to define (all exported, explicit return types):

```ts
export interface ActiveCli { path: string; version: string; prefix: string | null }
export type ActiveCliLookup = { status: 'found'; active: ActiveCli } | { status: 'unknown'; reason: string };
export type ActiveCliVerdict =
  | { status: 'current'; active: ActiveCli }
  | { status: 'stale'; active: ActiveCli; installedVersion: string; newPrefix: string | null }
  | { status: 'unknown'; reason: string };
export function findActiveCli(platform?: NodeJS.Platform): Promise<ActiveCliLookup>;
export function verifyActiveCli(installedVersion: string, opts?: { withHint?: boolean }): Promise<ActiveCliVerdict>;
export function formatStaleWarning(verdict: Extract<ActiveCliVerdict, { status: 'stale' }>, platform?: NodeJS.Platform): string[];
```

Behavior:
- `findActiveCli` (never throws; every failure becomes `unknown` with a reason): call `getCommandPath('codemie')` bounded to about 5 s via `Promise.race` with a cleared timer (the lookup has no timeout of its own, AR-5); no hit or timeout is `unknown`. Nothing is executed except that lookup; `codemie` itself is never spawned.
  - POSIX: `fs.realpath` the hit, walk up to the **first** `package.json` and require `name === '@codemieai/code'` (a different or checkout package is `unknown`, AR-4).
  - win32: the hit's directory is the prefix; read the shim (extensionless or `.cmd`) and require it to match `/@codemieai[\\/]code/`, then read `getCodemiePackageDir(dir, 'win32')/package.json` and require the same name. No `.cmd` swap, shell or quoting.
  - `prefix` comes from `getCodemieNpmPrefix(packageDir, platform)`, `null` when not derivable.
- `verifyActiveCli`: wrap everything in its own try/catch (AR-3). Validate both versions with `isValidSemanticVersion` first; a prerelease or malformed active version yields `unknown` with a reason, so `compareVersions` is never reached with bad input (plan note "prerelease"; the stale prerelease keeps today's text). `compareVersions(active, installed) >= 0` is `current`, otherwise `stale`. When `status` is stale and `opts.withHint` is true, resolve `newPrefix` with `getCodemieOrGlobalNpmPrefix()` inside a try/catch (null on failure). Log every `unknown` reason with `logger.debug`.
- `formatStaleWarning` is pure and returns plain lines (no chalk): active path, the version it will still run, the installed version, then fix steps: (b) primary, put `getNpmBinDir(newPrefix, platform)` ahead of the active directory on PATH (generic wording when `newPrefix` is null); (a) `npm uninstall -g @codemieai/code --prefix "<active prefix>"`, omitted when the active prefix is null, and replaced by "rerun the CodeMie installer or run `codemie doctor`" when the active prefix `isSamePath` as `getLegacyNpmPrefixPath(platform)` (AR-2: avoids contradicting the doctor check); finish with "then open a new terminal". Keep the wording in this one function so a later doctor check can reuse it.

Test-first: no — tests only on explicit user request (project policy)

## Task 3: Wire the check into `updateCli`

Files: modify `src/utils/cli-updater.ts` (`updateCli`, `:283-329`; add one import near `:22-23`).

- Import `verifyActiveCli` and `formatStaleWarning` only from `./active-cli.js`; add no other new imports, because `cli-updater.test.ts` mocks `processes.js`, `npm-prefix.js` and `paths.js` with full-replacement factories.
- Leave the existing `try { await installGlobal(...) } catch { ... throw error }` and its failure output byte-identical, but move the success output out of the `try` so it runs after the catch. A throw in the check can then never reach the failure branch or exit code 1 (AR-3).
- After the install, call `verifyActiveCli(latestVersion, { withHint: !silent })` inside a second try/catch that logs via `logger.debug` and treats any throw as `unknown`.
- Silent: keep the existing `logger.debug('CodeMie CLI auto-updated ...')` line; for `stale`, add one `logger.debug` line with the active path and both versions; print nothing.
- Non-silent: keep the `✓ ... updated successfully!` and `Current version:` lines. For `current` and `unknown`, print today's dim "takes effect on the next command" line unchanged. For `stale`, replace that line with `formatStaleWarning(verdict)` printed in `chalk.yellow` (commands in `chalk.white`, hints in `chalk.dim`, as elsewhere in the file).
- Do not change `self-update.ts`, the `process.exit(0)` at `:414`, or any exit code.

Test-first: no — tests only on explicit user request (project policy)

## Task 4: Docs

Files: modify `docs/COMMANDS.md:1304`.

Replace "The update takes effect on the next command execution." with "The update takes effect once the `codemie` first on your PATH is the updated install; `codemie self-update` warns when an older install shadows it." Leave `docs/CONFIGURATION.md` unchanged.

Test-first: no — tests only on explicit user request (project policy)

## Self-review

negative-constraints (re-scanned from spec):
- No PATH edits, uninstall or install into the stale prefix: Task 2 only prints hints; no task runs `npm uninstall`.
- No change to `getCommandPath`/`commandExists` or `bin/codemie.js`: no task touches them; Task 2 only calls `getCommandPath`.
- Never spawn `codemie`, never trigger an update check or prompt: Task 2 reads files after `which`/`where.exe` and runs nothing else.
- First hit only: Task 2.
- No change to the failure path, exit codes or `NpmPrefixOverrideCheck`: Task 3 keeps the catch block identical; the doctor check is untouched.
- Non-npm layouts (Volta etc.) fall into `unknown`: Task 2 name/shim checks.
- No start-up or doctor detection: none added.
- Silent mode prints nothing new: Task 3.
