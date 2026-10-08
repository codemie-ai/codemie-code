DONE

Commit: 4e08e92 — feat(utils): derive CodeMie self npm prefix and detect legacy override

Changed paths:
- src/utils/npm-prefix.ts
- src/utils/__tests__/npm-prefix.test.ts

Test command:
```
npx vitest run src/utils/__tests__/npm-prefix.test.ts > docs/superpowers/tasks/2026-09-28-epmcdme-15307/test.local.log 2>&1; echo "EXIT=$?"; tail -25 docs/superpowers/tasks/2026-09-28-epmcdme-15307/test.local.log
```

Test result: RED first (EXIT=1, 19/19 failed — "Cannot find module '/src/utils/npm-prefix.js'"), then GREEN after implementation (EXIT=0, 19/19 passed).

Exported signatures as implemented (match brief verbatim):
- `export const CODEMIE_PACKAGE = '@codemieai/code';`
- `export function deriveSelfPrefix(packageDir?: string, platform?: NodeJS.Platform): string | null`
- `export function getLegacyPrefixPath(platform?: NodeJS.Platform): string`
- `export function isSamePath(a: string, b: string, platform?: NodeJS.Platform): boolean`
- `export async function getUserNpmPrefix(): Promise<string | null>`
- `export async function getSelfPrefixArgs(packageName: string): Promise<string[]>`

Implementation notes:
- `deriveSelfPrefix`'s default `packageDir` walks up from `getDirname(import.meta.url)` via a local `findPackageRoot` (checks `existsSync(path.join(dir, 'package.json'))` at each level; no existing repo helper for this was found).
- `path.win32`/`path.posix` selected by the `platform` argument for both `deriveSelfPrefix` and `isSamePath`, so tests are host-OS-independent for those two functions.
- `getGlobalNpmPrefix` (internal, backs `getSelfPrefixArgs`) memoizes the `npm prefix -g` result (success or failure) in a module-level `Promise` for the lifetime of the module instance.
- `exec()` calls pass `shell: os.platform() === 'win32'`, matching the convention in `src/utils/processes.ts`.

Verification: `npm run typecheck` clean; `npx eslint src/utils/npm-prefix.ts src/utils/__tests__/npm-prefix.test.ts` — no issues; pre-commit hook (lint-staged, typecheck, secrets scan) passed without `--no-verify`.

Concerns:
- Brief didn't specify test coverage for `getUserNpmPrefix` and `getLegacyPrefixPath`; I added tests for these two exported functions beyond the brief's explicit list, for completeness (no behavior invented beyond the brief's spec).
- `getSelfPrefixArgs` and `getUserNpmPrefix` have no `platform`/`packageDir` params (per the fixed interface), so their tests mock `@/utils/paths.js` (`getDirname`) and `fs` (`existsSync`) in addition to `@/utils/exec.js` to make the internal `deriveSelfPrefix()` derivation deterministic — the brief's test description mentioned only the exec mock, so this is a reasonable extension, not a deviation.
