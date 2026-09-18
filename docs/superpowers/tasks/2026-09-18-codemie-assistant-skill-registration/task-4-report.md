DONE

## Commit

`6c8f219bb1` — feat(cli): fail fast on partial assistant/skill registration

## Changed files

- `src/utils/errors.ts` — added `PartialRegistrationError`
- `src/cli/commands/shared/helpers.ts` — added `executeWithSpinnerStrict` and `registerAllOrAbort`
- `src/cli/commands/shared/__tests__/registration-writes.test.ts` — new, failing-first
- `src/cli/commands/assistants/setup/helpers.ts` — `registerAssistant` switched to strict spinner, non-nullable return
- `src/cli/commands/assistants/setup/index.ts` — register loop replaced with `registerAllOrAbort`; `if (!fullAssistant) continue` replaced with thrown `RegistrationItemNotFoundError`
- `src/cli/commands/skills/setup/helpers.ts` — `registerSkill` switched to strict spinner, non-nullable return
- `src/cli/commands/skills/setup/index.ts` — register loop replaced with `registerAllOrAbort`
- `src/cli/commands/assistants/setup/__tests__/helpers.test.ts` — amended (see below)

## Test commands

```
npx vitest run --project unit src/cli/commands/shared/__tests__/registration-writes.test.ts src/cli/commands/assistants/setup/__tests__/index.test.ts
```
EXIT=0 (2 files, 35 tests passed)

```
npx vitest run --project unit src/cli/commands/shared src/cli/commands/skills/setup/__tests__ src/cli/commands/assistants/setup/__tests__
```
EXIT=0 (11 files, 173 tests passed)

`npx tsc --noEmit`: EXIT=0 (clean).

RED was observed first for `registration-writes.test.ts`: all 6 tests failed with `TypeError: executeWithSpinnerStrict is not a function` / `registerAllOrAbort is not a function` — the expected reason (exports did not exist yet) — before any implementation was written.

## Exported signatures (for Tasks 5-6)

```ts
// src/cli/commands/shared/helpers.ts
export async function executeWithSpinnerStrict<T>(
  spinnerMessage: string,
  operation: () => Promise<T>,
  successMessage: string,
  errorMessage: string,
  onError?: (error: unknown) => void
): Promise<T>;

export async function registerAllOrAbort<TItem, TResult>(
  items: TItem[],
  nameOf: (item: TItem) => string,
  writeOne: (item: TItem) => Promise<TResult>
): Promise<TResult[]>;

// src/utils/errors.ts
export class PartialRegistrationError extends CodeMieError {
  constructor(
    public readonly written: string[],
    public readonly cause: unknown
  );
}
```

`registerAllOrAbort` writes sequentially (no `Promise.all`), stops at the first rejection, and throws `PartialRegistrationError` naming (in `written`) only the items successfully written before the failure — not the failing item, not any unattempted ones. No rollback of already-written artifacts.

`executeWithSpinnerStrict` behaves exactly like `executeWithSpinner` on success, and on failure stops the spinner, calls `onError` if provided, then rethrows the original caught error unchanged (not wrapped).

## New return types

- `registerAssistant(...)`: `Promise<CodemieAssistant | null>` → `Promise<CodemieAssistant>`
- `registerSkill(...)`: `Promise<CodemieSkill | null>` → `Promise<CodemieSkill>`

Both now throw (via `executeWithSpinnerStrict`) instead of returning `null` when the underlying generator calls fail.

## Pre-existing test amended

`src/cli/commands/assistants/setup/__tests__/helpers.test.ts`:
- `registerAssistant > should return null on registration error` → renamed `should throw on registration error`; now asserts `await expect(registerAssistant(...)).rejects.toThrow('Registration failed')` instead of `expect(result).toBeNull()`.
- `registerAssistant > should handle skill registration error` → same treatment, asserts the rejection instead of `toBeNull()`.

Both were codifying the null-swallowing defect this task removes; the `logger.error` assertions in both were kept unchanged since that behavior is preserved (`onError` still fires before the rethrow).

No test in `skills/setup/__tests__/` needed amendment — there is no pre-existing `registerSkill`-specific test file in that directory (only `data.test.ts` and `sync-plugin.test.ts`, both untouched and passing).

## Known non-goals left alone (per binding rulings)

- `registerSkill`'s slug computation/mismatch defect in `skills/setup/helpers.ts` — untouched. Because the strict spinner's inferred type there is `string | undefined` (the operation can leave `slug` unset when no target branch executes), the return-object assignment uses `slug: result!` to satisfy `CodemieSkill.slug: string` without changing the underlying slug logic — this preserves the existing (defective) behavior rather than fixing it.
- No rollback logic added to `registerAllOrAbort` — explicit spec non-goal.
- `Task 1-3` files (`headless.ts`, `identifier-resolution.ts`, `data.ts` for both fetchers) were not touched.
- Did not restructure `setupAssistants`/`setupSkills`; edits confined to the register-loop region and the two `helpers.ts` files, leaving room for Tasks 5-6's headless branches.

## Concerns

None. All required gates green: both specified test commands at EXIT=0, `tsc --noEmit` clean, pre-commit hook (eslint --max-warnings=0, vitest, typecheck, gitleaks secret scan) passed without `--no-verify`, and `git show --stat HEAD` lists exactly the 8 files declared/expected (7 from the brief plus the amended pre-existing test, which was called out as acceptable in the task instructions).
