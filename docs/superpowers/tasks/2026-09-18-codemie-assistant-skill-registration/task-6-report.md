DONE

## Commit

`de2370b6d6` — feat(cli): add headless branch to setup skills

## Changed files

- `src/cli/commands/skills/setup/index.ts` (modified — factory options, `setupSkills` dispatch, `setupSkillsHeadless`, `printSkillsNotice`, `applySkillChanges`, `getFullSkills`)
- `src/cli/commands/skills/setup/__tests__/headless.test.ts` (new)

No pre-existing test file needed amending — I searched the repo for any test asserting an exact `.options.toHaveLength(N)` count against `createSkillsSetupCommand()` (or its output wired into `setup.ts` / `AgentCLI.ts`) and found none. The only such assertions in the repo are on the assistants factory (already updated in Task 5) and on unrelated modules (plugin loaders, skill discovery, etc.).

## Test commands

```
npx vitest run --project unit src/cli/commands/skills/setup/__tests__/headless.test.ts src/cli/commands/skills/setup/__tests__/data.test.ts
EXIT=0  (2 files passed, 19 tests passed)
```

```
npx vitest run --project unit
EXIT=0  (283 files passed, 4096 tests passed)
```

`npx tsc --noEmit` — EXIT=0, clean.

No pre-existing unrelated failures were found in the full-suite run.

## Flags added to `createSkillsSetupCommand`

- `--skill <ids>` — "Skill identifier(s) to register, comma-separated (id or exact name); enables non-interactive mode"
- `--scope <scope>` — "Storage scope for non-interactive registration: global or local"
- `-y, --yes` — "Run non-interactively, skipping all prompts"

(`--agent` already existed and was not re-declared, per binding ruling #1. No `--mode` flag on the skills side.)

Descriptions are inline plain strings, matching the existing convention in `createSkillsSetupCommand` (no MESSAGES table was introduced).

## `setupSkillsHeadless` signature

```ts
export async function setupSkillsHeadless(options: SetupCommandOptions, hostAgent?: TargetAgent): Promise<void>
```

`SetupCommandOptions` (exported) = `{ profile?: string; agent?: string; verbose?: boolean; skill?: string; scope?: string; yes?: boolean }`.

Pre-flight order matches the assistants side: resolve `profileName` → validate `--skill`/`--scope`/`--agent` via `requireFlag`/`parseScopeFlag`/`parseListFlag` → print the informational notice → `ConfigLoader.load` → `getAuthenticatedClient` → `ConfigLoader.loadSkillsByScope` (registered set, scoped) → `createSkillDataFetcher` → `fetchAllVisibleSkills` (catalog) → `resolveIdentifiers('skill', …)` → `parseAgentSetupTarget(options.agent)` → writes (`registerAllOrAbort`) → `saveSkillsToProjectConfig`. An unresolvable identifier throws `RegistrationItemNotFoundError` from `resolveIdentifiers`, before any register/unregister/save call.

## Purely-additive guarantee

Mirrors the assistants-side fix exactly: the already-registered set passed into `determineChanges` (via the new `applySkillChanges` helper) is scoped down to `registeredInScope = registeredSkills.filter(s => selectedIdSet.has(s.id))` — the overlap with the request. Every registered skill outside that overlap (`untouchedRegistered`) is withheld from the change computation entirely and spliced back into the saved list afterward, unchanged: `updatedSkills = [...untouchedRegistered, ...newlyRegistered]`. Since `registeredInScope` is already restricted to selected ids, `determineChanges`'s `toUnregister` is structurally always empty for entries outside the request, and requested-but-already-registered skills go through a scoped reregister (unregister + register) cycle only — never an unscoped one.

Proven by the test `is purely additive: an already-registered skill not named in --skill is never unregistered and survives the save` in `headless.test.ts`, which registers only `id-1` while an untouched `id-3` sits in the registered set, then asserts `unregisterSkill` was never called with `id-3` and that `saveSkillsToProjectConfig` was called with `id-3` still present.

## `setRawMode` guard

Confirmed via two tests: the main "registers every requested skill…" test spies `process.stdin.setRawMode` and asserts it was never called, and a dedicated "prints the skills notice through console.log without gating on a keypress" test asserts the same plus checks the notice text (`"Skills are installed without tools or MCP servers"`) appears in `console.log` output. The headless path calls a new `printSkillsNotice()` function (plain `console.log` calls, no `process.stdin` interaction at all) instead of the interactive `showDisclaimer()`, which is untouched.

## Concerns

None. Both test commands and the full suite are green, `tsc --noEmit` is clean, `eslint` on the changed files is clean, and the pre-commit hook (typecheck, lint, tests, secrets scan) passed without `--no-verify`.
