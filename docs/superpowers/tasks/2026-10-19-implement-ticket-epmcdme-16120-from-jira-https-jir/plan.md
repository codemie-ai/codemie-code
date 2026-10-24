# EPMCDME-16120: Fix cheap-path env-check blanking effort/permission_mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop PreCompact/SessionEnd/SubagentStop's cheap env-recheck from blanking `effort`/`permission_mode` in the persisted `agent.session.env` baseline when the firing hook's payload doesn't carry those fields.

**Architecture:** `computeSessionEnvUpdate` (`src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts`) builds its cheap-path candidate as `{ ...last!, ...volatile }`, where `volatile.effort`/`volatile.permission_mode` are the raw (possibly `''`) hook payload values passed straight through by `resolveVolatileSessionEnvFields`. Fix the merge in that one function to prefer the baseline (`last`) when the payload's value is empty — mirroring the pattern `openSessionStartPass` already uses one function away in the same file.

**Tech Stack:** TypeScript, Vitest.

**Spec:** Requirements supplied inline (ticket EPMCDME-16120 text); no spec file. Technical analysis: `docs/superpowers/tasks/2026-10-19-implement-ticket-epmcdme-16120-from-jira-https-jir/technical-analysis.md`.

## Global Constraints

- Branch EPMCDME-16120 already contains the EPMCDME-16065 code in the working tree — no branch/rebase work.
- Pure in-memory merge-logic fix: do not touch `openSessionStartPass`, the `input.full` branch of `computeSessionEnvUpdate`, or `resolveVolatileSessionEnvFields`'s own signature/behavior.
- Commit per task using the repository's existing convention (Conventional Commits).

## Review Focus

- Empty `effort`/`permissionMode` cheap-path input against a baseline with real values must keep the baseline's values, not blank them — covered by Task 1.
- When the merged candidate equals the stored baseline, no `agent.session.env` event is sent — covered by Task 1 (direct `openSessionEnvCheckPass` case) and Task 2 (fold-in callers).
- `finalize(false)` must still leave the baseline untouched after a no-op-candidate check (not just after a changed one) — already covered by existing tests for the changed-candidate case; the no-op case has no persisted mutation to roll back, so no new assertion is needed beyond candidate being `null`.
- The `input.full` branch and `openSessionStartPass` must remain behaviorally unchanged — no new test needed since no production code in those paths is touched; existing tests for them continue to pass unmodified.
- A hook that *does* supply a non-empty effort/permission_mode must still have that fresh value win over the baseline (changed-value case) — already covered by existing tests (`'cheap path: merges a changed effort onto the baseline...'`); must still pass after the fix.

## Acceptance criteria

- [ ] A hook whose payload doesn't carry `effort`/`permission_mode` (cheap path, `input.effort === ''` and/or `input.permissionMode === ''`) keeps the last known values instead of blanking them.
- [ ] No `agent.session.env` event is sent for PreCompact/SessionEnd/SubagentStop-style cheap-path checks when the merged candidate equals the stored baseline (nothing actually changed).
- [ ] The last `agent.session.env` snapshot of a session retains the real `effort` and `permission_mode`, never empty strings, after any mix of hooks that do/don't carry those fields.

---

### Task 1: Fix `computeSessionEnvUpdate`'s cheap-path merge and cover it directly

**Files:**
- Modify: `src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts:628-631`
- Test: `src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts` (add to `describe('openSessionEnvCheckPass', ...)` block, ~line 1384-1499)

**Interfaces:**
- Consumes: `computeSessionEnvUpdate(state, input)` (unexported, called only via `openSessionEnvCheckPass`/fold-in callers — tests drive it through `openSessionEnvCheckPass(sessionId, input)`); `SessionEnvCheckInput { effort: string; permissionMode: string; full?: {...} }`; `SessionEnvFields.effort`/`.permission_mode`; `sessionEnvFixture` (existing test fixture, already imported in the test file); `openSessionStartPass`, `resolveVolatileSessionEnvFieldsMock` (existing test mock, already set up in the file).
- Produces: no new exported symbols — the fix is a behavior change inside an existing function's cheap-path branch, observable only via `openSessionEnvCheckPass`'s return value and the fold-in callers used in Task 2.

**Test-first: yes — a cheap-path check with `{ effort: '', permissionMode: '' }` against a session that has a real, non-empty baseline must return `sessionEnvFields: null` (no event — nothing actually changed) instead of a candidate with blanked fields.**

- [ ] **Step 1: Write the failing tests**

Add two `it` blocks inside `describe('openSessionEnvCheckPass', ...)`, after the existing `'cheap path: finalize(false) leaves the baseline untouched...'` test (~line 1449):

```typescript
it('cheap path: an empty effort/permissionMode input (PreCompact/SessionEnd payload shape) keeps the baseline, not blanks it', async () => {
  const sessionId = 'session-env-cheap-empty-payload';
  const startPass = await openSessionStartPass(sessionId, 'sha-1', sessionEnvFixture);
  await startPass.finalize(true);

  // Mirrors resolveVolatileSessionEnvFields's real pass-through behavior for a payload
  // that carries neither field (PreCompact/SessionEnd never populate them).
  resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
    effort: '',
    permission_mode: '',
    os: sessionEnvFixture.os,
    arch: sessionEnvFixture.arch,
    node_version: sessionEnvFixture.node_version,
    timezone: sessionEnvFixture.timezone,
    hostname_hash: sessionEnvFixture.hostname_hash,
  });

  const check = await openSessionEnvCheckPass(sessionId, { effort: '', permissionMode: '' });

  expect(check.sessionEnvFields).toBeNull();
  await check.finalize(true);
});

it('cheap path: an empty effort/permissionMode input still lets a genuinely changed volatile field through', async () => {
  const sessionId = 'session-env-cheap-empty-payload-other-change';
  const startPass = await openSessionStartPass(sessionId, 'sha-1', sessionEnvFixture);
  await startPass.finalize(true);

  resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
    effort: '',
    permission_mode: '',
    os: sessionEnvFixture.os,
    arch: sessionEnvFixture.arch,
    node_version: sessionEnvFixture.node_version,
    timezone: 'Antarctica/Troll', // genuinely changed, unrelated to effort/permission_mode
    hostname_hash: sessionEnvFixture.hostname_hash,
  });

  const check = await openSessionEnvCheckPass(sessionId, { effort: '', permissionMode: '' });

  expect(check.sessionEnvFields).toMatchObject({
    effort: sessionEnvFixture.effort,
    permission_mode: sessionEnvFixture.permission_mode,
    timezone: 'Antarctica/Troll',
  });
  await check.finalize(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts -t "empty effort/permissionMode"`
Expected: both new tests FAIL — the first because `sessionEnvFields` is a non-null candidate with blanked `effort`/`permission_mode` (not `null`); the second because `effort`/`permission_mode` in the result are `''` instead of the baseline's values.

- [ ] **Step 3: Fix the cheap-path merge in `computeSessionEnvUpdate`**

In `src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts`, replace the `else` branch body (currently lines 628-631):

```typescript
const volatile = await resolveVolatileSessionEnvFields(input.effort, input.permissionMode);
candidate = { ...last!, ...volatile };
```

with a merge that prefers the baseline when the payload's value is empty — the same precedence `openSessionStartPass` (lines 566-573) already uses for `effort`/`permission_mode`:

```typescript
const volatile = await resolveVolatileSessionEnvFields(input.effort, input.permissionMode);
candidate = {
  ...last!,
  ...volatile,
  effort: input.effort || last!.effort,
  permission_mode: input.permissionMode || last!.permission_mode,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts`
Expected: PASS — the two new tests and every pre-existing test in the file (including the `'cheap path: merges a changed effort onto the baseline...'`, `openSessionStartPass`, and `input.full` tests, which exercise code this task does not change).

- [ ] **Step 5: Commit**

Commit the orchestrator.ts fix and the two new test cases together.

---

### Task 2: Cover the PreCompact/SessionEnd/SubagentStop fold-in callers

**Files:**
- Test: `src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts` (add to `describe('envCheck fold-in — single lock acquisition ...', ...)` block, ~line 1507+)

**Interfaces:**
- Consumes: `openSessionEndPass(sessionId, transcriptPath, cwd, envCheck?)`, `openSubagentPass(sessionId, subagentFile, envCheck?)` (both already exported, already used by neighboring tests in this `describe` block); `pass.events` (array of event records, each with `.type`); Task 1's fixed `computeSessionEnvUpdate` (no new interface — this task exercises the already-fixed merge through the fold-in callers it actually serves in production).
- Produces: nothing new — regression-coverage task, no production code changes.

**Test-first: no — Task 1 already fixes the shared merge function; these two tests exercise that fix through the PreCompact/SessionEnd/SubagentStop entry points the ticket specifically names, closing the coverage gap the analysis identified (no existing test drove `openSessionEndPass`/`openSubagentPass` with an empty-payload `envCheck`). They pass as soon as written, given Task 1 is already applied.**

- [ ] **Step 1: Add the regression tests**

Add two `it` blocks inside `describe('envCheck fold-in — single lock acquisition ...', ...)`, after the existing `'openSessionEndPass folds envCheck into its own already-held lock...'` test (~line 1649), following the same structure as the neighboring fold-in tests:

```typescript
it('openSessionEndPass with an empty-payload envCheck (SessionEnd never carries effort/permission_mode) appends no agent.session.env record', async () => {
  const sessionId = 'session-envcheck-sessionend-empty-payload';
  const transcriptPath = writeTranscript('transcript-envcheck-sessionend-empty-payload.jsonl', [noUsageLine('uuid-main')]);

  const startPass = await openSessionStartPass(sessionId, 'sha-1', sessionEnvFixture);
  await startPass.finalize(true);

  resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
    effort: '',
    permission_mode: '',
    os: sessionEnvFixture.os,
    arch: sessionEnvFixture.arch,
    node_version: sessionEnvFixture.node_version,
    timezone: sessionEnvFixture.timezone,
    hostname_hash: sessionEnvFixture.hostname_hash,
  });

  const pass = await openSessionEndPass(sessionId, transcriptPath, '/repo', {
    effort: '',
    permissionMode: '',
  });

  expect(pass.events.find((e) => e.type === 'agent.session.env')).toBeUndefined();
  await pass.finalize(true);
});

it('openSubagentPass with an empty-payload envCheck (SubagentStop may carry neither field) appends no agent.session.env record', async () => {
  const sessionId = 'session-envcheck-subagent-empty-payload';
  const file = writeSubagentFixture(sessionId, 'a1', [
    usageLine({ uuid: 'u1', messageId: 'msg_a', outputTokens: 10 }),
  ]);

  const startPass = await openSessionStartPass(sessionId, 'sha-1', sessionEnvFixture);
  await startPass.finalize(true);

  resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
    effort: '',
    permission_mode: '',
    os: sessionEnvFixture.os,
    arch: sessionEnvFixture.arch,
    node_version: sessionEnvFixture.node_version,
    timezone: sessionEnvFixture.timezone,
    hostname_hash: sessionEnvFixture.hostname_hash,
  });

  const pass = await openSubagentPass(sessionId, file, {
    effort: '',
    permissionMode: '',
  });

  expect(pass.events.find((e) => e.type === 'agent.session.env')).toBeUndefined();
  await pass.finalize(true);
});
```

- [ ] **Step 2: Run the full test file to verify everything passes**

Run: `npx vitest run src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts`
Expected: PASS — all tests in the file, including Task 1's new tests and these two.

- [ ] **Step 3: Commit**

Commit the two new fold-in test cases.
