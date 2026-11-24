# Fix Write-tool trailing-newline line-count overcount (EPMCDME-16306) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Claude `Write`-tool line-counter so it does not overcount by 1 when file content ends with a newline, and make the OTLP collector's identical (but private) counting logic share the same implementation so live collection, native re-parsing, and OTLP collection stay consistent.

**Architecture:** Lift the existing, already-correct `countContentLines()` logic (currently private in the `claude-code-otlp` plugin's `session-signals.ts`) into the Utils layer (`src/utils/file-operations.ts`), since the project's plugin-isolation rule forbids importing one plugin's internals from another. Both `claude-file-operation.ts` (Claude plugin) and `session-signals.ts` (claude-code-otlp plugin) then import and call the single shared helper. `Edit`'s `structuredPatch`-based counting is untouched in both files.

**Tech Stack:** TypeScript, Vitest, ES modules with explicit `.js` import extensions.

**Spec:** EPMCDME-16306 (Jira) — see `docs/superpowers/tasks/2026-10-23-write-tool-overcounts-lines-trailing-newline/technical-analysis.md` for full research.

## Global Constraints

- Fix is scoped to the Claude `Write` path and the OTLP `collectEditLineStats` create-path only. Do not touch `pi-file-operations.ts`, `opencode.metrics-processor.ts`, or `gemini.metrics-processor.ts` — same-shaped bugs there are explicitly out of scope for this ticket.
- `Edit`'s `structuredPatch`-based `+`/`-` line counting must remain byte-for-byte unchanged in both `claude-file-operation.ts` and `session-signals.ts` (AC3).
- `MultiEdit` has no existing line-counting code path (`TOOL_TYPE_MAP` omits it) — no change needed, do not add one.
- New shared helper lives in `src/utils/file-operations.ts` (Utils layer) per architecture's "no Plugin → Plugin imports" rule; it must be a pure, synchronous, side-effect-free function with no new dependencies.
- Preserve the exact existing behavior of `collectEditLineStats()`'s `'create'` branch and its existing test assertions (`session-signals.test.ts` lines 61-70) — the refactor must not regress them.

## Review Focus

- Content ending in `\r\n` (CRLF) must count the same as content ending in `\n` — `endsWith('\n')` is true for both, but no test currently asserts the CRLF case explicitly (AC2).
- A single-line file with no trailing newline (`'a'`) must count as 1 line, not 0 or 2 — boundary case between the empty-string (`0`) and multi-line branches.
- A file consisting of only a trailing newline (`'\n'`) must count as 1 line (one blank line), not 0 — distinct from the empty-string case (`''` → 0).
- Content with a blank line in the middle (`'a\n\nb'`) must count all 3 lines including the blank one — split-based counting must not silently collapse empty segments.
- The `Write` content resolution order in `claude-file-operation.ts` (`res.content || res.file?.content || inp.content`) must still be exercised correctly after the one-line change — a regression here would silently report `undefined`/wrong counts without any new code touching that line.

---

### Task 1: Add `countContentLines` to the Utils layer

**Files:**
- Modify: `src/utils/file-operations.ts`
- Test: `src/utils/__tests__/file-operations.test.ts` (new file — no existing test file for this module)

**Interfaces:**
- Produces: `export function countContentLines(content: string): number` — returns the number of lines in `content`; a trailing `\n` (or `\r\n`) does not start an additional line; `''` returns `0`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { countContentLines } from '../file-operations.js';

describe('countContentLines', () => {
  it('counts lines with no trailing newline', () => {
    expect(countContentLines('a\nb\nc')).toBe(3);
  });

  it('does not count a trailing newline as an extra line', () => {
    expect(countContentLines('a\nb\nc\n')).toBe(3);
  });

  it('returns 0 for empty content', () => {
    expect(countContentLines('')).toBe(0);
  });

  it('counts a single line with no newline as 1', () => {
    expect(countContentLines('a')).toBe(1);
  });

  it('counts content that is only a newline as 1 (one blank line)', () => {
    expect(countContentLines('\n')).toBe(1);
  });

  it('counts a blank line in the middle', () => {
    expect(countContentLines('a\n\nb')).toBe(3);
  });

  it('treats a CRLF-terminated file the same as an LF-terminated one', () => {
    expect(countContentLines('a\r\nb\r\nc\r\n')).toBe(3);
    expect(countContentLines('a\r\nb\r\nc')).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/__tests__/file-operations.test.ts`
Expected: FAIL — `countContentLines` is not exported from `../file-operations.js`.

- [ ] **Step 3: Implement `countContentLines(content: string): number` in `src/utils/file-operations.ts`**

Move the existing logic from `session-signals.ts:69-74` verbatim (`content.length === 0 ? 0 : (content.endsWith('\n') ? split-length - 1 : split-length)`), exported this time, with the same docstring ("a trailing newline does not start another line").

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/__tests__/file-operations.test.ts`
Expected: PASS (all 7 cases)

- [ ] **Step 5: Commit**

```bash
git add src/utils/file-operations.ts src/utils/__tests__/file-operations.test.ts
git commit -m "fix(utils): add shared countContentLines helper for EPMCDME-16306"
```

---

### Task 2: Fix the Claude `Write` path to use the shared helper

**Files:**
- Modify: `src/agents/plugins/claude/session/claude-file-operation.ts:10,74`
- Test: `src/agents/plugins/claude/session/__tests__/claude-file-operation.test.ts`

**Interfaces:**
- Consumes: `countContentLines(content: string): number` from Task 1 (`src/utils/file-operations.js`).

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe('extractClaudeFileOperation', ...)` block:

```ts
it('does not overcount lines when Write content ends with a trailing newline', () => {
  const op = extractClaudeFileOperation('Write', { file_path: '/repo/a.ts', content: 'a\nb\nc\n' }, {
    filePath: '/repo/a.ts',
    content: 'a\nb\nc\n',
  });
  expect(op).toMatchObject({ linesAdded: 3 });
});

it('counts a single-line Write with no trailing newline as 1', () => {
  const op = extractClaudeFileOperation('Write', { file_path: '/repo/a.ts', content: 'a' }, {
    filePath: '/repo/a.ts',
    content: 'a',
  });
  expect(op).toMatchObject({ linesAdded: 1 });
});

it('counts a blank line in the middle of a Write', () => {
  const op = extractClaudeFileOperation('Write', { file_path: '/repo/a.ts', content: 'a\n\nb' }, {
    filePath: '/repo/a.ts',
    content: 'a\n\nb',
  });
  expect(op).toMatchObject({ linesAdded: 3 });
});

it('treats CRLF-terminated Write content the same as LF-terminated', () => {
  const op = extractClaudeFileOperation('Write', { file_path: '/repo/a.ts', content: 'a\r\nb\r\nc\r\n' }, {
    filePath: '/repo/a.ts',
    content: 'a\r\nb\r\nc\r\n',
  });
  expect(op).toMatchObject({ linesAdded: 3 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/plugins/claude/session/__tests__/claude-file-operation.test.ts`
Expected: FAIL on the trailing-newline case — `linesAdded` is `4` instead of `3` (current buggy `split('\n').length` behavior).

- [ ] **Step 3: Implement the fix**

In `claude-file-operation.ts`, add `countContentLines` to the existing import on line 10 (`import { extractFormat, detectLanguage, countContentLines } from '../../../../utils/file-operations.js';`) and replace line 74's `fileOp.linesAdded = content.split('\n').length;` with `fileOp.linesAdded = countContentLines(content);`. Leave the `Edit` branch (lines 76-91) untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/plugins/claude/session/__tests__/claude-file-operation.test.ts`
Expected: PASS (all cases, including the pre-existing `'a\nb\nc'` → `linesAdded: 3` case and the Edit/Bash cases, unchanged)

- [ ] **Step 5: Commit**

```bash
git add src/agents/plugins/claude/session/claude-file-operation.ts src/agents/plugins/claude/session/__tests__/claude-file-operation.test.ts
git commit -m "fix(agents): stop overcounting Write lines on trailing newline (EPMCDME-16306)"
```

---

### Task 3: Refactor OTLP's `session-signals.ts` to delegate to the shared helper

**Files:**
- Modify: `src/agents/plugins/claude-code-otlp/transcript/session-signals.ts:69-74,102-103`
- Test: `src/agents/plugins/claude-code-otlp/transcript/__tests__/session-signals.test.ts` (no new test cases needed — existing `collectEditLineStats` "create" tests at lines 61-70 already pin this behavior and must keep passing)

**Interfaces:**
- Consumes: `countContentLines(content: string): number` from Task 1 (`src/utils/file-operations.js`).

- [ ] **Step 1: Run the existing test to confirm current baseline passes**

Run: `npx vitest run src/agents/plugins/claude-code-otlp/transcript/__tests__/session-signals.test.ts`
Expected: PASS (baseline, before refactor)

- [ ] **Step 2: Implement the refactor**

Add `import { countContentLines } from '../../../../utils/file-operations.js';` to the top of `session-signals.ts` (the file currently has zero imports). Delete the private `countContentLines` function (lines 69-74) and update line 103's call site (`added = countContentLines(content);`) to use the imported function — same call, same signature, now sourced from Utils.

- [ ] **Step 3: Run test to verify it still passes**

Run: `npx vitest run src/agents/plugins/claude-code-otlp/transcript/__tests__/session-signals.test.ts`
Expected: PASS — no behavior change, same assertions as Step 1 (trailing-newline, empty-string, blank-line cases at lines 61-70 all still pass since the logic is identical, just relocated).

- [ ] **Step 4: Commit**

```bash
git add src/agents/plugins/claude-code-otlp/transcript/session-signals.ts
git commit -m "refactor(agents): delegate OTLP line counting to shared countContentLines (EPMCDME-16306)"
```

---

### Task 4: Full regression run across both affected test suites

**Files:**
- No source changes.

**Interfaces:**
- None — verification-only task.

- [ ] **Step 1: Run the full targeted test set**

Run: `npx vitest run src/utils/__tests__/file-operations.test.ts src/agents/plugins/claude/session/__tests__/claude-file-operation.test.ts src/agents/plugins/claude-code-otlp/transcript/__tests__/session-signals.test.ts`
Expected: PASS — all three suites green, confirming Write, Edit, and OTLP create-path counts are consistent (AC4) and Edit counting is unchanged (AC3).

- [ ] **Step 2: Commit (if any residual staged changes remain; typically a no-op)**

```bash
git status --porcelain
```

No commit expected at this step under normal conditions — included only as a final verification gate before moving to code review.
