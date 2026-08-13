# Fail-fast non-interactive SSO re-authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the CLI from hanging (and crashing with `ERR_USE_AFTER_CLOSE`) when SSO re-authentication is needed but no TTY is available, by short-circuiting the interactive `inquirer` prompt at the single shared auth-failure gate.

**Architecture:** Add one small, pure, mockable utility (`isNonInteractiveEnvironment()`) that reads `process.stdin.isTTY`. Call it from inside `handleAuthValidationFailure` — the one function all three auth-failure call sites (`AgentCLI.handleRun`, `cli/commands/profile/index.ts`, `utils/auth.ts:getAuthenticatedClient`) already funnel through — so a single edit fixes every caller and every current/future `ProviderSetupSteps` provider at once. No caller-side code changes, no new CLI flag, no `CI` env var check.

**Tech Stack:** TypeScript (ES modules), Vitest (unit tests, `vi.mock`/`vi.spyOn`), existing `chalk` for console output.

---

## Scope Note

Per the spec's "Design" section, `sso.setup-steps.ts`, `AgentCLI.ts`, and `utils/auth.ts` are explicitly **not modified** — they already handle a `false`/failed result from `handleAuthValidationFailure` correctly today (`process.exit(1)` / `ConfigurationError`). The spec's Testing section lists their auth-failure branches under "Testing" as paths the fix should *cover*, not as call sites requiring their own guard logic — coverage for those two paths is satisfied by testing `handleAuthValidationFailure` itself (their only auth-failure behavior is "call `handleAuthValidationFailure`, act on its boolean result", which is unchanged code with no new branch to test in isolation). No test tasks are added for `AgentCLI.ts` or `utils/auth.ts` in this plan — see Task 4 for the full regression coverage that stands in for those paths.

## File Structure

- Create: `src/utils/interactive.ts` — new single-purpose module exporting `isNonInteractiveEnvironment()`.
- Create: `src/utils/__tests__/interactive.test.ts` — unit tests for the new utility.
- Modify: `src/providers/core/auth-validation.ts` — add the non-interactive guard inside `handleAuthValidationFailure`.
- Create: `src/providers/core/__tests__/auth-validation.test.ts` — unit tests for `handleAuthValidationFailure` (new file; none exists today).

---

### Task 1: `isNonInteractiveEnvironment()` utility

**Files:**
- Create: `src/utils/interactive.ts`
- Test: `src/utils/__tests__/interactive.test.ts`

Test-first: yes — `isNonInteractiveEnvironment()` returns `true` when `process.stdin.isTTY` is falsy and `false` when it is `true`; this function does not exist yet, so the test fails on import.

- [ ] **Step 1: Write the failing test**

```typescript
// src/utils/__tests__/interactive.test.ts
import { describe, it, expect, afterEach } from 'vitest';

describe('isNonInteractiveEnvironment', () => {
  const originalIsTTY = process.stdin.isTTY;

  afterEach(() => {
    process.stdin.isTTY = originalIsTTY;
  });

  it('should return true when process.stdin.isTTY is undefined (no TTY, e.g. piped/CI)', async () => {
    process.stdin.isTTY = undefined as unknown as true;

    const { isNonInteractiveEnvironment } = await import('../interactive.js');

    expect(isNonInteractiveEnvironment()).toBe(true);
  });

  it('should return true when process.stdin.isTTY is false', async () => {
    process.stdin.isTTY = false as unknown as true;

    const { isNonInteractiveEnvironment } = await import('../interactive.js');

    expect(isNonInteractiveEnvironment()).toBe(true);
  });

  it('should return false when process.stdin.isTTY is true (interactive terminal)', async () => {
    process.stdin.isTTY = true;

    const { isNonInteractiveEnvironment } = await import('../interactive.js');

    expect(isNonInteractiveEnvironment()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/__tests__/interactive.test.ts`
Expected: FAIL — `Cannot find module '../interactive.js'` (or equivalent "failed to resolve import").

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/utils/interactive.ts
/**
 * Non-interactive environment detection
 *
 * Single source of truth for "can we prompt the user right now?".
 * Used to guard interactive prompts (e.g. inquirer) that would otherwise
 * hang or crash (ERR_USE_AFTER_CLOSE) when no TTY is attached to stdin
 * (CI, automation, piped input).
 */

/**
 * Returns true when the current process cannot receive interactive input,
 * i.e. process.stdin is not a TTY.
 */
export function isNonInteractiveEnvironment(): boolean {
  return !process.stdin.isTTY;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/__tests__/interactive.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/interactive.ts src/utils/__tests__/interactive.test.ts
git commit -m "feat(utils): add isNonInteractiveEnvironment TTY-detection utility"
```

---

### Task 2: Guard `handleAuthValidationFailure` against non-interactive prompting

**Files:**
- Modify: `src/providers/core/auth-validation.ts`
- Test: `src/providers/core/__tests__/auth-validation.test.ts`

Test-first: yes — `handleAuthValidationFailure` currently calls `setupSteps.promptForReauth(config)` unconditionally whenever `promptForReauth` exists, with no TTY guard; a test asserting `promptForReauth` is **not** called when `isNonInteractiveEnvironment()` returns `true` fails against current behavior (the mock records a call).

Current implementation (for reference, `src/providers/core/auth-validation.ts:22-35`):

```typescript
export async function handleAuthValidationFailure(
  validationResult: AuthValidationResult,
  setupSteps: ProviderSetupSteps | null,
  config: CodeMieConfigOptions
): Promise<boolean> {
  // Prompt for re-auth if provider supports it
  if (setupSteps?.promptForReauth) {
    return await setupSteps.promptForReauth(config);
  }

  // No re-auth available, show full error with instructions
  console.log(chalk.red(`\n✗ ${validationResult.error}\n`));
  return false;
}
```

- [ ] **Step 1: Write the failing tests**

```typescript
// src/providers/core/__tests__/auth-validation.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuthValidationResult, ProviderSetupSteps } from '../types.js';
import type { CodeMieConfigOptions } from '../../../env/types.js';

vi.mock('../../../utils/interactive.js', () => ({
  isNonInteractiveEnvironment: vi.fn()
}));

const testConfig = {} as CodeMieConfigOptions;

describe('handleAuthValidationFailure', () => {
  let promptForReauthSpy: ReturnType<typeof vi.fn>;
  let isNonInteractiveEnvironmentMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    promptForReauthSpy = vi.fn().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call promptForReauth when a TTY is present and promptForReauth exists', async () => {
    const { isNonInteractiveEnvironment } = await import('../../../utils/interactive.js');
    isNonInteractiveEnvironmentMock = isNonInteractiveEnvironment as ReturnType<typeof vi.fn>;
    isNonInteractiveEnvironmentMock.mockReturnValue(false);

    const { handleAuthValidationFailure } = await import('../auth-validation.js');
    const setupSteps = { promptForReauth: promptForReauthSpy } as unknown as ProviderSetupSteps;
    const validationResult: AuthValidationResult = { valid: false, error: 'expired' };

    const result = await handleAuthValidationFailure(validationResult, setupSteps, testConfig);

    expect(promptForReauthSpy).toHaveBeenCalledWith(testConfig);
    expect(result).toBe(true);
  });

  it('should NOT call promptForReauth when non-interactive, and should return false', async () => {
    const { isNonInteractiveEnvironment } = await import('../../../utils/interactive.js');
    isNonInteractiveEnvironmentMock = isNonInteractiveEnvironment as ReturnType<typeof vi.fn>;
    isNonInteractiveEnvironmentMock.mockReturnValue(true);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { handleAuthValidationFailure } = await import('../auth-validation.js');
    const setupSteps = { promptForReauth: promptForReauthSpy } as unknown as ProviderSetupSteps;
    const validationResult: AuthValidationResult = {
      valid: false,
      error: 'No valid SSO credentials found.'
    };

    const result = await handleAuthValidationFailure(validationResult, setupSteps, testConfig);

    expect(promptForReauthSpy).not.toHaveBeenCalled();
    expect(result).toBe(false);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('No valid SSO credentials found.')
    );
  });

  it('should print the clean failure message when non-interactive (no readline/inquirer path taken)', async () => {
    const { isNonInteractiveEnvironment } = await import('../../../utils/interactive.js');
    isNonInteractiveEnvironmentMock = isNonInteractiveEnvironment as ReturnType<typeof vi.fn>;
    isNonInteractiveEnvironmentMock.mockReturnValue(true);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { handleAuthValidationFailure } = await import('../auth-validation.js');
    const setupSteps = { promptForReauth: promptForReauthSpy } as unknown as ProviderSetupSteps;
    const validationResult: AuthValidationResult = { valid: false, error: 'session expired' };

    await handleAuthValidationFailure(validationResult, setupSteps, testConfig);

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  it('should keep existing behavior when setupSteps has no promptForReauth (JWT-style), regardless of TTY', async () => {
    const { isNonInteractiveEnvironment } = await import('../../../utils/interactive.js');
    isNonInteractiveEnvironmentMock = isNonInteractiveEnvironment as ReturnType<typeof vi.fn>;
    isNonInteractiveEnvironmentMock.mockReturnValue(false);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { handleAuthValidationFailure } = await import('../auth-validation.js');
    const setupSteps = {} as ProviderSetupSteps;
    const validationResult: AuthValidationResult = { valid: false, error: 'JWT token missing' };

    const result = await handleAuthValidationFailure(validationResult, setupSteps, testConfig);

    expect(result).toBe(false);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('JWT token missing'));
  });

  it('should return false when setupSteps is null, regardless of TTY', async () => {
    const { isNonInteractiveEnvironment } = await import('../../../utils/interactive.js');
    isNonInteractiveEnvironmentMock = isNonInteractiveEnvironment as ReturnType<typeof vi.fn>;
    isNonInteractiveEnvironmentMock.mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { handleAuthValidationFailure } = await import('../auth-validation.js');
    const validationResult: AuthValidationResult = { valid: false, error: 'no provider configured' };

    const result = await handleAuthValidationFailure(validationResult, null, testConfig);

    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify the non-interactive-guard tests fail**

Run: `npx vitest run src/providers/core/__tests__/auth-validation.test.ts`
Expected: FAIL on `'should NOT call promptForReauth when non-interactive, and should return false'` and `'should print the clean failure message when non-interactive...'` — `promptForReauthSpy` is called (current code has no TTY guard). The other three tests pass already (they exercise pre-existing behavior), confirming the test file is otherwise correctly wired before the fix.

- [ ] **Step 3: Write the implementation**

```typescript
// src/providers/core/auth-validation.ts
/**
 * Shared authentication validation error handling
 *
 * Centralizes logic for displaying auth errors and prompting for re-authentication
 */

import chalk from 'chalk';
import type { AuthValidationResult, ProviderSetupSteps } from './types.js';
import type { CodeMieConfigOptions } from '../../env/types.js';
import { isNonInteractiveEnvironment } from '../../utils/interactive.js';

/**
 * Handle authentication validation failure
 *
 * Prompts for re-authentication if available and an interactive TTY is
 * attached. In a non-interactive environment (no TTY — CI, automation,
 * piped input) the interactive prompt is skipped entirely to avoid hanging
 * or crashing (ERR_USE_AFTER_CLOSE); the provider is treated the same way
 * as one with no promptForReauth implementation at all.
 *
 * Returns true if re-authentication succeeded, false otherwise.
 *
 * @param validationResult - The validation result from validateAuth()
 * @param setupSteps - Provider setup steps (for promptForReauth)
 * @param config - Provider configuration
 * @returns True if re-authentication succeeded, false if declined, skipped, or not available
 */
export async function handleAuthValidationFailure(
  validationResult: AuthValidationResult,
  setupSteps: ProviderSetupSteps | null,
  config: CodeMieConfigOptions
): Promise<boolean> {
  // Prompt for re-auth if the provider supports it AND we can actually prompt
  if (setupSteps?.promptForReauth && !isNonInteractiveEnvironment()) {
    return await setupSteps.promptForReauth(config);
  }

  // No re-auth available (or no TTY to prompt on), show full error with instructions
  console.log(chalk.red(`\n✗ ${validationResult.error}\n`));
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/providers/core/__tests__/auth-validation.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/providers/core/auth-validation.ts src/providers/core/__tests__/auth-validation.test.ts
git commit -m "fix(auth): skip interactive re-auth prompt in non-interactive environments"
```

---

### Task 3: Full-suite regression check

**Files:** none (verification only)

Test-first: no — this task runs the existing suite plus the two new test files together; there is no new behavior to assert, only a check that nothing else broke.

- [ ] **Step 1: Run the full unit test suite**

Run: `npx vitest run`
Expected: PASS — all existing tests plus the 3 tests from Task 1 and 5 tests from Task 2 pass; no regressions in any file that transitively imports `src/providers/core/auth-validation.ts` (e.g. `src/utils/auth.ts`, `src/agents/core/AgentCLI.ts`, `src/cli/commands/profile/index.ts` — none of which have existing tests today per the technical analysis, so "no regressions" here means the suite still runs green, not that new assertions were added for them).

- [ ] **Step 2: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS — no type errors from the new `isNonInteractiveEnvironment` import in `auth-validation.ts`, no lint violations in either new file.

- [ ] **Step 3: Commit (only if Steps 1-2 required fixes; otherwise skip — nothing to commit)**

```bash
git add -A
git commit -m "chore: fix lint/type issues from non-interactive SSO fix" --allow-empty-message
```
(Only run this step if Steps 1 or 2 actually required code changes. If both passed clean, there is nothing new to commit here — Tasks 1 and 2 already committed their own changes.)

---

## Manual Verification (matches spec's Acceptance Criteria table)

Not part of the automated test suite — a quick sanity check after Tasks 1-3 are complete, using the actual CLI:

```bash
# Simulate non-interactive: pipe empty stdin, no TTY attached
echo '' | node bin/codemie-claude.js --task "echo hi" </dev/null
```

Expected: with missing/expired SSO credentials, the process exits non-zero immediately (no hang) and prints an error containing the SSO validation message — no `Error [ERR_USE_AFTER_CLOSE]` is raised. This is a manual/exploratory check, not an automated test task, since it requires an actual missing-credentials profile state to exercise end-to-end.

---

## Self-Review Notes

- **Spec coverage:** All 6 acceptance criteria from spec.md's mapping table are covered — TTY detection (Task 1), clean non-zero exit + actionable message (Task 2, via the unchanged `process.exit(1)`/`ConfigurationError` paths in callers plus the new guard), no readline crash (Task 2, `promptForReauth`/`inquirer.prompt` is provably never called when non-interactive), regression tests for both interactive and non-interactive paths (Task 2's 5 tests). The "optional `--non-interactive` flag... or equivalent behavior is documented" criterion is satisfied by this plan's explicit Scope Note and the JSDoc added to both new/modified functions — no flag is added, per spec's explicit "Out of scope" section.
- **Placeholder scan:** No TBD/TODO, no "add appropriate error handling" — every step has literal code.
- **Type consistency:** `isNonInteractiveEnvironment(): boolean` (Task 1) is imported and called identically in Task 2's implementation and mocked identically (`vi.mock('../../../utils/interactive.js', ...)`) in Task 2's test. `handleAuthValidationFailure`'s signature (`validationResult, setupSteps, config`) matches the existing production signature exactly — unchanged.
