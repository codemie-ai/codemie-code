# Exclude non-CodeMie-owned sessions from analytics (EPMCDME-13367) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** By default, `codemie analytics` excludes non-CodeMie-owned native sessions (tagged `provider: 'native-external'` by `native-loader.ts`) from output and from all aggregated totals, with an opt-in `--include-external` flag that restores today's exact behavior.

**Architecture:** Add a single filter step in `SessionsSource.load()` — the one seam where natively-discovered sessions merge into the pipeline shared by console output, JSON/CSV export, and the HTML report — that drops any session whose `startEvent.data.provider === 'native-external'` unless a new `includeExternal` option is set. Thread that option from a new `--include-external` CLI flag through `AnalyticsOptions` → `SourceLoadOptions` → the filter. No changes to `native-loader.ts`, `aggregator.ts`, or `formatter.ts`.

**Tech Stack:** TypeScript (ES modules), Commander.js (CLI), Vitest (unit tests).

## Global Constraints

- ES modules with `.js` extensions on all relative imports (per `AGENTS.md`).
- `native-loader.ts` is NOT modified — preserves CR-002 (bounded transcript scan), CR-003 (index-first ownership check), CR-R-002 (`_metrics.json` suffix filtering).
- `aggregator.ts` and `formatter.ts` are NOT modified.
- `--include-external` means "restore full pre-fix behavior" (included, tagged, contributing to totals) — not a diagnostic-only/display-only mode (architecturally infeasible without touching 15+ `reduce()` call sites in `aggregator.ts`; out of scope per spec non-goals).
- No changes to `AnalyticsFilter` — `includeExternal` is a source-level behavior modifier, not a filter criterion.
- Unit test coverage only; no integration-level (`tests/integration/`) CLI test (per spec non-goals).

---

### Task 1: Exclude `native-external` sessions in `SessionsSource.load()`

**Files:**
- Modify: `src/cli/commands/analytics/sources/types.ts` (add `includeExternal?: boolean` to `SourceLoadOptions`)
- Modify: `src/cli/commands/analytics/types.ts:233-251` (add `includeExternal?: boolean` to `AnalyticsOptions`)
- Modify: `src/cli/commands/analytics/sources/sessions-source.ts`
- Test: `src/cli/commands/analytics/sources/__tests__/sessions-source.test.ts` (new file)

**Interfaces:**
- Consumes: `RawSessionData` (from `../data-loader.js`) — `{ sessionId: string, startEvent?: SessionStartEvent, endEvent?: SessionEndEvent, deltas: MetricDelta[], agentSessionFile?: string }`. `SessionStartEvent.data.provider` is a plain `string` (`'native'` or `'native-external'` for native sessions).
- Consumes: `loadNativeSessions(filter?: AnalyticsFilter, deps?: NativeLoaderDeps): Promise<RawSessionData[]>` (from `../native-loader.js`, unchanged).
- Consumes: `MetricsDataLoader` (from `../data-loader.js`, unchanged) — `loadSessions(filter?: AnalyticsFilter): RawSessionData[]`, `sessionMatchesFilter(s: RawSessionData, filter?: AnalyticsFilter): boolean`.
- Produces: `SourceLoadOptions.includeExternal?: boolean` — consumed by Task 2's CLI wiring in `index.ts`.

- [ ] **Step 1: Write the failing tests**

Create `src/cli/commands/analytics/sources/__tests__/sessions-source.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RawSessionData } from '../../data-loader.js';

const mockLoadSessions = vi.fn();
const mockSessionMatchesFilter = vi.fn();

vi.mock('../../data-loader.js', () => ({
  MetricsDataLoader: vi.fn().mockImplementation(() => ({
    loadSessions: mockLoadSessions,
    sessionMatchesFilter: mockSessionMatchesFilter
  }))
}));

const mockLoadNativeSessions = vi.fn();

vi.mock('../../native-loader.js', () => ({
  loadNativeSessions: mockLoadNativeSessions
}));

function makeSession(sessionId: string, provider: string): RawSessionData {
  return {
    sessionId,
    startEvent: {
      recordId: sessionId,
      type: 'session_start',
      timestamp: 0,
      codeMieSessionId: sessionId,
      agentName: 'claude',
      syncStatus: 'synced',
      data: { provider, workingDirectory: '/tmp', startTime: 0 }
    },
    deltas: []
  };
}

describe('SessionsSource', () => {
  beforeEach(() => {
    mockLoadSessions.mockReturnValue([]);
    mockSessionMatchesFilter.mockReturnValue(true);
    mockLoadNativeSessions.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('excludes native-external sessions by default', async () => {
    const owned = makeSession('owned-1', 'native');
    const external = makeSession('external-1', 'native-external');
    mockLoadNativeSessions.mockResolvedValue([owned, external]);

    const { SessionsSource } = await import('../sessions-source.js');
    const source = new SessionsSource();
    const result = await source.load({ filter: {} });

    expect(result.rawSessions.map((s) => s.sessionId)).toEqual(['owned-1']);
  });

  it('includes native-external sessions when includeExternal is true', async () => {
    const owned = makeSession('owned-1', 'native');
    const external = makeSession('external-1', 'native-external');
    mockLoadNativeSessions.mockResolvedValue([owned, external]);

    const { SessionsSource } = await import('../sessions-source.js');
    const source = new SessionsSource();
    const result = await source.load({ filter: {}, includeExternal: true });

    expect(result.rawSessions.map((s) => s.sessionId).sort()).toEqual(['external-1', 'owned-1']);
  });

  it('always includes owned native sessions regardless of includeExternal', async () => {
    const owned = makeSession('owned-1', 'native');
    mockLoadNativeSessions.mockResolvedValue([owned]);

    const { SessionsSource } = await import('../sessions-source.js');
    const source = new SessionsSource();
    const result = await source.load({ filter: {} });

    expect(result.rawSessions.map((s) => s.sessionId)).toEqual(['owned-1']);
  });

  it('applies sessionMatchesFilter before the external-session filter', async () => {
    const external = makeSession('external-1', 'native-external');
    mockLoadNativeSessions.mockResolvedValue([external]);
    mockSessionMatchesFilter.mockReturnValue(false);

    const { SessionsSource } = await import('../sessions-source.js');
    const source = new SessionsSource();
    const result = await source.load({ filter: {}, includeExternal: true });

    expect(result.rawSessions).toEqual([]);
    expect(mockSessionMatchesFilter).toHaveBeenCalledWith(external, {});
  });

  it('includes tracked sessions from the loader unconditionally', async () => {
    const tracked = makeSession('tracked-1', 'native');
    mockLoadSessions.mockReturnValue([tracked]);
    mockLoadNativeSessions.mockResolvedValue([]);

    const { SessionsSource } = await import('../sessions-source.js');
    const source = new SessionsSource();
    const result = await source.load({ filter: {} });

    expect(result.rawSessions.map((s) => s.sessionId)).toEqual(['tracked-1']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cli/commands/analytics/sources/__tests__/sessions-source.test.ts`
Expected: FAIL — the `includeExternal` case fails because `SourceLoadOptions` has no such property yet (TS compile error under vitest's esbuild transform is treated as a runtime failure), and the default-exclusion test fails because `sessions-source.ts` currently pushes every native session unfiltered.

- [ ] **Step 3: Add `includeExternal` to the option types**

In `src/cli/commands/analytics/sources/types.ts`, change:

```typescript
export interface SourceLoadOptions {
  filter: AnalyticsFilter;
  /** Sessions source only: skip native agent-log discovery. Ignored by other sources. */
  scanNative?: boolean;
}
```

to:

```typescript
export interface SourceLoadOptions {
  filter: AnalyticsFilter;
  /** Sessions source only: skip native agent-log discovery. Ignored by other sources. */
  scanNative?: boolean;
  /** Sessions source only: include non-CodeMie-owned native sessions (tagged 'native-external') in output. Ignored by other sources. */
  includeExternal?: boolean;
}
```

In `src/cli/commands/analytics/types.ts`, change the `AnalyticsOptions` interface (lines 233-251) so the block right after `scanNative` reads:

```typescript
  /** When false (via --no-scan-native), skip native-log discovery and use tracked sessions only. */
  scanNative?: boolean;
  /** When true (via --include-external), include non-CodeMie-owned native sessions in output (matches pre-fix behavior). */
  includeExternal?: boolean;
}
```

- [ ] **Step 4: Implement the filter in `SessionsSource.load()`**

In `src/cli/commands/analytics/sources/sessions-source.ts`, change:

```typescript
    if (opts.scanNative !== false) {
      try {
        const { loadNativeSessions } = await import('../native-loader.js');
        const natives = (await loadNativeSessions(opts.filter)).filter((s) =>
          loader.sessionMatchesFilter(s, opts.filter)
        );
        rawSessions.push(...natives);
      } catch (error) {
        logger.debug('Native session discovery failed (continuing with tracked sessions):', error);
      }
    }
```

to:

```typescript
    if (opts.scanNative !== false) {
      try {
        const { loadNativeSessions } = await import('../native-loader.js');
        const natives = (await loadNativeSessions(opts.filter))
          .filter((s) => loader.sessionMatchesFilter(s, opts.filter))
          .filter((s) => opts.includeExternal || s.startEvent?.data.provider !== 'native-external');
        rawSessions.push(...natives);
      } catch (error) {
        logger.debug('Native session discovery failed (continuing with tracked sessions):', error);
      }
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/cli/commands/analytics/sources/__tests__/sessions-source.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/analytics/sources/types.ts src/cli/commands/analytics/types.ts src/cli/commands/analytics/sources/sessions-source.ts src/cli/commands/analytics/sources/__tests__/sessions-source.test.ts
git commit -m "fix(analytics): exclude non-CodeMie-owned native sessions by default (EPMCDME-13367)"
```

---

### Task 2: Wire `--include-external` CLI flag

**Files:**
- Modify: `src/cli/commands/analytics/index.ts:21-23` (register the flag on the default source command)
- Modify: `src/cli/commands/analytics/index.ts:65` (thread the option into `source.load()`)

**Interfaces:**
- Consumes: `SourceLoadOptions.includeExternal` (produced by Task 1) and `AnalyticsOptions.includeExternal` (produced by Task 1).
- Produces: the `--include-external` CLI flag, parsed by Commander into `options.includeExternal: boolean | undefined`.

**Test-first: no** — this task only wires an existing, already-tested option through Commander's option parser into a call site; there is no new branching logic to unit-test, and an end-to-end CLI test is explicitly out of scope per the spec's non-goals (unit coverage at the seam in Task 1 is sufficient). Verified manually in Step 3 below instead.

- [ ] **Step 1: Register the flag**

In `src/cli/commands/analytics/index.ts`, change:

```typescript
  // Default source: local CodeMie-tracked sessions + native agent logs.
  applyCommonOptions(command)
    .option('--no-scan-native', 'Skip native agent-log discovery (use only CodeMie-tracked sessions)')
    .action((options: AnalyticsOptions) => runAnalytics(options, new SessionsSource()));
```

to:

```typescript
  // Default source: local CodeMie-tracked sessions + native agent logs.
  applyCommonOptions(command)
    .option('--no-scan-native', 'Skip native agent-log discovery (use only CodeMie-tracked sessions)')
    .option('--include-external', 'Include non-CodeMie-owned native sessions in output (opt-in; matches pre-fix behavior)')
    .action((options: AnalyticsOptions) => runAnalytics(options, new SessionsSource()));
```

- [ ] **Step 2: Thread the option into `source.load()`**

In `src/cli/commands/analytics/index.ts`, change:

```typescript
    const { rawSessions, cost } = await source.load({ filter, scanNative: options.scanNative });
```

to:

```typescript
    const { rawSessions, cost } = await source.load({
      filter,
      scanNative: options.scanNative,
      includeExternal: options.includeExternal
    });
```

- [ ] **Step 3: Manually verify the flag is registered**

Run: `node bin/codemie.js analytics --help`
Expected: output includes a line for `--include-external  Include non-CodeMie-owned native sessions in output (opt-in; matches pre-fix behavior)`.

- [ ] **Step 4: Typecheck and run the full analytics test suite**

Run: `npm run typecheck && npx vitest run src/cli/commands/analytics`
Expected: no errors; all analytics tests (including Task 1's new file, `aggregator.test.ts`, and `native-loader.test.ts`, which are unchanged and still pass) are green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/analytics/index.ts
git commit -m "feat(analytics): add --include-external escape hatch for the exclusion fix (EPMCDME-13367)"
```
