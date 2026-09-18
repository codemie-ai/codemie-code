DONE

- Commit: fa66da5455 — "feat(cli): add headless mode detection and flag validation helpers"
- Changed files:
  - src/cli/commands/shared/headless.ts (new)
  - src/cli/commands/shared/__tests__/headless.test.ts (new)
  - src/utils/errors.ts (modified — appended two classes after `AnalyticsSourceError`, before `NpmErrorCode`)

Test command:
```
npx vitest run --project unit src/cli/commands/shared/__tests__/headless.test.ts > /Users/Nikita_Levyankov/repos/codemie-ai/codemie-code/docs/superpowers/tasks/2026-09-18-codemie-assistant-skill-registration/test.local.log 2>&1; echo "EXIT=$?"; tail -25 /Users/Nikita_Levyankov/repos/codemie-ai/codemie-code/docs/superpowers/tasks/2026-09-18-codemie-assistant-skill-registration/test.local.log
```
Final result: `EXIT=0` — 14/14 tests passed.

TDD sequence followed:
1. Wrote the test file first (14 assertions covering all `isHeadlessMode` branches, `requireFlag`, `parseScopeFlag`, `parseListFlag`).
2. Ran the suite — RED confirmed for the expected reason: `Cannot find module '../headless.js'`.
3. Implemented the two error classes in `src/utils/errors.ts` and the four helpers in `src/cli/commands/shared/headless.ts`.
4. Re-ran — GREEN: `EXIT=0`, 14 passed.

`npx tsc --noEmit` — clean (exit 0, no output).
`npx eslint` on the three changed files — clean (no output).
Pre-commit hook (typecheck + lint + gitleaks via lint-staged) passed without `--no-verify`.

Signatures exported (verbatim, matching the brief's signature block):

`src/cli/commands/shared/headless.ts`:
```ts
export interface HeadlessFlags { yes?: boolean; scope?: string; agent?: string; assistant?: string; skill?: string; mode?: string }
export function isHeadlessMode(flags: HeadlessFlags, isTty: boolean): boolean
export function requireFlag(value: string | undefined, flagName: string): string
export function parseScopeFlag(value: string): StorageScope
export function parseListFlag(value: string): string[]
```

`src/utils/errors.ts`:
```ts
export class RegistrationItemNotFoundError extends CodeMieError {
  constructor(kind: 'assistant' | 'skill', identifier: string)
}
export class AmbiguousIdentifierError extends CodeMieError {
  constructor(kind: 'assistant' | 'skill', identifier: string, candidates: { id: string; name: string }[])
}
```
`AmbiguousIdentifierError` message lists each candidate as `name (id)`, joined with `, `, per the brief.

Concerns: none. `git show --stat HEAD` lists exactly the three files declared in the brief. No other files under `src/cli/commands/assistants/`, `src/cli/commands/skills/`, or `src/cli/commands/shared/helpers.ts` were touched.
