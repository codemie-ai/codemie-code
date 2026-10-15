# Spec: EPMCDME-15967 — Write-tool lines are not counted in agent.session.summary

## Problem

`agent.session.summary`'s `lines_added`/`lines_removed` undercount a session's actual line changes. A session that creates a 5-line file via `Write` and then edits one line via `Edit` reports `lines_added=1, lines_removed=1` (net lines = 0) instead of the expected `lines_added=6, lines_removed=1` (net lines = +5). The Write's content is silently dropped.

## Root cause

`collectEditLineStats` in `src/agents/plugins/claude-code-otlp/transcript/session-signals.ts` (lines 83-112) discriminates what kind of tool result it's looking at by field *shape*, with this branch order:

```ts
if (Array.isArray(structuredPatch)) {
  // counts +/- lines in the patch
} else if (type === 'create' && typeof content === 'string') {
  // counts content lines
}
```

A real `Write` tool result carries **both** `type: 'create'` and `structuredPatch: []` (an empty array) simultaneously — confirmed from two independent real transcript fixtures (`tests/integration/session/fixtures/session-196820da.jsonl:231` and `tests/integration/session/fixtures/claude/-tmp-private/4c2ddfdc-b619-4525-8d03-1950fb1b0257.jsonl:8`):

```json
{ "type": "create", "filePath": "...", "content": "...", "structuredPatch": [], "originalFile": null }
```

Because `Array.isArray([])` is `true`, the first branch always wins, computing `{added: 0, removed: 0}` from the empty patch. The `else if (type === 'create' ...)` branch — which correctly handles Write and already exists — is unreachable whenever `structuredPatch` is present, even empty. This is a branch-ordering bug, not a missing-case bug.

Reproduced directly: calling `collectEditLineStats` with the real Write shape above returns `{ linesAdded: 0, linesRemoved: 0 }` instead of counting the content's lines.

## Fix

### 1. Reorder the discrimination in `collectEditLineStats`

Check `type === 'create' && typeof content === 'string'` **before** `Array.isArray(structuredPatch)`, so a Write result is recognized by its `type` first and an Edit result (which never carries `type: 'create'`) falls through to the `structuredPatch` branch as before.

### 2. Correct the stale doc comments

Two doc comments assert a false mutual-exclusivity between `structuredPatch` and `type: 'create'`:
- `session-signals.ts:76-81` (above `collectEditLineStats`)
- `orchestrator.ts:192-198` (the "Known limitations" note above `buildFullAccumulator`)

Both should be rewritten to state the actual, overlapping field shapes and that `type === 'create'` is checked first for that reason.

### 3. Reconcile the stale sub-stage spec

`docs/superpowers/tasks/2026-10-01-epmcdme-15301-stage-1-1/spec.md:128-129` still documents "lines_added/lines_removed (agent.session.summary) always emit 0" as an accepted limitation. This predates the current Edit-counting implementation and is now fully stale once Write-counting also lands. Update that line to state both Edit and Write are counted from the applied `toolUseResult`.

## Tests

- `src/agents/plugins/claude-code-otlp/transcript/__tests__/session-signals.test.ts`: add a case to the `collectEditLineStats` describe block using the real-world dual-field shape (`{ type: 'create', content, structuredPatch: [], originalFile: null }`), asserting `linesAdded` reflects the content's line count (not 0) and `linesRemoved` is 0.
- `src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts`: add a Write-shaped `toolUseResult` fixture (dual-field shape) alongside the existing Edit-shaped fixture in the `buildFullAccumulator`/summary-event test, asserting the emitted `lines_added` reflects both the Write's content and the Edit's diff.

## Out of scope

- Files created via Bash (heredoc, scripts) remaining invisible to this line-counting mechanism — explicitly called out as out of scope in the bug report itself (would need the git snapshot from sub-stage 1.2).
- `NotebookEdit`/`MultiEdit` payload shape verification — no real fixture exists either way in this repo, and neither tool type is observed to hit this bug today. Left as-is.
- Retroactively correcting previously-emitted miscounts already persisted in the external analytics backend — out of repo scope.

## Design decision (user-confirmed)

Discriminate by checking `type === 'create'` first (reordering the existing conditions), rather than switching to full tool-name-based discrimination (as `src/agents/plugins/claude/session/claude-file-operation.ts` does for the legacy `claude` plugin). This is the minimal fix that matches the real-world data shapes confirmed in this repo's fixtures.
