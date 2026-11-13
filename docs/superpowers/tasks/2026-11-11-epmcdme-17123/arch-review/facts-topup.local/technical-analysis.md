# Technical Research — Top-up (facts only)

**Task**: analytics sync bootstrap delivery targets — EPMCDME-17123
**Generated**: 2026-11-11
**Research path**: filesystem (top-up on existing technical-analysis.md)

Scope: names `spec.md` relies on from `src/cli/commands/analytics/sync/install.ts` that the
existing `technical-analysis.md` does not already cover. No new conclusions — facts only.

---

## 1. Original Context (top-up instruction)

> Ticket EPMCDME-17123 — codemie analytics sync bootstrap: choose webhook, git or both as
> delivery targets. Top-up research - record facts only, for the names the spec relies on that
> the analysis does not cover: src/cli/commands/analytics/sync/install.ts. For each: where it is
> defined, what it does today on the path this task changes, and who consumes it.

---

## 2. Exported surface of `install.ts` (consumer-reachable)

`src/cli/commands/analytics/sync/install.ts` exports exactly three names:
`InstallDeps` (interface, line 49), `runInstall` (line 294), `createRealInstallDeps` (line 323).
Every other function in the file — `printSummary`, `resolveInstallEmail`, `printFailure`,
`printGitFailure`, `prepareSettings`, `resolveEmailOrReport`, `testGitTarget`, `PreviousInstall`,
`snapshotPreviousInstall`, `previousRunTime`, `restorePreviousInstall`, `replaceJob` — has no
`export` keyword; `grep -n "^export"` on the file returns only the three names above.

Consumers of the exported surface, repo-wide (`grep -rn "runInstall\|createRealInstallDeps\|InstallDeps" src`):
- `src/cli/commands/analytics/index.ts:138-139` — the only production call site: dynamic `import('./sync/install.js')`, then `process.exitCode = await runInstall(options, createRealInstallDeps())`.
- `src/cli/commands/analytics/sync/__tests__/install.test.ts` — unit tests of `runInstall` via injected `InstallDeps` fakes.
- `src/cli/commands/analytics/__tests__/analytics-sync-cli.test.ts` — CLI-wiring tests that mock the whole module (`runInstall`, `createRealInstallDeps`) to assert option translation.

No other module imports from `install.ts`. **Fact for the spec's "install's existing rule / install's hint / install's resolved identity" language**: none of the module-private functions below can be imported by `bootstrap/*`; bootstrap can only reuse the sibling modules those functions themselves call (`config-store.ts` validators, `identity.ts`, `targets/git-client.ts`, `targets/git-target.ts` — already covered in `technical-analysis.md`), not `install.ts` itself.

---

## 3. Names from `install.ts` the spec's prose points at

### `resolveInstallEmail` / `resolveEmailOrReport` (install.ts:125-137, 165-181) — D9, AC7

Module-private. `resolveInstallEmail(deps)` calls `deps.resolveIdentity()` (wired in
`createRealInstallDeps` to `resolveSyncIdentity(realIdentityDeps)` from `identity.ts:39`,
already in `technical-analysis.md`). On failure:
- no TTY → returns `null`.
- TTY → calls `deps.promptEmail()` (an `inquirer` prompt validated by `EMAIL_REGEX` from
  `identity.ts`), then **`await deps.saveUserEmail(email)`** (wired to
  `ConfigLoader.saveUserEmail`, `install.ts:344`) before returning the email.

`resolveEmailOrReport` wraps this and, when the result is `null`, prints the exact text:
```
No email is configured for analytics sync, and no terminal is attached to ask for one.
Set one with `git config --global user.email <email>`, or run `codemie analytics sync install`
again in a terminal to be prompted.
Nothing was registered.
```
Only consumer: `runInstall` (install.ts:300).

**Fact relevant to D9**: install's prompted email is persisted via `saveUserEmail`/`ConfigLoader`.
Spec D9 requires bootstrap's prompted email NOT to be saved — this is a divergence from
`install.ts`'s own behavior on the same resolver, not an extension of it. `resolveInstallEmail`
itself is not exported and not reusable as-is for a no-save variant.

### `testGitTarget` (install.ts:190-203) — D1, AC6, AC8, AC9

Module-private. No-ops (`return true`) when `settings.git === undefined`. Otherwise:
calls `deps.testGitPush(settings.git, email)` (wired to
`new GitTarget(git, email, createGitRunner()).testPush()`, install.ts:347 — `GitTarget`/`createGitRunner` already covered). On throw: calls `printGitFailure(deps, err)`, then
`await deps.removeWorkingCopy().catch(() => undefined)` (wired to
`rm(gitWorkingCopyPath(), { recursive: true, force: true })`, install.ts:348), returns `false`.
Only consumer: `runInstall` (install.ts:307), which returns exit code 1 immediately on `false`,
never reaching `replaceJob`.

**Fact**: `GitTarget` here is constructed with no `dir` override, so `testGitTarget`'s working
copy is always the developer's real `gitWorkingCopyPath()` (`~/.codemie/analytics-sync-repo`) —
the same path `run-sync.ts`/`uninstall.ts` use. The spec's D1 temporary-working-copy requirement
for bootstrap (`GitTarget`'s existing `dir` constructor override) is therefore a different call
shape than `install.ts` makes today, not a reuse of `testGitTarget` itself.

### `printGitFailure` / `printFailure` (install.ts:139-150) — AC9, "install's hint for that failure"

Module-private. `printFailure` prints `Install failed: ${errorMessage(err)}`. `printGitFailure`
calls `printFailure`, then, only `if (err instanceof SyncGitError)`, prints
`gitHint(err.gitCause)` (`gitHint` exported from `targets/git-client.ts`, already covered in
`technical-analysis.md:44`). Consumers: `testGitTarget` only.

**Fact**: the "install's hint" the spec's AC9 refers to is this `instanceof SyncGitError` →
`gitHint(err.gitCause)` pairing. `gitHint` itself is exported and importable by bootstrap;
`printGitFailure` (the wrapper that decides when to call it) is not.

### `prepareSettings` / `replaceJob` / `snapshotPreviousInstall` / `restorePreviousInstall` / `previousRunTime` / `printSummary` (install.ts:77-292)

Module-private, scheduler/settings-file orchestration (validate options → platform preflight →
snapshot previous install → unregister/write/register → restore on failure → print summary).
Only consumer: `runInstall`. None of these names appear in `spec.md`'s Approach/Decisions text,
and `spec.md`'s Non-goals (NG1) states developer-side `install` itself is unchanged — recorded
here only to confirm none of them is a reusable export bootstrap needs.

---

## 4. Summary for complexity assessment (top-up)

No new risk beyond what `technical-analysis.md` already flags. The one fact this top-up adds:
`install.ts` exports only `InstallDeps`/`runInstall`/`createRealInstallDeps`, so every bootstrap
reuse the spec describes in `install`'s terms ("install's existing rule", "install's resolved
identity", "install's hint for that failure") resolves to sibling-module exports
(`config-store.ts`, `identity.ts`, `targets/git-client.ts`, `targets/git-target.ts`) that
`install.ts` itself calls — not to anything inside `install.ts` being imported. The one behavior
difference worth flagging for the spec/plan: `install.ts`'s own prompted-email path
(`resolveInstallEmail`) saves the email via `ConfigLoader.saveUserEmail`; D9 requires bootstrap's
prompt not to save, which is new behavior on the same resolver, not a call into `install.ts`.
