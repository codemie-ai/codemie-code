# EPMCDME-16065: SessionStart agent.session.env merge fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `SessionStart`'s `agent.session.env` from sending/persisting empty `effort`/`permission_mode` (and empty `configured_model` on resume) by merging onto the prior snapshot instead of overwriting it.

**Architecture:** `openSessionStartPass` (orchestrator.ts) currently persists `state.lastSessionEnvFields = sessionEnvFields` unconditionally and returns no fields to its caller. It must instead read the prior snapshot first, merge the fresh payload onto it (per-field rule below), persist and return the merged result. `onSessionStart` (claude-code-otlp.plugin.ts) must build/send `agent.session.env` from that merged result instead of the raw, unmerged `resolveSessionEnvFields(...)` output it uses today. No other file changes.

**Tech Stack:** TypeScript, Vitest, dynamic-import mocking (existing repo conventions).

**Spec:** Jira EPMCDME-16065 (requirements supplied inline — no spec.md for this flow) plus `docs/superpowers/tasks/2026-10-16-epmcdme-16065/technical-analysis.md` Section 9 (authoritative; earlier sections are stale).

Commit per task using the repository's existing convention.

## Global Constraints

- Working tree is `EPMCDME-16065`, reset onto PR #634's head (`609da8e6`) — this is a located bug fix in existing code, not new functionality.
- `effort` always carries forward `last.effort` when a prior snapshot exists — `SessionStart`'s own payload never carries `effort` (SDK contract), so there is nothing in the fresh payload to ever prefer for this field.
- `permission_mode` and `configured_model`: prefer the fresh payload's value when non-empty, else fall back to `last`'s value — mirrors `OtlpAgentAdapter.ts`'s `OVERRIDABLE_FIELD_KEYS` "own non-empty value wins" rule (`src/agents/core/OtlpAgentAdapter.ts:28,210-218`).
- First `SessionStart` for a session (no `last` snapshot yet): behavior unchanged — use the freshly resolved fields as-is.
- `openSessionEnvCheckPass` (orchestrator.ts:611-649) and `sessionEnvFieldsEqual` (session-env-fields.ts:187-204) are not touched by this fix.

## Review Focus

- A `SessionStart` with no prior `lastSessionEnvFields` (true first fire of a session) must still emit/persist the freshly resolved fields unchanged — covered by Task 1's "first fire" test.
- A compact/resume `SessionStart` whose fresh payload has empty `permission_mode` and empty `configured_model` (resume case) must carry both forward from `last` — covered by Task 1.
- `effort` must carry forward from `last` even when the fresh payload would otherwise look like it has a non-empty value for some other field — i.e. `effort` is never read from the fresh payload, only ever from `last` — covered by Task 1's assertion on the merged `effort`.
- `openSessionStartPass`'s own-process failure path (lock/load error) must still return something `onSessionStart` can build an event from, rather than throwing — covered by Task 1's existing failure-path expectations (`EMPTY_PASS`-shaped fallback, now carrying `sessionEnvFields`).
- The plugin must send the *merged* fields, not the *raw* `resolveSessionEnvFields(...)` output, on a second (compact/resume) fire — covered by Task 2.
- Ticket Expected-Result bullet 3 ("one `agent.session.env` per real change; no duplicate on the first `Stop`") must hold as an *observed* outcome of the merge, not just an inferred one — covered end-to-end by Task 1 Step 1's third test (`a Stop immediately after a compact/resume SessionStart finds no diff ...`), which chains a real-fire `SessionStart` → resume-fire `SessionStart` → `Stop`-style `openSessionEnvCheckPass` and asserts `check.sessionEnvFields` is `null`.

---

## File Structure

- Modify `src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts:538-561` (`openSessionStartPass`) — read `state.lastSessionEnvFields` before overwriting it, merge, persist and return the merged fields.
- Modify `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts:152-173` (`onSessionStart`) — build `buildSessionEnvEvent` from the pass's merged result.
- Test: `src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts` — extend the `describe('openSessionStartPass', ...)` block (~line 1232), including an end-to-end SessionStart-merge-then-Stop test proving no duplicate `agent.session.env`.
- Test: `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts` — extend the `describe('ClaudeCodeOtlpPlugin agent.session.env (SessionStart)', ...)` block (~line 813).

---

### Task 1: `openSessionStartPass` merges onto the prior `lastSessionEnvFields` snapshot

**Files:**
- Modify: `src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts:538-561`
- Test: `src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts` (extend `describe('openSessionStartPass', ...)`, ~line 1232; `sessionEnvFixture` already defined ~line 1210; `resolveVolatileSessionEnvFieldsMock` and `openSessionEnvCheckPass` are already imported/used in this file for the existing "records the sessionEnvFields baseline" test)

**Interfaces:**
- Consumes: existing `SessionEnvFields` type (session-env-fields.ts), `acquireParseStateLock`/`loadParseState`/`finalizeOf` (already in this file), `TranscriptPass` (orchestrator.ts:74-77).
- Produces: new exported `SessionStartPass` type and the new `openSessionStartPass` return shape, consumed by Task 2.

```typescript
/** {@link openSessionStartPass}'s result: the usual commit-after-send pass, plus the
 *  fields the caller must actually send/persist for this fire — the merged snapshot,
 *  not the raw payload-derived input. */
export interface SessionStartPass extends TranscriptPass {
  sessionEnvFields: SessionEnvFields;
}
```

- [ ] **Step 1: Write the failing tests**

Add to `describe('openSessionStartPass', ...)` in `orchestrator.test.ts`, mirroring the existing "a later SessionStart fire ... does not overwrite the real session start" test (~line 1265):

```typescript
it('a later SessionStart fire merges onto the prior lastSessionEnvFields snapshot instead of overwriting it', async () => {
  const sessionId = 'session-start-env-merge';
  const firstFields = { ...sessionEnvFixture, effort: 'high', permission_mode: 'acceptEdits', configured_model: 'claude-opus-5' };
  const firstPass = await openSessionStartPass(sessionId, 'sha-1', firstFields);
  expect(firstPass.sessionEnvFields).toEqual(firstFields); // first fire: unchanged
  await firstPass.finalize(true);

  // Resume fire: fresh payload has empty effort/permission_mode/configured_model.
  const resumeFields = { ...sessionEnvFixture, effort: '', permission_mode: '', configured_model: '' };
  const secondPass = await openSessionStartPass(sessionId, 'sha-2', resumeFields);
  expect(secondPass.sessionEnvFields).toMatchObject({
    effort: 'high',
    permission_mode: 'acceptEdits',
    configured_model: 'claude-opus-5',
  });
  await secondPass.finalize(true);
});

it('a later SessionStart fire prefers its own non-empty permission_mode/configured_model over the prior snapshot', async () => {
  const sessionId = 'session-start-env-merge-prefers-own';
  const firstFields = { ...sessionEnvFixture, effort: 'high', permission_mode: 'acceptEdits', configured_model: 'claude-opus-5' };
  const firstPass = await openSessionStartPass(sessionId, 'sha-1', firstFields);
  await firstPass.finalize(true);

  const switchedFields = { ...sessionEnvFixture, effort: '', permission_mode: 'plan', configured_model: 'claude-sonnet-5' };
  const secondPass = await openSessionStartPass(sessionId, 'sha-2', switchedFields);
  expect(secondPass.sessionEnvFields).toMatchObject({
    effort: 'high', // still carried forward: SessionStart payload never has it
    permission_mode: 'plan', // fresh payload's own non-empty value wins
    configured_model: 'claude-sonnet-5',
  });
  await secondPass.finalize(true);
});

it('a Stop immediately after a compact/resume SessionStart finds no diff against the merged snapshot (no duplicate agent.session.env)', async () => {
  // End-to-end proof of ticket Expected-Result bullet 3: SessionStart's merge must leave the
  // baseline already correct, so the very next Stop's cheap check (openSessionEnvCheckPass,
  // no `full`) reports no change and therefore no second agent.session.env is ever built.
  const sessionId = 'session-start-env-merge-then-stop';
  const firstFields = { ...sessionEnvFixture, effort: 'high', permission_mode: 'acceptEdits', configured_model: 'claude-opus-5' };
  const firstPass = await openSessionStartPass(sessionId, 'sha-1', firstFields);
  await firstPass.finalize(true);

  // Compact/resume fire: fresh payload has empty effort/permission_mode/configured_model —
  // openSessionStartPass must merge these back onto `last` (same scenario as the first test above).
  const resumeFields = { ...sessionEnvFixture, effort: '', permission_mode: '', configured_model: '' };
  const secondPass = await openSessionStartPass(sessionId, 'sha-2', resumeFields);
  expect(secondPass.sessionEnvFields).toMatchObject({
    effort: 'high',
    permission_mode: 'acceptEdits',
    configured_model: 'claude-opus-5',
  });
  await secondPass.finalize(true);

  // Stop fires next, reporting the SAME real effort/permission_mode SessionStart's merge
  // already correctly captured — exactly what a genuine "nothing changed" Stop looks like.
  resolveVolatileSessionEnvFieldsMock.mockResolvedValue({
    effort: 'high',
    permission_mode: 'acceptEdits',
    os: sessionEnvFixture.os,
    arch: sessionEnvFixture.arch,
    node_version: sessionEnvFixture.node_version,
    timezone: sessionEnvFixture.timezone,
    hostname_hash: sessionEnvFixture.hostname_hash,
  });
  const stopCheck = await openSessionEnvCheckPass(sessionId, { effort: 'high', permissionMode: 'acceptEdits' });
  expect(stopCheck.sessionEnvFields).toBeNull(); // sessionEnvFieldsEqual found no diff: no second agent.session.env
  await stopCheck.finalize(true);
});
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `npm run test -- orchestrator.test.ts -t "merges onto the prior"` and `npm run test -- orchestrator.test.ts -t "finds no diff against the merged snapshot"`
Expected: FAIL — today's `openSessionStartPass` returns no `sessionEnvFields` property and unconditionally overwrites, so the first two tests' assertions fail (TS also flags the missing property if run through `tsc`/vitest's type check). The third (end-to-end) test fails too: because the resume fire overwrites `last` with the empty-fields payload instead of merging, the baseline the `Stop` check diffs against no longer has `effort: 'high'`/`permission_mode: 'acceptEdits'`, so `sessionEnvFieldsEqual` finds a (spurious) diff and `stopCheck.sessionEnvFields` is non-null, not `null`.

- [ ] **Step 3: Implement the merge in `openSessionStartPass`**

In `orchestrator.ts:538-561`: change the return type to `Promise<SessionStartPass>`. Before `state.lastSessionEnvFields = sessionEnvFields;`, capture `const last = state.lastSessionEnvFields;` and compute:

```typescript
const merged: SessionEnvFields = last
  ? {
      ...sessionEnvFields,
      effort: last.effort,
      permission_mode: sessionEnvFields.permission_mode || last.permission_mode,
      configured_model: sessionEnvFields.configured_model || last.configured_model,
    }
  : sessionEnvFields;
state.lastSessionEnvFields = merged;
return { events: [], finalize: finalizeOf(sessionId, state, release), sessionEnvFields: merged };
```

In the `catch` block, change `return EMPTY_PASS;` to `return { ...EMPTY_PASS, sessionEnvFields };` (degrade to the freshest available fields — the caller has nothing better when the lock/load itself failed) — keeps the "never throws" discipline documented in this file's module header.

Update the function's doc comment to describe the merge (replace the sentence that currently implies `sessionEnvFields` is only ever recorded verbatim).

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm run test -- orchestrator.test.ts -t "openSessionStartPass"`
Expected: PASS, including the three pre-existing tests in this `describe` block (no regression to `gitHeadStart`/`sessionStartedAt` first-write-wins behavior) and all three new tests, including the end-to-end SessionStart-then-Stop test.

- [ ] **Step 5: Commit**

Test-first: yes — all three new tests in Step 1 fail against today's unconditional-overwrite `openSessionStartPass` before Step 3's merge lands.

---

### Task 2: `onSessionStart` sends the merged `sessionEnvFields`, not the raw resolved ones

**Files:**
- Modify: `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts:152-173`
- Test: `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts` (extend `describe('ClaudeCodeOtlpPlugin agent.session.env (SessionStart)', ...)`, ~line 813; uses the existing `openSessionStartPassMock`/`emptyPass()`/`SESSION_ENV_FIELDS_STUB` helpers already in the file)

**Interfaces:**
- Consumes: Task 1's `SessionStartPass.sessionEnvFields` (the merged result); existing `buildSessionEnvEvent(sessionId, fields)` (plugin.ts:431).
- Produces: nothing new for later tasks — this is the last task in the plan.

- [ ] **Step 1: Write the failing test**

Add to the existing `describe('ClaudeCodeOtlpPlugin agent.session.env (SessionStart)', ...)` block:

```typescript
it('sends the SessionStart pass\'s merged sessionEnvFields, not the raw resolveSessionEnvFields output', async () => {
  const mergedFields = {
    ...SESSION_ENV_FIELDS_STUB,
    configured_model: 'claude-opus-5',
    effort: 'high', // carried forward by openSessionStartPass; never in the raw payload
    permission_mode: 'acceptEdits',
  };
  openSessionStartPassMock.mockResolvedValue({ events: [], finalize: vi.fn(async () => {}), sessionEnvFields: mergedFields });
  resolveSessionEnvFieldsMock.mockResolvedValue({ ...SESSION_ENV_FIELDS_STUB, configured_model: '', permission_mode: '' });

  await plugin.processOtlpEvent(
    JSON.stringify({ session_id: 's', transcript_path: '', cwd: '/x', hook_event_name: 'SessionStart', source: 'resume' }),
    { ensureOtlpProxy, forwardOtlpEventsToSpool }
  );

  const forwarded = forwardedEvents();
  const envEvent = forwarded.find((e) => e.type === 'agent.session.env');
  expect(envEvent).toMatchObject({ configured_model: 'claude-opus-5', effort: 'high', permission_mode: 'acceptEdits' });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm run test -- claude-code-otlp.plugin.test.ts -t "merged sessionEnvFields"`
Expected: FAIL — `onSessionStart` today builds `buildSessionEnvEvent` from the raw `sessionEnvFields` variable (the `resolveSessionEnvFields` output), so the forwarded event carries the mocked raw (empty) fields, not `mergedFields`.

- [ ] **Step 3: Implement the call-site change**

In `claude-code-otlp.plugin.ts:152-173`: keep `const pass = await openSessionStartPass(hookInput.session_id, gitHeadStart.git_head_start, sessionEnvFields);` as-is (Task 1 changed its return type, not its call signature). Change the next line from `const sessionEnvEvent = buildSessionEnvEvent(hookInput.session_id, sessionEnvFields);` to `const sessionEnvEvent = buildSessionEnvEvent(hookInput.session_id, pass.sessionEnvFields);`. No other line in this method changes — the raw `sessionEnvFields` variable is still passed into `openSessionStartPass` as its third argument (that's the fresh-payload input the merge needs) and is otherwise unused for sending.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm run test -- claude-code-otlp.plugin.test.ts -t "ClaudeCodeOtlpPlugin agent.session.env"`
Expected: PASS, including the three pre-existing tests in this `describe` block.

- [ ] **Step 5: Commit**

Test-first: yes — the test in Step 1 fails against today's `onSessionStart`, which sends the raw `resolveSessionEnvFields` output, before Step 3's one-line call-site fix lands.

---

## Negative-Constraint Pass

- **"No change should be needed to `openSessionEnvCheckPass` itself"** — neither task touches `orchestrator.ts:611-649` or `sessionEnvFieldsEqual` (session-env-fields.ts:187-204). Task 1's diff is scoped to `openSessionStartPass` (lines 538-561) only. Task 1's third test calls `openSessionEnvCheckPass` unmodified, as a consumer, to prove the merge's effect — it is not exercising a change to that function.
- **"On the very first `SessionStart` for a session ... behavior is unchanged"** — Task 1's merge is `last ? { merge } : sessionEnvFields` — with no `last`, the function returns the freshly resolved fields verbatim, identical to today's behavior. Covered explicitly by Task 1 Step 1's first test (`expect(firstPass.sessionEnvFields).toEqual(firstFields)`).
- **"One `agent.session.env` per real change; no duplicate on the first `Stop`"** — this is an emergent property of the merge, not a separate code path, so it cannot be honored by a task "the wrong way"; it is proved directly (not just argued) by Task 1 Step 1's third test, which chains SessionStart (real) → SessionStart (resume merge) → Stop (cheap check) and asserts `openSessionEnvCheckPass` returns `sessionEnvFields: null` — i.e. `sessionEnvFieldsEqual` finds no diff and no second `agent.session.env` would be built or sent.
- No other "must not"/non-goal language appears in the requirements beyond these three; all are honored as above.
