# EPMCDME-15769 Stale codemie path repair Implementation Plan

**Goal:** On the `already_exists` branch of `BaseExtensionInstaller.install()`, rewrite hooks.json commands whose leading absolute codemie path no longer exists, without a PATH lookup unless something is stale.

**Architecture:** New stale-repair helpers in `src/utils/hook-command.ts`, deliberately separate from `resolveHookCommand` (existing `hook-command.test.ts` asserts a nonexistent `/usr/local/bin/codemie hook` is left unchanged, and migration 006 / `codemie-code.plugin.ts` share it, so those stay untouched). Wired into the base installer, so Claude, Gemini and Kimi all get it.

**Conventions:** Commit per task using the repository's existing convention (`fix(agents): ...`, no Co-Authored-By line). Never stage `.codemie/codemie-cli.config.json`. Never run a real codemie binary. ES modules, `.js` import extensions, `logger` not `console`. Tests use `@group unit` and must not depend on host path semantics (inject the exists predicate; recognise `C:/` by regex, not `path.isAbsolute`). The calling flow runs the gates afterwards (`npm run lint`, `npm run typecheck`, `npx vitest run --project unit`, `npx vitest run --project cli`); they are not tasks here.

negative-constraints: bare `codemie`, relative paths and other programs never changed (Task 1 recogniser + tests); existing path never rewritten and no write (Task 2); no PATH lookup unless stale (Task 2 spy test); never rewrite to bare `codemie` fallback (Task 2); no warn on missing hooks.json (Task 2); `resolveHookCommand` semantics unchanged (Task 1).

---

### Task 1: Stale-path helpers in hook-command.ts

**Files:** modify `src/utils/hook-command.ts` (append after `rewriteHooksCommandTree`, L129); modify `src/utils/__tests__/hook-command.test.ts`.

**Test-first: yes — `hasStaleCodemieCommand` returns true for `/gone/codemie hook` with exists=()=>false and false when exists=()=>true; `repairStaleHooksCommandTree` rewrites `"/gone dir/codemie" hook` and `"C:/n/node.exe" "C:/n/codemie.js" hook` keeping args, and leaves bare `codemie`, `./codemie hook`, `/usr/bin/other hook`, `"C:/n/node.exe" "C:/n/other.js" hook` unchanged.**

- [ ] Add exported helpers (new symbols, full signatures only):

```ts
export type PathExists = (p: string) => boolean;
export function hasStaleCodemieCommand(node: unknown, exists?: PathExists): boolean;
export function repairStaleHooksCommandTree(node: unknown, binary: string, exists?: PathExists): boolean;
```

  `exists` defaults to `existsSync` from `fs`. Both reuse one private `staleCodemiePrefixLength(command, exists): number` (0 = not stale) and walk the tree the same shape-agnostic way as `rewriteHooksCommandTree` (string `command` fields only).
- [ ] `staleCodemiePrefixLength` rules: token = quoted (up to closing `"`) or up to first space, unquoted of quotes, backslashes normalised to `/`. Absolute = starts with `/` or matches `^[A-Za-z]:/` (no `path` module). Codemie basename = `codemie`, `codemie.cmd`, `codemie.exe` (stale if `!exists(token)`). Windows pair: first token absolute with basename `node`/`node.exe`, second quoted token absolute with basename matching `/^codemie[^/]*\.[cm]?js$/i`; stale if either path is missing, prefix covers both tokens. Anything else returns 0.
- [ ] `repairStaleHooksCommandTree` replaces the prefix with `binary` and keeps the remainder; it returns the changed flag and mutates in place.
- [ ] Run `npx vitest run --project unit src/utils/__tests__/hook-command.test.ts`; confirm the existing `resolveHookCommand` tests still pass unchanged.

### Task 2: Wire repair into the already_exists branch

**Files:** modify `src/agents/core/extension/BaseExtensionInstaller.ts` (else-branch at L698-700; new protected method next to `localizeInstalledHooks` at L522); modify `src/agents/core/extension/__tests__/BaseExtensionInstaller.hooks.test.ts`.

**Test-first: yes — install with codemie at real temp file A (getCommandPath mock returns A) -> `copied`; delete A, change the mock to a second existing temp file B, install again -> `already_exists` and every hooks.json command (`hook`, `sound SessionStart`) now starts with B.**

- [ ] Add `protected async repairStaleHooks(targetPath: string): Promise<void>` and call it from the `already_exists` else-branch after the existing skip log. Same dynamic-import and try/catch/`logger.warn` non-fatal shape as `localizeInstalledHooks`, but:
  - read `<target>/hooks/hooks.json`; on `ENOENT` return silently (Kimi, every start); other errors warn;
  - `if (!hasStaleCodemieCommand(parsed.hooks)) return;` before any `resolveCodemieBinary()` call, so no PATH lookup and no write when fresh;
  - after resolving, if `binary === 'codemie'` log at debug and return (do not rewrite stale paths to the bare fallback);
  - otherwise `repairStaleHooksCommandTree`, write with `JSON.stringify(parsed, null, 2)` only if changed, `logger.info` the repair.
- [ ] Extend the hooks test file (reuse its `TestInstaller` pattern; create real temp codemie files, with `getCommandPath` as a `vi.fn()` whose mock is reassigned between installs):
  - stale case above (failing test);
  - fresh case: existing A, second install leaves the file byte-identical and `getCommandPath` call count unchanged after the second install (spy proves no PATH lookup and no write);
  - bare fallback: stale A, `getCommandPath` rejects and `process.argv[1]` stubbed empty -> file unchanged;
  - Kimi-style: source without `hooks/hooks.json`, manifest and critical files only, install twice; assert `logger.warn` (mock `../../../../utils/logger.js`) is not called on the second run;
  - non-codemie commands (`/usr/bin/other hook`, relative, bare) untouched alongside a stale one.
- [ ] Mutation check: temporarily remove the `repairStaleHooks(targetPath)` call from the `already_exists` branch, run `npx vitest run --project unit src/agents/core/extension/__tests__/BaseExtensionInstaller.hooks.test.ts src/utils/__tests__/hook-command.test.ts`, and confirm the stale-rewrite test fails (and, with `repairStaleHooksCommandTree` stubbed to `return false`, the Task 1 rewrite tests fail). Restore both and re-run until green. Do not commit the mutation.
- [ ] Note for reviewer: the existing `localizeInstalledHooks` still warns on ENOENT during a Kimi `copied`/`updated` install (pre-existing, untouched).
