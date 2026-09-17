# Analytics `--session` Filter Bug Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `codemie analytics --report --session <id>` (and every other `--session`-filtered analytics invocation) return exactly the requested session instead of every local session.

**Architecture:** Both bugs live in `MetricsDataLoader` (`src/cli/commands/analytics/data-loader.ts`). Fix them independently: (1) the private `matchesFilter()` method — reused publicly as `sessionMatchesFilter()` by the native-session path in `sessions-source.ts` — never checks `filter.sessionId`; (2) `loadSessions()` derives `sessionId` from the on-disk filename without stripping the `completed_` prefix that `hook.ts` adds on `SessionEnd`, so a completed session's derived ID (`"completed_<uuid>"`) never equals the bare UUID passed via `--session`. Fixing (2) requires `loadSession()` to resolve the actual file on disk (which may still carry the `completed_` prefix) from the now-bare `sessionId`, mirroring the fallback already used in `src/cli/commands/log/reader.ts`.

**Tech Stack:** TypeScript (ES modules, `.js` import extensions), Vitest ^4.1.5 (`unit` project — `src/**/*.test.ts`), Node.js `fs`/`path`.

## Global Constraints

- Only modify `src/cli/commands/analytics/data-loader.ts` (source) plus one new test file. Do not touch `src/cli/commands/analytics/sources/otel-source.ts` — its existing sessionId workaround is correct and out of scope.
- Do not extract a shared `stripCompletedPrefix`/file-resolution utility across `log/reader.ts`, `log/cleaner.ts`, and `data-loader.ts` — that cross-cutting refactor is explicitly out of scope for this fix.
- All imports use the `.js` extension (project convention, verified in `data-loader.ts` itself).
- New tests live at `src/cli/commands/analytics/__tests__/data-loader.test.ts`, run via the `unit` Vitest project (`npm run test:unit`).
- Test-first for every code change (TDD): write the failing test before touching `data-loader.ts`.

---

### Task 1: `matchesFilter()` / `sessionMatchesFilter()` must check `filter.sessionId`

**Test-first: yes — new tests asserting `sessionMatchesFilter()` returns `false` when `sessionId` differs from the filter, and `true` when it matches; the "differs" case currently returns `true` (bug) and will fail first.**

**Files:**
- Create: `src/cli/commands/analytics/__tests__/data-loader.test.ts`
- Modify: `src/cli/commands/analytics/data-loader.ts:258-266` (inside `matchesFilter()`)

**Interfaces:**
- Consumes: `MetricsDataLoader` (default export class), `RawSessionData` — both already exported from `src/cli/commands/analytics/data-loader.ts`. `RawSessionData` shape: `{ sessionId: string; startEvent?: SessionStartEvent; endEvent?: SessionEndEvent; deltas: MetricDelta[]; agentSessionFile?: string }`. `SessionStartEvent.data` shape: `{ provider: string; workingDirectory: string; startTime: number }`.
- Produces: no new public API — `sessionMatchesFilter(sessionData: RawSessionData, filter?: AnalyticsFilter): boolean` behavior changes (now honors `filter.sessionId`). Task 2 reuses this same test file and the same `rawSession()` helper.

- [ ] **Step 1: Write the failing test file**

Create `src/cli/commands/analytics/__tests__/data-loader.test.ts`:

```typescript
/**
 * Unit tests for MetricsDataLoader's session-id filtering — regression coverage for
 * the bug where `--session <id>` silently matched every session (see Task 1 + Task 2).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MetricsDataLoader, type RawSessionData } from '../data-loader.js';

function rawSession(sessionId: string): RawSessionData {
  return {
    sessionId,
    startEvent: {
      recordId: sessionId,
      type: 'session_start',
      timestamp: 1000,
      codeMieSessionId: sessionId,
      agentName: 'claude',
      syncStatus: 'synced',
      data: {
        provider: 'anthropic',
        workingDirectory: '/tmp/project',
        startTime: 1000,
      },
    },
    deltas: [],
  };
}

describe('MetricsDataLoader.sessionMatchesFilter', () => {
  it('matches when sessionId equals the filter sessionId', () => {
    const loader = new MetricsDataLoader('/nonexistent');
    const session = rawSession('abc-123');
    expect(loader.sessionMatchesFilter(session, { sessionId: 'abc-123' })).toBe(true);
  });

  it('rejects when sessionId differs from the filter sessionId', () => {
    const loader = new MetricsDataLoader('/nonexistent');
    const session = rawSession('abc-123');
    expect(loader.sessionMatchesFilter(session, { sessionId: 'other-999' })).toBe(false);
  });

  it('matches any session when no sessionId filter is set', () => {
    const loader = new MetricsDataLoader('/nonexistent');
    const session = rawSession('abc-123');
    expect(loader.sessionMatchesFilter(session, { agentName: 'claude' })).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:unit -- src/cli/commands/analytics/__tests__/data-loader.test.ts`
Expected: FAIL on `'rejects when sessionId differs from the filter sessionId'` — `matchesFilter()` currently ignores `filter.sessionId` entirely, so it returns `true` instead of the expected `false`. The other two tests pass already (they don't exercise the gap).

- [ ] **Step 3: Implement the minimal fix**

In `src/cli/commands/analytics/data-loader.ts`, inside `matchesFilter()`, add the `sessionId` check immediately after the `!filter` guard (before the `startEvent` guard, so it's checked even if `startEvent` is somehow absent):

```typescript
  private matchesFilter(sessionData: RawSessionData, filter?: AnalyticsFilter): boolean {
    if (!filter) {
      return true;
    }

    // Filter by session ID
    if (filter.sessionId && sessionData.sessionId !== filter.sessionId) {
      return false;
    }

    const startEvent = sessionData.startEvent;
    if (!startEvent) {
      return false;
    }
```

(Everything below `const startEvent = sessionData.startEvent;` stays unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:unit -- src/cli/commands/analytics/__tests__/data-loader.test.ts`
Expected: PASS — all 3 tests in the `MetricsDataLoader.sessionMatchesFilter` describe block green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/analytics/data-loader.ts src/cli/commands/analytics/__tests__/data-loader.test.ts
git commit -m "fix(analytics): sessionMatchesFilter now honors filter.sessionId"
```

---

### Task 2: `loadSessions()` must derive the bare UUID for `completed_<uuid>.json` files

**Test-first: yes — new tests asserting `loadSessions()` returns the bare UUID as `sessionId` (not `"completed_<uuid>"`) for a `completed_`-prefixed session file, and correctly narrows to one session when `--session <bare-uuid>` is passed; both fail first against the current filename-derivation bug.**

**Files:**
- Modify: `src/cli/commands/analytics/__tests__/data-loader.test.ts` (add a new `describe` block — same file created in Task 1)
- Modify: `src/cli/commands/analytics/data-loader.ts:132-169` (`loadSessions()` sessionId derivation) and `:174-245` (`loadSession()` file resolution)

**Interfaces:**
- Consumes: `MetricsDataLoader` constructor `(sessionsDir?: string)` — pass a real temp directory (no `CODEMIE_HOME` env manipulation needed since the constructor accepts an explicit directory).
- Produces: `loadSessions(filter?: AnalyticsFilter): RawSessionData[]` now returns the bare UUID in every `RawSessionData.sessionId`, whether the on-disk file is `<uuid>.json` or `completed_<uuid>.json`. New private helper `resolveSessionPath(sessionId: string, suffix: string): string` on `MetricsDataLoader`, used internally by `loadSession()`.

- [ ] **Step 1: Write the failing tests**

Append to `src/cli/commands/analytics/__tests__/data-loader.test.ts` (same file, new `describe` block below the existing one):

```typescript
describe('MetricsDataLoader.loadSessions — completed_ prefixed sessions', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'data-loader-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeCompletedSession(id: string): void {
    writeFileSync(
      join(dir, `completed_${id}.json`),
      JSON.stringify({
        startTime: 1000,
        endTime: 2000,
        status: 'completed',
        agentName: 'claude',
        provider: 'anthropic',
        workingDirectory: '/tmp/project',
      })
    );
  }

  it('derives the bare UUID (not "completed_<uuid>") as sessionId', () => {
    const sessionId = 'eddd66b2-0e73-4167-841c-9263207870ae';
    writeCompletedSession(sessionId);

    const loader = new MetricsDataLoader(dir);
    const sessions = loader.loadSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(sessionId);
  });

  it('filters to exactly the requested completed session by bare UUID', () => {
    const target = 'eddd66b2-0e73-4167-841c-9263207870ae';
    const other = '086cca74-d58d-4007-a529-fa73910c085e';
    writeCompletedSession(target);
    writeCompletedSession(other);

    const loader = new MetricsDataLoader(dir);
    const sessions = loader.loadSessions({ sessionId: target });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(target);
  });

  it('still reads deltas from the completed_-prefixed metrics file', () => {
    const sessionId = 'eddd66b2-0e73-4167-841c-9263207870ae';
    writeCompletedSession(sessionId);
    const delta = { recordId: 'd1', sessionId, syncStatus: 'synced', gitBranch: 'main' };
    writeFileSync(join(dir, `completed_${sessionId}_metrics.jsonl`), JSON.stringify(delta) + '\n');

    const loader = new MetricsDataLoader(dir);
    const sessions = loader.loadSessions({ sessionId });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].deltas).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:unit -- src/cli/commands/analytics/__tests__/data-loader.test.ts`
Expected: FAIL on all 3 new tests in `MetricsDataLoader.loadSessions — completed_ prefixed sessions`:
- Test 1 fails: `sessions[0].sessionId` is `"completed_eddd66b2-0e73-4167-841c-9263207870ae"`, not the bare UUID.
- Test 2 fails: `loadSessions({ sessionId: target })` returns `0` sessions (the filename-derived id never equals `target`), not `1`.
- Test 3 fails: same as test 2 — the session is filtered out entirely, so `sessions` is empty.

- [ ] **Step 3: Implement the minimal fix**

In `src/cli/commands/analytics/data-loader.ts`:

1. Add `existsSync` to the `fs` import at the top of the file:

```typescript
import { readFileSync, readdirSync, existsSync } from 'fs';
```

2. In `loadSessions()`, strip the `completed_` prefix when deriving `sessionId` from the filename:

```typescript
      for (const sessionFile of sessionFiles) {
        // Extract session ID from filename. `hook.ts` renames `<id>.json` to
        // `completed_<id>.json` on SessionEnd — strip that prefix so filtering
        // and the returned sessionId always use the bare UUID (matches the
        // fallback pattern in src/cli/commands/log/reader.ts).
        const sessionId = sessionFile.replace('.json', '').replace(/^completed_/, '');

        // Skip if filtering by session ID
        if (filter?.sessionId && sessionId !== filter.sessionId) {
          continue;
        }
```

3. Update `loadSession()` to resolve the actual on-disk path (which may still carry the `completed_` prefix) from the now-bare `sessionId`, and add the new private helper right after it:

```typescript
  /**
   * Load a single session's records
   */
  private loadSession(sessionId: string): RawSessionData | null {
    const sessionFile = this.resolveSessionPath(sessionId, '.json');
    const metricsFile = this.resolveSessionPath(sessionId, '_metrics.jsonl');

    try {
```

(the rest of `loadSession()`'s body — from `// Read session metadata` through the final `return { sessionId, startEvent, endEvent, deltas };` and its `catch { return null; }` — stays exactly as-is; only the two `const ... = join(...)` lines above them are replaced by the two lines above.)

Add the new helper directly after `loadSession()` (before `sessionMatchesFilter()`):

```typescript
  /**
   * Resolve a session-scoped file path from the bare sessionId: prefer the active
   * filename, fall back to the `completed_` prefix hook.ts renames it to on SessionEnd.
   */
  private resolveSessionPath(sessionId: string, suffix: string): string {
    const active = join(this.sessionsDir, `${sessionId}${suffix}`);
    if (existsSync(active)) {
      return active;
    }
    return join(this.sessionsDir, `completed_${sessionId}${suffix}`);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:unit -- src/cli/commands/analytics/__tests__/data-loader.test.ts`
Expected: PASS — all 6 tests across both `describe` blocks green.

- [ ] **Step 5: Run the full existing analytics + integration suite to confirm no regression**

Run: `npm run test:unit -- src/cli/commands/analytics && npm run test:integration`
Expected: PASS. In particular `tests/integration/analytics.test.ts` (bare-UUID fixture, no `completed_` prefix) must still pass unchanged — `sessionFile.replace('.json', '').replace(/^completed_/, '')` is a no-op for filenames that never had the prefix.

- [ ] **Step 6: Manually verify the original repro**

Run: `codemie analytics --report --session "eddd66b2-0e73-4167-841c-9263207870ae"` (or whichever completed session ID is present under `~/.codemie/sessions/`) in the actual repo checkout.
Expected: the printed `Cost priced for N/N sessions` line shows a session count of `1`, not the full local session count, and the generated HTML report contains exactly that one session.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/analytics/data-loader.ts src/cli/commands/analytics/__tests__/data-loader.test.ts
git commit -m "fix(analytics): loadSessions derives bare UUID for completed_ prefixed session files"
```

---

## Self-Review Notes

- **Coverage**: Task 1 fixes the native-session path (`sessions-source.ts` → `sessionMatchesFilter()` → `matchesFilter()`), which is the primary cause of "report contains all sessions" for native/untracked sessions. Task 2 fixes the tracked-session path (`loadSessions()`) for completed sessions specifically. Both are required — fixing only one leaves the other symptom present, matching the technical analysis's risk indicator.
- **No placeholders**: every step shows the exact diff/code to write; no "add appropriate handling" language.
- **Type consistency**: `RawSessionData`, `AnalyticsFilter`, `SessionStartEvent` names and shapes match the existing exports in `data-loader.ts` and `types.ts` verified during research — no invented types.
- **Out of scope, confirmed not touched by any task**: `src/cli/commands/analytics/sources/otel-source.ts`'s existing sessionId workaround, and any shared-utility extraction across `log/reader.ts` / `log/cleaner.ts` / `data-loader.ts`.
