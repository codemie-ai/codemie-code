# EPMCDME-13643 — Analytics report always populates `userEmail` / `periodStart` / `periodEnd` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `meta.userEmail`, `meta.periodStart`, `meta.periodEnd` present in every JSON/HTML analytics report — for `--from/--to`, `--last`, `--session`, `--project/--branch`, and bare invocations — by deriving fallback periods from session data inside `buildPayload()` and closing the agent-exit `userEmail` gap with a `ConfigLoader` fallback.

**Architecture:** Single choke-point fix inside `buildPayload()` (a pure function) computes `min(startTime)` / `max(startTime + durationMs)` in the same pass that already flattens sessions, filling `periodStart` / `periodEnd` when caller context did not stamp them. Caller-side `parseFilterOptions()` also sets `filter.toDate = new Date()` for `--last` for contract honesty. Separately, `BaseAgentAdapter.maybeWriteSessionReport()` falls back to `ConfigLoader.loadMultiProviderConfig().userEmail` when the `CODEMIE_PROFILE_CONFIG` env var lacks an email.

**Tech Stack:** TypeScript (ES modules, Node ≥ 20), Vitest, chalk, commander.

## Global Constraints

- `buildPayload()` MUST stay a pure function: no I/O, no config reads, no env access. All new derivation must use data already in its arguments (`ReportSessionRecord.startTime` / `durationMs`).
- `ReportMeta.userEmail | periodStart | periodEnd` stay TypeScript-optional (`?: string`). Backward compatibility of report files is preserved.
- If no valid session data is available to derive from, OMIT the field. Do NOT fall back to `generatedAt` or any synthetic value.
- Do NOT modify `src/cli/commands/analytics/report/session-report.ts` — its period derivation is already correct and is the reference pattern.
- Follow project ES-module rules: all imports end in `.js`; use `getDirname(import.meta.url)` if `__dirname` is needed; no `require()`.
- Conditional spread idiom for optional meta fields: `...(value !== undefined && { key: value })`.
- Non-fatal finalization: `userEmail` fallbacks wrap in `try/catch` and omit silently on failure.
- No CLI surface changes: no new flags, no help-text edits, no exit-code changes.
- Tests use Vitest with the existing dynamic-import mock pattern; add cases to existing test files where possible.

---

### Task 1: Derive fallback `periodStart` / `periodEnd` inside `buildPayload()`

**Files:**
- Modify: `src/cli/commands/analytics/report/payload-builder.ts:38-98` (the existing session-flatten loop) and `src/cli/commands/analytics/report/payload-builder.ts:125-147` (the meta assembly).
- Test: `src/cli/commands/analytics/report/__tests__/payload-builder.test.ts`

**Interfaces:**
- Consumes: existing `PayloadContext` (`rangeLabel`, `projectFilter`, `generatedAt`, `userEmail?`, `periodStart?`, `periodEnd?`), existing `RootAnalytics`.
- Produces: unchanged public signature. Behavioral change only: `meta.periodStart` / `meta.periodEnd` are now populated from session data when caller context omits them.

**Test-first: yes — new Vitest cases in `payload-builder.test.ts` that assert `meta.periodStart` and `meta.periodEnd` are derived from `min(startTime)` and `max(startTime + duration)` when the caller context omits them; they must fail against current `payload-builder.ts` before implementation.**

- [ ] **Step 1: Write the failing tests**

Add these tests inside the existing `describe('buildPayload', () => { ... })` block in `src/cli/commands/analytics/report/__tests__/payload-builder.test.ts`. Use the existing `session()` factory and `root` fixture.

```ts
  it('derives meta.periodStart from min(startTime) when ctx omits it', () => {
    const early = session({ sessionId: 's-early', startTime: 1_700_000_000_000, duration: 30_000 });
    const late  = session({ sessionId: 's-late',  startTime: 1_700_000_600_000, duration: 60_000 });
    const rootTwo = {
      ...root,
      projects: [
        { projectPath: '/repo/app', branches: [{ branchName: 'main', sessions: [early, late] }] },
      ],
    } as unknown as RootAnalytics;
    const costIndexTwo: SessionCostIndex = new Map([
      ['s-early', { sessionId: 's-early', tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 }, costUSD: 0, perModel: [], priced: true, hadLog: true }],
      ['s-late',  { sessionId: 's-late',  tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 }, costUSD: 0, perModel: [], priced: true, hadLog: true }],
    ]);
    const payload = buildPayload(rootTwo, costIndexTwo, summary, {
      rangeLabel: 'all',
      projectFilter: 'all',
      generatedAt: '2026-07-27T00:00:00Z',
    });
    expect(payload.meta.periodStart).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('derives meta.periodEnd from max(startTime + duration) when ctx omits it', () => {
    const early = session({ sessionId: 's-early', startTime: 1_700_000_000_000, duration: 30_000 });
    const late  = session({ sessionId: 's-late',  startTime: 1_700_000_600_000, duration: 60_000 });
    const rootTwo = {
      ...root,
      projects: [
        { projectPath: '/repo/app', branches: [{ branchName: 'main', sessions: [early, late] }] },
      ],
    } as unknown as RootAnalytics;
    const costIndexTwo: SessionCostIndex = new Map([
      ['s-early', { sessionId: 's-early', tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 }, costUSD: 0, perModel: [], priced: true, hadLog: true }],
      ['s-late',  { sessionId: 's-late',  tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 }, costUSD: 0, perModel: [], priced: true, hadLog: true }],
    ]);
    const payload = buildPayload(rootTwo, costIndexTwo, summary, {
      rangeLabel: 'all',
      projectFilter: 'all',
      generatedAt: '2026-07-27T00:00:00Z',
    });
    expect(payload.meta.periodEnd).toBe(new Date(1_700_000_600_000 + 60_000).toISOString());
  });

  it('prefers ctx.periodStart / ctx.periodEnd when both provided (regression guard)', () => {
    const payload = buildPayload(root, costIndex, summary, {
      rangeLabel: 'custom',
      projectFilter: 'all',
      generatedAt: '2026-07-27T00:00:00Z',
      periodStart: '2026-01-01T00:00:00.000Z',
      periodEnd: '2026-06-30T00:00:00.000Z',
    });
    expect(payload.meta.periodStart).toBe('2026-01-01T00:00:00.000Z');
    expect(payload.meta.periodEnd).toBe('2026-06-30T00:00:00.000Z');
  });

  it('treats duration=0 as endTime = startTime for periodEnd derivation', () => {
    const only = session({ sessionId: 's-only', startTime: 1_700_000_000_000, duration: 0 });
    const rootOne = {
      ...root,
      projects: [
        { projectPath: '/repo/app', branches: [{ branchName: 'main', sessions: [only] }] },
      ],
    } as unknown as RootAnalytics;
    const costIndexOne: SessionCostIndex = new Map([
      ['s-only', { sessionId: 's-only', tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 }, costUSD: 0, perModel: [], priced: true, hadLog: true }],
    ]);
    const payload = buildPayload(rootOne, costIndexOne, summary, {
      rangeLabel: 'all',
      projectFilter: 'all',
      generatedAt: '2026-07-27T00:00:00Z',
    });
    expect(payload.meta.periodStart).toBe(new Date(1_700_000_000_000).toISOString());
    expect(payload.meta.periodEnd).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('omits meta.periodStart / meta.periodEnd when there are no valid sessions', () => {
    const emptyRoot = {
      totalSessions: 0, totalDuration: 0, totalTurns: 0, totalFileOperations: 0,
      totalLinesAdded: 0, totalLinesRemoved: 0, totalLinesModified: 0, netLinesChanged: 0,
      totalToolCalls: 0, successfulToolCalls: 0, failedToolCalls: 0, toolSuccessRate: 0,
      models: [], tools: [], languages: [], formats: [], projects: [],
    } as unknown as RootAnalytics;
    const payload = buildPayload(emptyRoot, new Map(), summary, {
      rangeLabel: 'all',
      projectFilter: 'all',
      generatedAt: '2026-07-27T00:00:00Z',
    });
    expect(payload.meta.periodStart).toBeUndefined();
    expect(payload.meta.periodEnd).toBeUndefined();
  });

  it('skips records with startTime <= 0 when computing min/max', () => {
    const zero  = session({ sessionId: 's-zero',  startTime: 0, duration: 60_000 });
    const valid = session({ sessionId: 's-valid', startTime: 1_700_000_000_000, duration: 60_000 });
    const rootMixed = {
      ...root,
      projects: [
        { projectPath: '/repo/app', branches: [{ branchName: 'main', sessions: [zero, valid] }] },
      ],
    } as unknown as RootAnalytics;
    const costIndexMixed: SessionCostIndex = new Map([
      ['s-zero',  { sessionId: 's-zero',  tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 }, costUSD: 0, perModel: [], priced: true, hadLog: true }],
      ['s-valid', { sessionId: 's-valid', tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 }, costUSD: 0, perModel: [], priced: true, hadLog: true }],
    ]);
    const payload = buildPayload(rootMixed, costIndexMixed, summary, {
      rangeLabel: 'all',
      projectFilter: 'all',
      generatedAt: '2026-07-27T00:00:00Z',
    });
    expect(payload.meta.periodStart).toBe(new Date(1_700_000_000_000).toISOString());
    expect(payload.meta.periodEnd).toBe(new Date(1_700_000_000_000 + 60_000).toISOString());
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```
npx vitest run src/cli/commands/analytics/report/__tests__/payload-builder.test.ts
```
Expected: the 6 new cases fail. The "prefers ctx" regression guard case likely passes already; that is fine.

- [ ] **Step 3: Modify `buildPayload()` to track min/max in the flatten loop**

Edit `src/cli/commands/analytics/report/payload-builder.ts`. Add two local trackers before the session flatten loop (near line 36 where `seen` is declared):

```ts
  let minStartMs: number | undefined;
  let maxEndMs: number | undefined;
```

Inside the flatten loop, immediately after `sessions.push({ ... });` in the same iteration (or after `seen.add(...)` — either placement is fine as long as it runs once per deduped session), update the trackers using the raw session values already in scope:

```ts
        if (s.startTime > 0) {
          if (minStartMs === undefined || s.startTime < minStartMs) {
            minStartMs = s.startTime;
          }
          const endMs = s.startTime + Math.max(s.duration ?? 0, 0);
          if (maxEndMs === undefined || endMs > maxEndMs) {
            maxEndMs = endMs;
          }
        }
```

- [ ] **Step 4: Use trackers as fallback in meta assembly**

Replace the two existing spreads at the end of the `meta` object:

```ts
    ...(ctx.periodStart !== undefined && { periodStart: ctx.periodStart }),
    ...(ctx.periodEnd !== undefined && { periodEnd: ctx.periodEnd }),
```

with fallback-aware versions:

```ts
    ...(ctx.periodStart !== undefined
      ? { periodStart: ctx.periodStart }
      : minStartMs !== undefined
        ? { periodStart: new Date(minStartMs).toISOString() }
        : {}),
    ...(ctx.periodEnd !== undefined
      ? { periodEnd: ctx.periodEnd }
      : maxEndMs !== undefined
        ? { periodEnd: new Date(maxEndMs).toISOString() }
        : {}),
```

Leave the `userEmail` spread untouched.

- [ ] **Step 5: Run the tests to verify they pass**

```
npx vitest run src/cli/commands/analytics/report/__tests__/payload-builder.test.ts
```
Expected: all cases PASS, including the pre-existing ones.

- [ ] **Step 6: Update the JSDoc contract on `ReportMeta`**

Edit `src/cli/commands/analytics/report/types.ts` lines 66–68. Update the JSDoc on `periodStart` and `periodEnd` from `"absent for unfiltered reports"` to `"always present when the report contains any sessions"`. Do not change the TypeScript types themselves.

```ts
  periodStart?: string; // ISO — start of the reported range; always present when the report contains any sessions
  periodEnd?: string;   // ISO — end of the reported range; always present when the report contains any sessions
```

- [ ] **Step 7: Type-check and lint**

```
npm run typecheck
npm run lint
```
Expected: zero errors, zero warnings.

- [ ] **Step 8: Commit**

```
git add src/cli/commands/analytics/report/payload-builder.ts src/cli/commands/analytics/report/types.ts src/cli/commands/analytics/report/__tests__/payload-builder.test.ts
git commit -m "fix(analytics): derive periodStart/periodEnd fallback inside buildPayload (EPMCDME-13643)"
```

---

### Task 2: `parseFilterOptions()` sets `filter.toDate` for `--last`

**Files:**
- Modify: `src/cli/commands/analytics/index.ts:271-279` (the `--last` branch in `parseFilterOptions`).
- Test: `src/cli/commands/analytics/__tests__/analytics-cli-metadata.test.ts`

**Interfaces:**
- Consumes: existing `AnalyticsOptions.last`, existing `parseFilterOptions` internal contract.
- Produces: `AnalyticsFilter.toDate` is now set to `new Date()` alongside `fromDate` when `--last <duration>` is valid.

**Test-first: yes — new Vitest case in `analytics-cli-metadata.test.ts` that runs `runAnalytics({ report: true, reportFormat: 'json', last: '7d' })` and asserts `buildPayload` was called with `periodEnd` set to an ISO string very close to now. Must fail against current `index.ts`.**

- [ ] **Step 1: Write the failing test**

Add inside `describe('runAnalytics CLI metadata wiring', () => { ... })` in `src/cli/commands/analytics/__tests__/analytics-cli-metadata.test.ts`:

```ts
  it('passes both periodStart and periodEnd into buildPayload when --last is used', async () => {
    const before = Date.now();
    const { runAnalytics } = await import('../index.js');
    await runAnalytics(
      { report: true, reportFormat: 'json', last: '7d' } as never,
      mockSource() as never
    );
    const after = Date.now();
    const ctx = buildPayloadMock.mock.calls[0][3];
    expect(typeof ctx.periodStart).toBe('string');
    expect(typeof ctx.periodEnd).toBe('string');
    const startMs = Date.parse(ctx.periodStart);
    const endMs = Date.parse(ctx.periodEnd);
    expect(endMs).toBeGreaterThanOrEqual(before);
    expect(endMs).toBeLessThanOrEqual(after);
    expect(startMs).toBeLessThan(endMs);
    // 7 days in ms, allow ±5s window for parseDuration + Date.now drift
    const diff = endMs - startMs;
    expect(diff).toBeGreaterThan(7 * 24 * 60 * 60 * 1000 - 5000);
    expect(diff).toBeLessThan(7 * 24 * 60 * 60 * 1000 + 5000);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```
npx vitest run src/cli/commands/analytics/__tests__/analytics-cli-metadata.test.ts
```
Expected: FAIL — `ctx.periodEnd` is currently `undefined`.

- [ ] **Step 3: Fix `parseFilterOptions()`**

Edit `src/cli/commands/analytics/index.ts` lines 271–279. In the `--last` branch, add `filter.toDate = new Date();` immediately after setting `fromDate`:

```ts
  if (options.last) {
    const duration = parseDuration(options.last);
    if (!duration) {
      console.warn(chalk.yellow(`Warning: Invalid --last duration "${options.last}", ignoring filter`));
    } else {
      filter.fromDate = new Date(Date.now() - duration);
      filter.toDate = new Date();
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

```
npx vitest run src/cli/commands/analytics/__tests__/analytics-cli-metadata.test.ts
```
Expected: PASS. All prior tests in this file still PASS.

- [ ] **Step 5: Type-check and lint**

```
npm run typecheck
npm run lint
```

- [ ] **Step 6: Commit**

```
git add src/cli/commands/analytics/index.ts src/cli/commands/analytics/__tests__/analytics-cli-metadata.test.ts
git commit -m "fix(analytics): --last sets filter.toDate so periodEnd propagates (EPMCDME-13643)"
```

---

### Task 3: Add CLI-metadata regression tests for `--session`, `--project/--branch`, and bare

**Files:**
- Test: `src/cli/commands/analytics/__tests__/analytics-cli-metadata.test.ts`

**Interfaces:**
- Consumes: same test scaffolding as Task 2. `buildPayloadMock` intercepts context; the fallback inside `buildPayload` is exercised only indirectly here — this task's assertions check the **caller-side context** (which is intentionally empty for these modes) and rely on Task 1's `buildPayload` fallback to satisfy the end-user contract.

Because `buildPayload` is mocked in these tests, we cannot assert on `meta.periodStart` / `meta.periodEnd` here — the mock returns a fixed payload. What we CAN assert is that the CLI still successfully invokes `buildPayload` in these modes and does not throw. The real end-to-end guarantee is validated manually in Task 5.

**Test-first: yes — three new "does not throw and calls buildPayload once" cases for `--session`, `--project/--branch`, and bare, ensuring the CLI wiring survives even when no explicit date filter is present.**

- [ ] **Step 1: Write the tests**

Add inside `describe('runAnalytics CLI metadata wiring', () => { ... })` in `src/cli/commands/analytics/__tests__/analytics-cli-metadata.test.ts`:

```ts
  it('invokes buildPayload for --session with no --from/--to', async () => {
    const { runAnalytics } = await import('../index.js');
    await runAnalytics(
      { report: true, reportFormat: 'json', session: 'abc-123' } as never,
      mockSource() as never
    );
    expect(buildPayloadMock).toHaveBeenCalledTimes(1);
    const ctx = buildPayloadMock.mock.calls[0][3];
    expect(ctx.periodStart).toBeUndefined();
    expect(ctx.periodEnd).toBeUndefined();
    // Fallback is buildPayload's responsibility (covered in payload-builder.test.ts).
  });

  it('invokes buildPayload for --project + --branch with no --from/--to', async () => {
    const { runAnalytics } = await import('../index.js');
    await runAnalytics(
      { report: true, reportFormat: 'json', project: 'my-proj', branch: 'feature/x' } as never,
      mockSource() as never
    );
    expect(buildPayloadMock).toHaveBeenCalledTimes(1);
    const ctx = buildPayloadMock.mock.calls[0][3];
    expect(ctx.periodStart).toBeUndefined();
    expect(ctx.periodEnd).toBeUndefined();
  });

  it('invokes buildPayload for a bare report (no filters at all)', async () => {
    const { runAnalytics } = await import('../index.js');
    await runAnalytics(
      { report: true, reportFormat: 'json' } as never,
      mockSource() as never
    );
    expect(buildPayloadMock).toHaveBeenCalledTimes(1);
    const ctx = buildPayloadMock.mock.calls[0][3];
    expect(ctx.periodStart).toBeUndefined();
    expect(ctx.periodEnd).toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests to verify they pass**

```
npx vitest run src/cli/commands/analytics/__tests__/analytics-cli-metadata.test.ts
```
Expected: all PASS. (These cases document the CLI-side behavior. The end-to-end period population is delivered by Task 1's `buildPayload` fallback.)

- [ ] **Step 3: Commit**

```
git add src/cli/commands/analytics/__tests__/analytics-cli-metadata.test.ts
git commit -m "test(analytics): document CLI metadata wiring for --session/--project/--branch/bare (EPMCDME-13643)"
```

---

### Task 4: `BaseAgentAdapter.maybeWriteSessionReport()` — `ConfigLoader` fallback for `userEmail`

**Files:**
- Modify: `src/agents/core/BaseAgentAdapter.ts:61-92` (the `maybeWriteSessionReport` method).
- Test: `src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts`

**Interfaces:**
- Consumes: existing `env: NodeJS.ProcessEnv`, existing `ConfigLoader.loadMultiProviderConfig()`.
- Produces: unchanged public signature. Behavioral change: when `env.CODEMIE_PROFILE_CONFIG` is absent or its parsed profile has no `userEmail`, the method attempts `ConfigLoader.loadMultiProviderConfig().userEmail` before giving up. All lookups remain non-fatal.

**Test-first: yes — new Vitest cases that mock `ConfigLoader.loadMultiProviderConfig` and assert the resolved `userEmail` is passed to `generateSessionReport()` when the env var is missing / lacks email. Existing cases (env has email, env absent, env malformed) must continue to pass.**

- [ ] **Step 1: Extend the existing mocks in the test file**

Edit `src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts`. At the top (near the existing `vi.mock` calls for `session-report.js` and `logger.js`), add a mock for `ConfigLoader`:

```ts
const loadMultiProviderConfigMock = vi.fn();
vi.mock('../../../utils/config.js', () => ({
  ConfigLoader: {
    loadMultiProviderConfig: (...a: unknown[]) => loadMultiProviderConfigMock(...a),
  },
}));
```

Extend the `beforeEach` block to reset this mock to a default that returns an object without `userEmail`:

```ts
  beforeEach(() => {
    vi.clearAllMocks();
    generateSessionReportMock.mockResolvedValue({ written: '/x.json', sessions: 1 });
    loadMultiProviderConfigMock.mockResolvedValue({ userEmail: undefined });
  });
```

- [ ] **Step 2: Write the failing tests**

Append the following cases to the existing `describe('BaseAgentAdapter.maybeWriteSessionReport', () => { ... })` block:

```ts
  it('falls back to ConfigLoader.loadMultiProviderConfig when CODEMIE_PROFILE_CONFIG is absent', async () => {
    loadMultiProviderConfigMock.mockResolvedValue({ userEmail: 'from-config@example.com' });
    await new TestAdapter({ sessionAnalyticsReport: true }).call(baseEnv);
    expect(loadMultiProviderConfigMock).toHaveBeenCalledTimes(1);
    expect(generateSessionReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ userEmail: 'from-config@example.com' })
    );
  });

  it('falls back to ConfigLoader when CODEMIE_PROFILE_CONFIG has no email', async () => {
    loadMultiProviderConfigMock.mockResolvedValue({ userEmail: 'from-config@example.com' });
    const env = {
      ...baseEnv,
      CODEMIE_PROFILE_CONFIG: JSON.stringify({ someOtherField: 'value' }),
    } as NodeJS.ProcessEnv;
    await new TestAdapter({ sessionAnalyticsReport: true }).call(env);
    expect(loadMultiProviderConfigMock).toHaveBeenCalledTimes(1);
    expect(generateSessionReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ userEmail: 'from-config@example.com' })
    );
  });

  it('does not call ConfigLoader when CODEMIE_PROFILE_CONFIG already has an email', async () => {
    const env = {
      ...baseEnv,
      CODEMIE_PROFILE_CONFIG: JSON.stringify({ userEmail: 'from-env@example.com' }),
    } as NodeJS.ProcessEnv;
    await new TestAdapter({ sessionAnalyticsReport: true }).call(env);
    expect(loadMultiProviderConfigMock).not.toHaveBeenCalled();
    expect(generateSessionReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ userEmail: 'from-env@example.com' })
    );
  });

  it('omits userEmail silently when both env and ConfigLoader fail', async () => {
    loadMultiProviderConfigMock.mockRejectedValue(new Error('no config file'));
    await new TestAdapter({ sessionAnalyticsReport: true }).call(baseEnv);
    const arg = generateSessionReportMock.mock.calls[0][0];
    expect(arg.userEmail).toBeUndefined();
  });
```

- [ ] **Step 3: Run the tests to verify the new ones fail**

```
npx vitest run src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts
```
Expected: the 4 new cases FAIL. Existing cases still PASS.

- [ ] **Step 4: Implement the `ConfigLoader` fallback in `BaseAgentAdapter.ts`**

Edit `src/agents/core/BaseAgentAdapter.ts` — the `maybeWriteSessionReport` method (lines 61–92). Add a dynamic import + fallback lookup after the existing env-var block. The full method body becomes:

```ts
  private async maybeWriteSessionReport(env: NodeJS.ProcessEnv): Promise<void> {
    if (!this.metadata.sessionAnalyticsReport) return;
    if (env.CODEMIE_SESSION_ANALYTICS_REPORT === '0') return;
    const sessionId = env.CODEMIE_SESSION_ID;
    if (!sessionId) return;

    try {
      const { generateSessionReport } = await import('../../cli/commands/analytics/report/session-report.js');

      // Email is available in CODEMIE_PROFILE_CONFIG (already parsed at adapter startup for other uses).
      let userEmail: string | undefined;
      if (env.CODEMIE_PROFILE_CONFIG) {
        try {
          const profileConfig = JSON.parse(env.CODEMIE_PROFILE_CONFIG) as { userEmail?: string };
          userEmail = profileConfig.userEmail || undefined;
        } catch {
          // malformed env — fall through to ConfigLoader fallback
        }
      }
      if (!userEmail) {
        try {
          const { ConfigLoader } = await import('../../utils/config.js');
          const cfg = await ConfigLoader.loadMultiProviderConfig();
          userEmail = cfg.userEmail || undefined;
        } catch {
          // no ~/.codemie config — omit email gracefully
        }
      }

      const result = await generateSessionReport({ sessionId, userEmail });
      if (result.written) {
        logger.debug(`[${this.displayName}] Session analytics report written: ${result.written}`);
      } else {
        logger.debug(`[${this.displayName}] No analytics data for session ${sessionId}; report skipped`);
      }
    } catch (err) {
      logger.warn(`[${this.displayName}] Session analytics report failed (non-fatal)`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
```

Note: `ConfigLoader` is dynamically imported to avoid pulling `~/.codemie` filesystem code into the hot path when the env var already carries the email — matching the existing dynamic-import pattern for `session-report.js`.

- [ ] **Step 5: Run the tests to verify all pass**

```
npx vitest run src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts
```
Expected: all cases PASS.

- [ ] **Step 6: Type-check and lint**

```
npm run typecheck
npm run lint
```

- [ ] **Step 7: Commit**

```
git add src/agents/core/BaseAgentAdapter.ts src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts
git commit -m "fix(agents): fall back to ConfigLoader for userEmail on session-exit report (EPMCDME-13643)"
```

---

### Task 5: End-to-end manual verification

**Files:** (no source changes)

**Interfaces:** none; verification only.

**Test-first: no — this is a manual reproduction of the four failing scenarios from the ticket against the freshly built binary. The unit tests in Tasks 1–4 give automated coverage; this task confirms the wire-through works end-to-end and produces reports the user can inspect on disk.**

- [ ] **Step 1: Rebuild the CLI**

```
npm run build
```
The existing `npm link` from Stage 0 pre-flight already points `codemie` at this project's `dist/`.

- [ ] **Step 2: Run each formerly-failing invocation and confirm all three fields are populated**

For each command below, run it, then inspect the resulting JSON report via:

```
node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(JSON.stringify({userEmail:r.meta.userEmail,periodStart:r.meta.periodStart,periodEnd:r.meta.periodEnd},null,2))" <report-path>
```

- **Bare:** `codemie analytics --report --report-format json`
- **--last N:** `codemie analytics --last 7d --report --report-format json`
- **--session:** pick any real session id from `codemie analytics --last 30d --report --report-format json`, then re-run with `--session <id>`
- **--project + --branch:** run with any project name + branch that has recent activity

Expected for each: `userEmail`, `periodStart`, and `periodEnd` are all populated strings.

- **Regression guard: --from/--to:** `codemie analytics --from 2026-07-01 --to 2026-07-27 --report --report-format json` — confirm the values are the user-supplied dates, not the derived min/max.

- [ ] **Step 3: Commit the verification note (optional)**

If any drift is observed during Step 2, iterate through the tasks that own the affected surface and re-run. No commit is expected here.

---

## Self-Review

**1. Spec coverage** —
- `meta.periodStart` / `meta.periodEnd` always present when sessions exist → **Task 1** ✔.
- `--last` correctness at the caller layer → **Task 2** ✔.
- Coverage across `--session`, `--project/--branch`, bare → **Task 3** + **Task 1** together ✔.
- `BaseAgentAdapter` `userEmail` `ConfigLoader` fallback → **Task 4** ✔.
- Non-changes preserved (`rangeLabel`, `session-report.ts`, TypeScript optionality) → enforced in Global Constraints ✔.

**2. Placeholder scan** — no `TBD`, `TODO`, `implement later`, or "add appropriate…" in any task. Code blocks are complete.

**3. Type consistency** — the extended `PayloadContext` is unchanged; `filter.toDate` is already `Date | undefined` in `AnalyticsFilter`; `ConfigLoader.loadMultiProviderConfig()` returns `Promise<MultiProviderConfig>` with an `userEmail?: string` field, matching the fallback usage in Task 4.
