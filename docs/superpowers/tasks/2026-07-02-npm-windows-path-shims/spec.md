# npm Windows PATH / bin shims fix — design

**Ticket**: EPMCDME-13191
**Date**: 2026-07-02
**Related**: `docs/superpowers/tasks/2026-07-02-npm-windows-path-shims/technical-analysis.md`

## Problem

`npm install -g @codemieai/code` on Windows does not put `codemie` on the user's PATH, and Claude Code hooks that shell out to `codemie` fail with `command not found` as a result. `scripts/postinstall.mjs` is Unix-only today: it assumes npm places global shims in `<prefix>/bin` (true on Unix, false on Windows — npm places them directly in the prefix dir on Windows), splits `PATH` on `:` only, and falls back to appending a shell RC file that doesn't exist on Windows. The curl-based installer (`install/windows/install.ps1`) already solves this correctly for its own isolated install flow, but the plain npm global install path was never fixed to match.

## Scope decision

The fix targets **npm's own, unmanaged global prefix** — it does not redirect `npm install -g` into an isolated `%LOCALAPPDATA%\CodeMie` prefix the way `install.ps1` does. `postinstall.mjs` runs after npm has already installed into whatever prefix is active; it only needs to correctly detect that prefix's shim directory and get it onto the Windows user PATH. npm's own auto-shim mechanism (`package.json` `"bin"` field) already generates `codemie.cmd`, `codemie-claude.cmd`, etc. in that directory — this fix does not create or copy shim files itself, only verifies they exist as a diagnostic.

## Design

### Reuse, not duplication

`src/utils/windows-path.ts` (compiled to `dist/utils/windows-path.js`, shipped in the package `files`) already implements registry-backed `isInUserPath(dir)` / `addToUserPath(dir)` with path validation, tested in `src/utils/__tests__/windows-path.test.ts`. `postinstall.mjs` will dynamically import and reuse these rather than re-implementing PATH persistence a third time (a second, independent implementation already exists in `install.ps1` via .NET's `SetEnvironmentVariable`; a fourth is out of scope). This makes `postinstall.mjs` async (top-level, via a `run()` function — `.mjs` supports top-level `await`).

### Exported functions

```js
export function getNpmPrefix()                        // execSync('npm config get prefix'); try/catch -> null on failure
export function getShimDir(prefix, plat = platform())  // win32: prefix itself; else: join(prefix, 'bin')
export function isInPath(dir)                          // process.env.PATH split on path.delimiter (unix check only)
export function getShellRcFile()                       // unchanged — unix only, null on win32 (no $SHELL)
export function alreadyInRcFile(rcFile, dir)            // unchanged — substring guard against duplicate RC entries
export function getExpectedShimNames()                  // Object.keys(package.json "bin") — resolved via readFileSync + JSON.parse against a path relative to postinstall.mjs, not import()/require of package.json (avoids ESM JSON-import ceremony)
export function findMissingShims(dir, names)            // win32 only: names whose `${name}.cmd` doesn't exist in dir
export async function runWindows()                      // orchestrates the windows path (below)
export function runUnix()                                // orchestrates the existing unix path (unchanged logic + delimiter fix)
export async function run()                              // platform() === 'win32' ? runWindows() : runUnix()
```

A direct-execution guard (`fileURLToPath(import.meta.url) === process.argv[1]`) wraps the top-level `run()` call, so importing the module in tests doesn't trigger side effects. This is the "export before test" refactor the ticket requires — today the file has zero exports and runs entirely via top-level statements.

### Windows flow (`runWindows`)

1. `prefix = getNpmPrefix()`. If `null`, return (matches today's silent no-op on failure).
2. `dir = getShimDir(prefix)` — the prefix itself, no `bin/` join.
3. `missing = findMissingShims(dir, getExpectedShimNames())`. If non-empty, `console.warn` listing them — diagnostic only, never blocks the rest of the flow.
4. Dynamically `import('../dist/utils/windows-path.js')` and call `isInUserPath(dir)`.
5. If already in PATH, return (no-op, exit 0).
6. Otherwise call `addToUserPath(dir)`.
   - `success: true` → `console.log` confirming the addition and that a new terminal is needed. Exit 0.
   - `success: false` → `console.error` the returned `error` plus a manual fallback instruction (`setx PATH "%PATH%;<dir>"` or System Properties), then exit **1**. This is the one failure mode that's both actionable and would otherwise fail silently for the user (`codemie` staying unreachable with no visible signal) — see "Exit policy" below.
7. All other failure modes in this script (missing npm prefix, missing shim files) stay non-fatal — see "Exit policy".

### Unix flow (`runUnix`)

Identical to the current logic (`getNpmPrefix` → `getShimDir` = `join(prefix, 'bin')` → `isInPath` → `getShellRcFile` → `alreadyInRcFile` → `appendFileSync`), with the only change being `isInPath` splitting on `path.delimiter` instead of a hardcoded `':'`. `path.delimiter` is `':'` on POSIX, so this is behaviorally a no-op — it just removes the incorrect hardcoded assumption from the shared function.

### Error handling

**Exit policy** — deliberately asymmetric, based on whether the failure is actionable and would otherwise be silent:

| Failure | Behavior |
|---|---|
| `getNpmPrefix()` fails (npm itself unusable) | `console.warn`, exit 0 — not fixable by retrying this script |
| `findMissingShims()` non-empty | `console.warn`, exit 0 — diagnostic only; shim generation is npm's own responsibility, not this script's |
| `addToUserPath()` returns `success: false` | `console.error` the error + manual `setx` fallback instructions, exit **1** |
| `addToUserPath()` succeeds, or already in PATH | `console.log` confirmation (or silent no-op), exit 0 |

Only the `addToUserPath` failure exits non-zero. It's the one case that's both actionable (the user can fix it, e.g. run the `setx` command themselves or check registry permissions) and otherwise invisible — `codemie` would silently stay unreachable with no forcing signal, since a `console.warn` buried in npm's install output is easy to miss. The other failure modes either aren't fixable by re-running this script (npm itself broken) or are purely diagnostic (missing shims are npm's `bin`-field responsibility, not this script's to fix). Failing `npm install -g` over those would be misleading — it would suggest the install failed when the package installed fine.
- No new error classes needed — this is a lifecycle script, not application code; it follows its own existing console-message convention rather than the `src/` error-class convention.

### Testing

New `scripts/__tests__/postinstall.test.ts`. Conventions follow `.ai-run/guides/testing/testing-patterns.md` and the closest existing precedents (`src/utils/__tests__/windows-path.test.ts`, `cli-bin.test.ts`):

- Mock `node:child_process` (`execSync`) directly via `vi.mock('node:child_process', ...)` — new territory for this repo (existing precedents mock through the `src/utils/exec.ts` wrapper instead, which `postinstall.mjs` does not use for `npm config get prefix`).
- Mock the dynamic `../dist/utils/windows-path.js` import via `vi.mock` factory, so `runWindows()` can be unit-tested without touching the real Windows registry.
- Toggle `process.platform` via `Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })` per the `windows-path.test.ts` precedent; restore in `afterEach` with `vi.restoreAllMocks()`.
- Dynamic `import()` of the module under test after mock/spy setup (static imports bypass spies due to hoisting — mandatory per the testing guide).

Test cases:

| Case | Mocks |
|---|---|
| Windows: `getShimDir()` returns prefix directly (no `/bin` suffix) | `execSync`, `platform` |
| Unix: `getShimDir()` returns `prefix/bin` | `execSync`, `platform` |
| PATH check splits on `path.delimiter` (`;` win32 / `:` unix) | `process.env.PATH` |
| Windows: `runWindows` never touches RC-file logic | `platform` |
| Unix: `getShellRcFile` selects `.zshrc` / `.bash_profile` / `.bashrc` correctly | `process.env.SHELL`, `existsSync` |
| Already in user PATH (win32) → no-op, `addToUserPath` never called | mocked `isInUserPath` → `true` |
| Not in PATH (win32) → `addToUserPath` invoked, success path logs confirmation | mocked `isInUserPath` → `false`, `addToUserPath` → `{success:true}` |
| `addToUserPath` failure (win32) → manual fallback instructions printed, exits 1 | mocked `addToUserPath` → `{success:false, error}`, `process.exit` |
| Not in PATH (unix) → RC file is appended | `existsSync`, `appendFileSync` |
| Missing shim file (win32) → warning logged, PATH logic still runs | `existsSync` returns false for one shim name |

`vitest.config.ts`: add `'scripts/**/*.test.ts'` to `test.include`. No coverage-`exclude` change — `postinstall.mjs` picking up coverage from its own new test is desirable, not a gap.

## Out of scope

- Redirecting `npm install -g` into an isolated `%LOCALAPPDATA%\CodeMie` prefix (that remains the curl installer's job).
- The hook executor's hardcoded `spawn("sh", ...)` in `src/agents/plugins/codemie-code-hooks/shell-hooks-source.ts` (a related but distinct Windows gap — no `sh` binary on Windows regardless of PATH state). Flagged as a candidate follow-up ticket, not addressed here.
- `install/windows/install.cmd`'s known quoted-path-with-spaces bug (unrelated, pre-existing).
- Any change to `install/windows/install.ps1`, `install/macos/install.sh`, or `src/utils/native-installer.ts`.
