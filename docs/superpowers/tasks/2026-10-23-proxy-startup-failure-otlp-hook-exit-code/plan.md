# OTLP Hook: Swallow ensureOtlpProxy Failures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A failed analytics-proxy-daemon start/restart during a `claude-code-otlp` hook invocation must be logged and swallowed, never propagate to the hook's exit code.

**Architecture:** Wrap the single unguarded `await ensureOtlpProxy(this.name)` call in `OtlpAgentAdapter.processOtlpEvent()` in a try/catch that logs and continues — mirroring the project's existing "(non-blocking)" swallow-and-log idiom and the sibling `forwardOtlpEventsToSpool` "never throws" contract. No other layer changes: `connect-orchestrator.ts` and `daemon-manager.ts` keep throwing, since the interactive `codemie proxy connect` command relies on that.

**Tech Stack:** TypeScript, Vitest.

**Spec:** docs/superpowers/tasks/2026-10-23-proxy-startup-failure-otlp-hook-exit-code/technical-analysis.md (sdlc-light has no spec.md; this is the requirements source, confirmed via the Stage 2 clarity-check answer: `evaluate()`/`forwardOtlpEventsToSpool` still runs after a swallowed `ensureOtlpProxy` failure).

## Global Constraints

- Never rethrow from the new catch block — `processOtlpEvent` must resolve normally on `ensureOtlpProxy` failure (ticket AC1, AC2, AC3).
- Do not modify `src/cli/commands/proxy/connect-orchestrator.ts` or `src/cli/commands/proxy/daemon-manager.ts` — `ensureOtlpProxy`/`ensureDaemon` must keep throwing for `codemie proxy connect`.
- Do not weaken or reorder the `OtlpAgentAdapter.ts:91-95` INVARIANT or the `isTracked()` gate — only the handling of `ensureOtlpProxy`'s failure changes, never when it's called.
- After a swallowed failure, `evaluate()` and (when the decision has a non-empty payload) `forwardOtlpEventsToSpool` still run for that invocation — do not early-return on failure.
- Log with the project's established `(non-blocking)` idiom (e.g. `hook.ts:193-210`, `pi.plugin.ts:387`) via `logger.error`; include the agent name and the error message.

## Review Focus

- A non-`Error` thrown value (e.g. a string or plain object) from `ensureOtlpProxy` — the catch must not itself throw while stringifying it for the log message.
- `ensureOtlpProxy` resolving normally (the common case) — the try/catch must not change observable behavior versus today.
- A payload-bearing decision after a swallowed `ensureOtlpProxy` failure — `forwardOtlpEventsToSpool` must still be called (per the confirmed "continue" design decision), and `processOtlpEvent` must still resolve.
- The hook process's final exit code specifically when `ensureOtlpProxy` rejects — this is the ticket's core, currently-unasserted behavior (AC3).
- The `isTracked() === false` path — must remain untouched: `ensureOtlpProxy` must still never be called for an untracked project (the INVARIANT), independent of this fix.

---

### Task 1: Swallow `ensureOtlpProxy` failures in `OtlpAgentAdapter.processOtlpEvent`

**Files:**
- Modify: `src/agents/core/OtlpAgentAdapter.ts:103` (and its import block, lines 1-12, unchanged — no new imports needed)
- Test: `src/agents/core/__tests__/OtlpAgentAdapter.test.ts`
- Test: `src/cli/commands/__tests__/hook.analytics-wiring.test.ts`

**Interfaces:**
- Consumes: existing `OtlpAgentAdapter<TInput, TBlockOutput>` abstract base class, `OtlpAdapterDeps.ensureOtlpProxy: (agentName: string) => Promise<void>`, `logger` from `@/utils/logger.js`.
- Produces: `processOtlpEvent` never rejects due to an `ensureOtlpProxy` failure; behavior otherwise unchanged. No new exported symbols.

- [ ] **Step 1: Write the failing test — swallow-and-continue (unit level)**

Test-first: yes — `ensureOtlpProxy` rejecting must not make `processOtlpEvent` reject, and `forwardOtlpEventsToSpool` must still run afterward.

In `src/agents/core/__tests__/OtlpAgentAdapter.test.ts`, inside the existing `describe('OtlpAgentAdapter.processOtlpEvent', ...)` block (reuse the existing `run`, `deps`, `ensureOtlpProxy`, `forwardToSpool` fixtures from `beforeEach`), add:

```ts
it('swallows an ensureOtlpProxy failure, logs it, and still forwards the event', async () => {
  ensureOtlpProxy.mockRejectedValueOnce(new Error('Daemon failed to start within 5 seconds'));
  await expect(run()).resolves.toBeUndefined();
  expect(forwardToSpool).toHaveBeenCalledTimes(1);
  expect(ensureOtlpProxy.mock.invocationCallOrder[0]).toBeLessThan(forwardToSpool.mock.invocationCallOrder[0]);
});
```

- [ ] **Step 2: Write the failing test — exit code 0 on daemon-start failure (hook-process level)**

Test-first: yes — `process.exitCode` must be `0` after a hook invocation whose `ensureOtlpProxy` call rejects, exercising the *real* `OtlpAgentAdapter.processOtlpEvent` end-to-end (not a mocked `processOtlpEvent`), so this test fails for the same reason as Step 1's until Step 4's fix lands.

Add to `src/cli/commands/__tests__/hook.analytics-wiring.test.ts`, inside the existing `describe('hook command analytics wiring', ...)` block (after the existing `'calls processOtlpEvent with the parsed input...'` test, so it inherits the file's `beforeEach`/`afterEach` stdin and `process.exitCode` reset):

```ts
import { OtlpAgentAdapter } from '@/agents/core/OtlpAgentAdapter.js';
import type { ForwardDecision, OtlpHookContext } from '@/agents/core/OtlpAgentAdapter.js';

class TrackedNoopAdapter extends OtlpAgentAdapter<{ cwd: string }> {
  readonly name = 'fake-tracked';
  protected parseHookInput(raw: string) {
    return JSON.parse(raw) as { cwd: string };
  }
  protected extractHookContext(input: { cwd: string }): OtlpHookContext {
    return { cwd: input.cwd };
  }
  protected async isTracked(): Promise<boolean> {
    return true;
  }
  protected async evaluate(): Promise<ForwardDecision> {
    return { decision: 'forward', payload: [] }; // empty payload: processOtlpEvent returns before calling forwardOtlpEventsToSpool
  }
  protected async resolveAgentFields(): Promise<Record<string, unknown>> {
    return {};
  }
  protected resolveEventType(): string {
    return 'fake.event';
  }
}

it('keeps process.exitCode at 0 when ensureOtlpProxy rejects (daemon start failure)', async () => {
  vi.mocked(ensureOtlpProxy).mockRejectedValueOnce(new Error('Daemon failed to start within 5 seconds'));
  vi.spyOn(AgentRegistry, 'getAnalyticsAgent').mockReturnValue(new TrackedNoopAdapter());

  await createHookCommand().parseAsync(['--agent', 'claude-code-otlp'], { from: 'user' });

  expect(process.exitCode).toBe(0);
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `npx vitest run src/agents/core/__tests__/OtlpAgentAdapter.test.ts src/cli/commands/__tests__/hook.analytics-wiring.test.ts`
Expected: FAIL — both new tests fail because the unguarded `await ensureOtlpProxy(this.name)` at `OtlpAgentAdapter.ts:103` currently lets the rejection propagate (the adapter test's `run()` promise rejects instead of resolving; the hook test ends up with `process.exitCode === 1` via `hook.ts`'s outer catch). All pre-existing tests in both files still pass.

- [ ] **Step 4: Implement the try/catch in `processOtlpEvent` (`src/agents/core/OtlpAgentAdapter.ts`)**

Replace line 103 (`await ensureOtlpProxy(this.name);`) with:

```ts
try {
  await ensureOtlpProxy(this.name);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`[${this.name}] ensureOtlpProxy failed (non-blocking): ${message}`);
}
```

No `sanitizeLogArgs` import is needed: the logged value is only the `Error#message` string from `daemon-manager.ts`'s own throw sites (e.g. `"Daemon failed to start within 5 seconds. Check logs: ~/.codemie/logs/"`), which carries no profile/URL/gatewayKey content. Do not add that import.

- [ ] **Step 5: Run both tests to verify they pass**

Run: `npx vitest run src/agents/core/__tests__/OtlpAgentAdapter.test.ts src/cli/commands/__tests__/hook.analytics-wiring.test.ts`
Expected: PASS — all tests in both files, including the two new ones and all pre-existing ones (e.g. `'gates on isTracked...'`, `'ensures the proxy before forwarding'` — this confirms AC6, the happy-path regression, since that test already asserts `ensureOtlpProxy` resolving normally still forwards in order).

- [ ] **Step 6: Commit**

```bash
git add src/agents/core/OtlpAgentAdapter.ts src/agents/core/__tests__/OtlpAgentAdapter.test.ts src/cli/commands/__tests__/hook.analytics-wiring.test.ts
git commit -m "fix(agents): swallow ensureOtlpProxy failures in the OTLP hook path

EPMCDME-15369"
```
