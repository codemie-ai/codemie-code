# EPMCDME-15372: Skip cold-start when baseUrl is missing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (sdlc-light runs this inline, not via subagent).

**Goal:** `ensureOtlpProxy()` must detect a missing/empty `config.baseUrl` and return silently, before any daemon startup is attempted, so the `claude-code-otlp` hook never fails just because a profile has no `baseUrl` configured.

**Architecture:** Single-function fix in the proxy orchestration layer. Insert a guard clause in `ensureOtlpProxy()` (`src/cli/commands/proxy/connect-orchestrator.ts`) immediately after the active profile `config` is loaded and before `daemonConfig`/`ensureDaemon` are reached. The guard returns (does not throw), matching the "background side effect inside every hook invocation" nature of this call path — unlike the sibling `connectTargets()`, which throws `ConfigurationError` because it is an interactive CLI command.

**Tech Stack:** TypeScript, Vitest `^4.1.5`, existing `ConfigLoader`/`daemon-manager.js` mocking conventions in `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts`.

**Spec:** `docs/superpowers/tasks/2026-10-22-epmcdme-15372-missing-baseurl-proxy-startup/technical-analysis.md` (no separate spec.md — sdlc-light skips spec-writing).

## Global Constraints

- The guard must `return` silently — it must NOT throw `ConfigurationError` (that convention is for interactive commands only; AC4/AC5 require hook exit code 0 and no user-facing failure).
- Guard condition is `!config.baseUrl` (falsy: `undefined` or `''`), placed after `ConfigLoader.load(...)` (current line ~413) and before `daemonConfig` is built (current line ~415).
- Do NOT touch, build on top of, or commit the pre-existing uncommitted "TEMP LOCAL-DEV OVERRIDE — do not commit" scratch edits already in the working tree in `connect-orchestrator.ts` (hardcoded `targetUrl: 'http://localhost:8080'` at two call sites), `sso.proxy.ts`, or `spool-config.ts`. These are unrelated local-dev changes and must not appear in this fix's diff/commit.
- A one-line comment at the guard explaining the intentional silent-return (vs. the throwing sibling pattern) is required, so a future reviewer doesn't "correct" it back to a throw.
- EPMCDME-15369 (hook exit-code propagation on other `ensureOtlpProxy` failure modes) is explicitly out of scope.

## Review Focus

- Empty string `baseUrl: ''` must be treated the same as `undefined` (falsy check, not `=== undefined`).
- A valid `baseUrl` must still cold-start normally — the guard must not short-circuit the happy path (AC6).
- No daemon state file (`~/.codemie/proxy-daemon.json`) must be written when the guard returns early (AC3) — not just "no process spawned," but no `writeState` either.
- The guard must sit strictly before `ensureDaemon`/`spawnDaemon` is reached, not just before the daemon starts logging — a `vi.fn()`-mocked `spawnDaemon`/`ensureDaemon` must assert zero calls, not merely "not awaited."
- The function must resolve without throwing in the missing-`baseUrl` case — a caller (`OtlpAgentAdapter.processOtlpEvent`) with no try/catch around `ensureOtlpProxy` must not see a rejected promise.

---

### Task 1: Add baseUrl guard to `ensureOtlpProxy` with test coverage

**Files:**
- Modify: `src/cli/commands/proxy/connect-orchestrator.ts:410-414` (inside `ensureOtlpProxy`, after the `ConfigLoader.load(...)` call, before `daemonConfig` is built)
- Test: `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` (add new test cases importing the real `ensureOtlpProxy`, not mocked)

**Interfaces:**
- Consumes: existing `ensureOtlpProxy(agentName: string): Promise<void>` signature (unchanged) — `ConfigLoader.load`, `ConfigLoader.getActiveProfileName`, `readState`, `isProcessAlive`, `ensureDaemon` as already imported in the file.
- Produces: no new exports; behavior change only. `ensureOtlpProxy` resolves without throwing and without calling `ensureDaemon`/`spawnDaemon` when `config.baseUrl` is falsy.

**Test-first: yes — failing test asserting `ensureOtlpProxy` returns early (no daemon spawn, no state write, no throw) when `baseUrl` is missing/empty.**

- [ ] **Step 1: Write the failing tests**

In `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts`, add a `describe('ensureOtlpProxy')` block that imports the real (unmocked) `ensureOtlpProxy` from `connect-orchestrator.js`, mocks `ConfigLoader.load`/`getActiveProfileName` via the existing `setupHappyMocks`-style fixture, and mocks `daemon-manager.js` (`readState`, `isProcessAlive`, `spawnDaemon`, `writeState` if exported) the same way the existing suite already mocks them:

```ts
describe('ensureOtlpProxy', () => {
  it('returns silently and does not spawn a daemon when baseUrl is undefined', async () => {
    mockReadState.mockResolvedValue(null);
    mockConfigLoaderLoad.mockResolvedValue({ ...baseConfigFixture, baseUrl: undefined });

    await expect(ensureOtlpProxy('claude-code-otlp')).resolves.toBeUndefined();

    expect(mockSpawnDaemon).not.toHaveBeenCalled();
  });

  it('returns silently and does not spawn a daemon when baseUrl is an empty string', async () => {
    mockReadState.mockResolvedValue(null);
    mockConfigLoaderLoad.mockResolvedValue({ ...baseConfigFixture, baseUrl: '' });

    await expect(ensureOtlpProxy('claude-code-otlp')).resolves.toBeUndefined();

    expect(mockSpawnDaemon).not.toHaveBeenCalled();
  });

  it('still cold-starts normally when baseUrl is present', async () => {
    mockReadState.mockResolvedValue(null);
    mockConfigLoaderLoad.mockResolvedValue({ ...baseConfigFixture, baseUrl: 'https://example.codemie.ai' });

    await ensureOtlpProxy('claude-code-otlp');

    expect(mockSpawnDaemon).toHaveBeenCalledTimes(1);
  });
});
```

Adapt mock variable names (`mockReadState`, `mockConfigLoaderLoad`, `mockSpawnDaemon`, `baseConfigFixture`) to whatever the existing file's established mocking convention actually names them — reuse the suite's current `setupHappyMocks`/`vi.mock` pattern rather than introducing a new one.

- [ ] **Step 2: Run tests to verify the first two fail**

Run: `npx vitest run src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts -t ensureOtlpProxy`
Expected: the `undefined` and `''` baseUrl cases FAIL (current code calls `spawnDaemon` regardless of `baseUrl`); the "baseUrl present" case passes already (no behavior change needed there).

- [ ] **Step 3: Implement the guard in `ensureOtlpProxy`**

In `src/cli/commands/proxy/connect-orchestrator.ts`, immediately after the `const config = await ConfigLoader.load(...)` call and before `const daemonConfig = {...}` is built, add:

```ts
// Hook invocations run as a background side effect on every tracked project;
// an unconfigured baseUrl must skip cold start silently (not throw, unlike
// connectTargets' interactive ConfigurationError) so it never fails the hook.
if (!config.baseUrl) {
  return;
}
```

Do not modify the pre-existing `targetUrl: 'http://localhost:8080'` scratch line below it — leave that local-dev override exactly as found; it is out of scope and must not be part of this task's diff when committing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts -t ensureOtlpProxy`
Expected: all three cases PASS.

- [ ] **Step 5: Run the full existing suite for this file to check no regression**

Run: `npx vitest run src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts`
Expected: all tests PASS (including pre-existing `connectTargets`/`deriveDaemonIdentity`/`daemonMatchesRequest` cases, unaffected by this change).

- [ ] **Step 6: Commit (fix only — exclude unrelated local-dev scratch edits)**

The working tree has pre-existing unrelated changes in `connect-orchestrator.ts` (the `targetUrl: 'http://localhost:8080'` scratch overrides), `sso.proxy.ts`, and `spool-config.ts`. Stage only the guard clause and the new/modified test block using a partial/patch add (e.g. `git add -p src/cli/commands/proxy/connect-orchestrator.ts` and select only the guard hunk, plus `git add src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` in full) so the scratch edits remain unstaged and uncommitted:

```bash
git add -p src/cli/commands/proxy/connect-orchestrator.ts
git add src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts
git commit -m "fix(proxy): skip cold start silently when baseUrl is missing (EPMCDME-15372)"
```

Verify with `git status` / `git diff --cached` afterward that no `TEMP LOCAL-DEV OVERRIDE` lines are included in the commit.

---

## Self-Review

1. **Spec coverage**: AC1 (detect missing/empty baseUrl before daemon startup) → Task 1 guard. AC2/AC3 (no process spawned, no state file) → Task 1 test assertions on `spawnDaemon`. AC4/AC5 (exit code 0, no user-facing failure) → guard resolves without throwing, so the uncaught-promise path in `OtlpAgentAdapter`/`hook.ts` never triggers. AC6 (valid baseUrl still cold-starts) → Task 1's third test case. All six covered by one task.
2. **Step scan**: each step is a single concrete action (write tests, run, implement, run, run full suite, commit) with no open decisions left beyond adapting existing mock variable names to the file's real conventions.
3. **Type consistency**: no new types/signatures introduced; `ensureOtlpProxy(agentName: string): Promise<void>` unchanged.
4. **Review Focus**: all five items each map to one of the three new test cases in Task 1 (empty-string vs undefined, happy-path regression, no-state-write vs no-process-spawn distinction, pre-`ensureDaemon` placement, non-throwing resolution).
5. **Proportion**: single task, one small code change, test-first — plan length matches the small fix surface identified in research.
