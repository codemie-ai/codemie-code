# Technical Research (top-up): src/utils/active-cli.ts

**Research path**: filesystem. Facts only.

## Codebase Findings

### Definition
`src/utils/active-cli.ts` (255 lines). Header: after a self-update, the first `codemie` on PATH may be an older install; it never spawns `codemie`, only PATH lookup and file reads.

### What it does today
- **Lookup (first match only)**: `lookupCommandPath()` (l.61-73) calls `getCommandPath('codemie', 5000)` raced against a `setTimeout` of `LOOKUP_TIMEOUT_MS = 5000` (l.26). The same deadline is passed to `getCommandPath` so the child is killed. `getCommandPath` (`src/utils/processes.ts:53-83`) runs `C:\Windows\System32\where.exe $PATH:codemie` (or `which`) and returns `paths[0]`, discarding the rest of the `where` output. It returns null on any failure. The command name is hardcoded `'codemie'`, and the package name `@codemieai/code` is hardcoded (l.25).
- **Package resolution** `resolvePackage(hit, platform)` (exported, l.96): on win32 it reads the shim file, requires the text to match `@codemieai[\\/]code`, and derives the package dir via `getCodemiePackageDir(dirname(hit))`. Otherwise it does `realpath` and `findFirstManifest` (exported, l.76; walks up to the first package.json).
- **`findActiveCli(platform)`** (exported, l.124) returns `{status:'found', active:{path, version, prefix}}` or `{status:'unknown', reason}`. It never throws. Reasons: timeout, not found on PATH, not an npm install of @codemieai/code, unreadable package.json, different package name, no readable version, inspect error.
- **Verdicts** `verifyActiveCli(installedVersion, {withHint})` (exported, l.174) returns `ActiveCliVerdict`:
  - `current`: active version >= installed (`compareVersions`).
  - `stale`: active < installed. Carries `installedVersion` and `newPrefix`. `newPrefix` comes from `getCodemieOrGlobalNpmPrefix()` only when `withHint` is set (this may spawn `npm`).
  - `unknown`: invalid or prerelease semver on either side, or any `findActiveCli` unknown. Logged via `logger.debug`. Never throws.
  - The verdict compares versions of the same package. It does not compare two install locations.
- **Wording** `formatStaleWarning(verdict, platform)` (exported, l.221) returns string lines: "⚠ The codemie on your PATH is older than the version just installed.", Active/Installed lines, then `- Put "<newBinDir>" ahead of "<dirname(active.path)>" on your PATH`. When `newPrefix` is null it reads "Put the bin directory of the new install ahead of ...". If `active.prefix` is set: the legacy prefix gives "Or rerun the CodeMie installer, or run `codemie doctor`", otherwise "Or remove the old install: npm uninstall -g @codemieai/code --prefix ...". It ends with "Then open a new terminal." The text is codemie-specific and "older than" based.
- Types exported: `ActiveCli`, `ActiveCliLookup`, `ActiveCliVerdict`.

### Consumers (grep of `src`)
- `src/utils/cli-updater.ts:26,334,355`: `verifyActiveCli(latestVersion, {withHint: !silent})` after a successful self-update, then prints `formatStaleWarning(verdict)`.
- `src/cli/commands/proxy/connect-orchestrator.ts:87,664`: `verifyActiveCli(ownVersion)`.
- `src/cli/commands/proxy/analytics-delivery-lines.ts:8,102,103,112,132`: `findActiveCli`, `findFirstManifest`, `resolvePackage`.
- Tests: `src/utils/__tests__/active-cli.test.ts` (14 describe/it blocks, imports only `findActiveCli`, `findFirstManifest`, `resolvePackage`; no `verifyActiveCli` or `formatStaleWarning` import found). `src/cli/commands/proxy/__tests__/index.test.ts:103-105,2382-2385` partially mocks `findFirstManifest`.
- Original design: `docs/superpowers/tasks/2026-11-07-epmcdme-16080-self-update-path-check/` (plan notes `cli-updater.test.ts` mocks `processes.js`, `npm-prefix.js`, `paths.js` with full-replacement factories).

## Task Statements Checked Against the Code
- "first-match lookup": holds. `getCommandPath` returns only `paths[0]`. A full ordered `where.exe` list does not exist today (spec says a new helper in `processes.ts`).
- "current/stale/unknown verdicts": holds, but the stale axis is version-older for `codemie` only. There is no "shadowed by another copy" state.
- "unknown is exactly AC8's behaviour": holds. Every failure path, including timeout, maps to `unknown` and never throws.
- "put X ahead of Y wording": holds. It is inside `formatStaleWarning`, hardcoded to codemie and to the "older than just installed" headline.
- "5000 ms deadline pattern": holds. `LOOKUP_TIMEOUT_MS` is module-private (not exported) and `lookupCommandPath` is private and bound to `'codemie'`.
- "shared with the existing check": no shared shadow function exists today. Reuse would touch the exported `ActiveCliVerdict` type, which three modules consume.

## Risk Indicators
- Speculative: widening `ActiveCliVerdict` or `formatStaleWarning` affects `cli-updater.ts`, `connect-orchestrator.ts` and `analytics-delivery-lines.ts`.
- Speculative: `verifyActiveCli` and `formatStaleWarning` have no direct tests in `active-cli.test.ts`, so a refactor of them has no existing coverage there. `cli-updater.test.ts` was not read.
- `resolvePackage` on win32 can throw (the test at l.82 expects `rejects`). `findActiveCli` catches it, but a direct caller (`analytics-delivery-lines.ts:103`) would see it.
- Windows detection reads the shim text for `@codemieai/code`, so other agents' shims would be reported "not an npm install of @codemieai/code".
