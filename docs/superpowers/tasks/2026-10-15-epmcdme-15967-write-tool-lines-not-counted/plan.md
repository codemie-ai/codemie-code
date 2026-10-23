# EPMCDME-15967: Write-tool lines counted in agent.session.summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `collectEditLineStats` so a `Write` tool's created-file content lines are counted into `agent.session.summary`'s `lines_added`, instead of being silently dropped to `0` by a branch that's permanently unreachable for real Write results.

**Architecture:** One pure function in `session-signals.ts` discriminates "Edit diff" vs. "Write create" by checking two fields whose presence the code assumes is mutually exclusive — it isn't, for real transcripts. Reorder the two checks so `type === 'create'` wins before `Array.isArray(structuredPatch)` is even considered; update the two doc comments that assert the false exclusivity; reconcile one now-stale spec line from an earlier task that still claims line counts "always emit 0".

**Tech Stack:** TypeScript, Vitest (`--project unit`).

**Spec:** `docs/superpowers/tasks/2026-10-15-epmcdme-15967-write-tool-lines-not-counted/spec.md`

## Global Constraints

- Line counts must keep coming from the applied `toolUseResult` (not the proposed `tool_use.input`) — an edit/write could have failed; this design intent is explicitly called out as sound and must be preserved.
- `linesAdded`/`linesRemoved` must keep the "null means unmeasured, 0 means measured" convention: they start `null` and only become numbers once some result was actually counted.
- Do not touch `NotebookEdit`/`MultiEdit` handling — no real fixture exists for either in this repo, and neither tool type is observed to hit this bug today (spec: out of scope).
- Do not touch Bash-created-file invisibility — explicitly out of scope per the ticket (needs the sub-stage 1.2 git snapshot).
- Do not change the public signature of `collectEditLineStats(lines: readonly SignalLine[]): EditLineStats` — `orchestrator.ts:275` is its only production caller and must not need updating.

## Review Focus

- A session that mixes multiple `Write` and `Edit` results across a cumulative recompute (not just one of each) — the summation itself, not just a single result's classification, is what the fix must get right.
- The ticket's own exact repro shape — one `Write` (content lines) followed by one `Edit` (diff lines) in the same session — must sum both contributions, not just the Edit's.
- A `Write` result whose `content` is `''` (empty file) must still correctly resolve through the (now-reordered) `type === 'create'` branch and report `0`, not fall through to a different code path that also happens to report `0` for the wrong reason.
- An `Edit` result (no `type` field at all, just `structuredPatch`) must still take the `structuredPatch` branch after the reorder — the fix must not break the only case that already worked.
- Session-level: `files_written`/`files_edited`/`files_changed` (computed by `orchestrator.ts`'s separate Pass 3 over `tool_use` inputs) are already correct per the bug report (`files_written=1`) and must stay unaffected by this change — the fix touches only `collectEditLineStats`, never Pass 3.

---

### Task 1: Fix `collectEditLineStats`'s branch order and its doc comments

**Files:**
- Modify: `src/agents/plugins/claude-code-otlp/transcript/session-signals.ts:76-112` (doc comment + `collectEditLineStats`)
- Modify: `src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts:192-198` (doc comment only, in `buildFullAccumulator`'s "Known limitations" note)
- Test: `src/agents/plugins/claude-code-otlp/transcript/__tests__/session-signals.test.ts`
- Test: `src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts`

**Interfaces:**
- Consumes: existing `SignalLine`, `EditLineStats` types and `countPatchLines`/`countContentLines` helpers in `session-signals.ts` — none of these change.
- Produces: `collectEditLineStats(lines: readonly SignalLine[]): EditLineStats` — signature unchanged; only its internal branch order changes. `orchestrator.ts`'s call site (`buildFullAccumulator`, line 275) needs no change.

- [ ] **Step 1: Write failing unit tests in `session-signals.test.ts`**

Add inside the existing `describe('collectEditLineStats', ...)` block (`src/agents/plugins/claude-code-otlp/transcript/__tests__/session-signals.test.ts`), after the last existing `it(...)` ("tolerates malformed hunks", ending at line 84) and before that `describe` block's closing `});` (line 85):

```ts
it('counts a Write result that also carries an empty structuredPatch (the real transcript shape)', () => {
  const write = (content: string): SignalLine => ({
    type: 'user',
    toolUseResult: { type: 'create', content, structuredPatch: [], originalFile: null },
  });
  expect(collectEditLineStats([write('a\nb\nc\nd\ne')])).toEqual({ linesAdded: 5, linesRemoved: 0 });
  expect(collectEditLineStats([write('')])).toEqual({ linesAdded: 0, linesRemoved: 0 });
});

it('still counts an Edit result (structuredPatch, no type field) as a diff, not a create', () => {
  const edit: SignalLine = {
    type: 'user',
    toolUseResult: { structuredPatch: [{ lines: ['-old', '+new'] }] },
  };
  expect(collectEditLineStats([edit])).toEqual({ linesAdded: 1, linesRemoved: 1 });
});
```

- [ ] **Step 2: Run the unit test file and confirm the new Write case fails**

Run: `npx vitest run --project unit src/agents/plugins/claude-code-otlp/transcript/__tests__/session-signals.test.ts`
Expected: the first new test (`'counts a Write result...'`) FAILS on its first assertion — actual `{ linesAdded: 0, linesRemoved: 0 }` vs. expected `{ linesAdded: 5, linesRemoved: 0 }`. The second new test (Edit-only) and all pre-existing tests PASS (the bug only affects the Write/`structuredPatch`-together shape).

- [ ] **Step 3: Write failing integration tests in `orchestrator.test.ts`**

Add a `writeResult` fixture immediately after the existing `editResult` fixture (`src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts:326-329`):

```ts
const writeResult = userLine(
  [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }],
  { toolUseResult: { type: 'create', content: 'line1\nline2\nline3\nline4\nline5', structuredPatch: [], originalFile: null } }
);
```

Then add two new `it(...)` cases inside the existing `describe('openMainTranscriptPass — summary transcript signals', ...)` block, after the existing cumulative test (ending at line 395) and before that `describe` block's closing `});` (line 396):

```ts
it("counts a Write result's content lines alongside a later Edit's diff (the ticket's exact repro)", async () => {
  const summary = await runFinalSummary('session-write-then-edit', [writeResult, editResult]);
  expect(summary.lines_added).toBe(7); // 5 (Write content) + 2 (Edit's structuredPatch added lines)
  expect(summary.lines_removed).toBe(1);
});

it('sums multiple Write and Edit results cumulatively across a recompute', async () => {
  const sessionId = 'session-mixed-cumulative';
  const transcriptPath = writeTranscript('transcript-mixed-cumulative.jsonl', [writeResult, editResult]);
  await mainEvents(sessionId, transcriptPath, 'Stop');

  writeFileSync(
    transcriptPath,
    [writeResult, editResult, writeResult, editResult].map((l) => l + '\n').join('')
  );
  const events = parseAll(await mainEvents(sessionId, transcriptPath, 'SessionEnd'));
  const summary = events.filter((e) => e.type === 'agent.session.summary')[0];

  expect(summary.lines_added).toBe(14); // 2 x (5 Write + 2 Edit)
  expect(summary.lines_removed).toBe(2); // 2 x 1 Edit
});
```

- [ ] **Step 4: Run the integration test file and confirm both new cases fail**

Run: `npx vitest run --project unit src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts`
Expected: both new tests FAIL on `lines_added` (actual `4` and `8` respectively — Edit-only contributions — vs. expected `7` and `14`), confirming the bug reproduces end-to-end through `agent.session.summary`.

- [ ] **Step 5: Implement the fix in `collectEditLineStats`**

In `src/agents/plugins/claude-code-otlp/transcript/session-signals.ts`, reorder the two branches (currently lines 97-104) so the `type === 'create'` check runs first:

Before:
```ts
    let added: number | null = null;
    let removed = 0;
    if (Array.isArray(structuredPatch)) {
      const counts = countPatchLines(structuredPatch);
      added = counts.added;
      removed = counts.removed;
    } else if (type === 'create' && typeof content === 'string') {
      added = countContentLines(content);
    }
```

After:
```ts
    let added: number | null = null;
    let removed = 0;
    if (type === 'create' && typeof content === 'string') {
      added = countContentLines(content);
    } else if (Array.isArray(structuredPatch)) {
      const counts = countPatchLines(structuredPatch);
      added = counts.added;
      removed = counts.removed;
    }
```

- [ ] **Step 6: Run both test files and confirm everything passes**

Run: `npx vitest run --project unit src/agents/plugins/claude-code-otlp/transcript/__tests__/session-signals.test.ts src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts`
Expected: PASS — all new and pre-existing tests in both files.

- [ ] **Step 7: Fix the two stale doc comments**

In `session-signals.ts`, the comment block above `collectEditLineStats` (lines 76-81) currently reads:

```
/**
 * Sum the diff stats of every tool result that reports one.
 *
 * Claude Code attaches the applied change to the user line carrying the `tool_result`:
 * `toolUseResult.structuredPatch` for edits, and `toolUseResult.type === 'create'` plus the file
 * `content` for new files. A failed edit has neither, so only applied edits are counted.
 */
```

Replace the second paragraph so it no longer implies the two fields are mutually exclusive:

```
/**
 * Sum the diff stats of every tool result that reports one.
 *
 * Claude Code attaches the applied change to the user line carrying the `tool_result`:
 * `toolUseResult.structuredPatch` for edits, and `toolUseResult.type === 'create'` plus the file
 * `content` for new files — a real Write result carries both `type: 'create'` and an *empty*
 * `structuredPatch` simultaneously, so `type === 'create'` is checked first. A failed edit has
 * neither, so only applied edits are counted.
 */
```

In `orchestrator.ts`, the "Known limitations" bullet above `buildFullAccumulator` (lines 196-198) currently reads:

```
 * - Lines added/removed come from the applied diff on the `tool_result` line
 *   (`toolUseResult.structuredPatch`, or a `create` result's `content`), not from the `tool_use`
 *   input, which only carries the *proposed* edit. They stay `null` until one such result is seen.
```

Replace it to match the corrected assumption:

```
 * - Lines added/removed come from the applied diff on the `tool_result` line
 *   (`toolUseResult.structuredPatch` for Edit, or a `create` result's `content` for Write — the two
 *   fields are not mutually exclusive on a real Write result, so `type === 'create'` is checked
 *   first), not from the `tool_use` input, which only carries the *proposed* edit. They stay `null`
 *   until one such result is seen.
```

- [ ] **Step 8: Commit**

```bash
git add src/agents/plugins/claude-code-otlp/transcript/session-signals.ts \
        src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts \
        src/agents/plugins/claude-code-otlp/transcript/__tests__/session-signals.test.ts \
        src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts
git commit -m "fix(claude-code-otlp): count Write-tool content lines in agent.session.summary

collectEditLineStats checked Array.isArray(structuredPatch) before
type === 'create', but a real Write result carries both type:'create' and
an empty structuredPatch simultaneously, so the Write branch was
unreachable and its content lines were never counted (EPMCDME-15967)."
```

---

### Task 2: Reconcile the stale EPMCDME-15301 sub-stage 1.1 spec line

**Files:**
- Modify: `docs/superpowers/tasks/2026-10-01-epmcdme-15301-stage-1-1/spec.md:128-129`

**Interfaces:** None — documentation-only change, no code or test surface.

- [ ] **Step 1: Update the stale "Known limitations" bullet**

In `docs/superpowers/tasks/2026-10-01-epmcdme-15301-stage-1-1/spec.md`, under `## Open risks` → `**Known limitations, accepted as-is for this sub-stage:**`, replace the `lines_added`/`lines_removed` bullet (lines 128-129):

Before:
```
  - `lines_added`/`lines_removed` (`agent.session.summary`) always emit `0`. An `Edit`/`Write` tool_use's `input` carries the *proposed* edit, not a diff stat, so no reliable added/removed line count can be derived from it without re-implementing diffing — out of scope for this sub-stage.
```

After:
```
  - `lines_added`/`lines_removed` (`agent.session.summary`) are derived from the applied `toolUseResult` on each `Edit`/`Write` tool call (not the *proposed* `tool_use.input`, since an edit could fail): `structuredPatch` for `Edit`, and `type === 'create'` plus `content` for `Write`. Both are counted as of EPMCDME-15967. Values stay `null` until at least one such result is seen; they do not reflect files created via Bash (heredoc, scripts) — that remains out of scope pending the git snapshot in sub-stage 1.2.
```

Leave every other bullet in that "Known limitations" list unchanged — they are unrelated to this fix.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/tasks/2026-10-01-epmcdme-15301-stage-1-1/spec.md
git commit -m "docs: reconcile stale lines_added/removed limitation in EPMCDME-15301 spec

The sub-stage 1.1 spec still claimed line counts always emit 0; EPMCDME-15967
fixes Write-tool counting on top of the Edit-only counting that already
shipped, so the 'always 0' claim is now fully stale."
```
