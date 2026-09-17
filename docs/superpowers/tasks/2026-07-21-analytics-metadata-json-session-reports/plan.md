# Analytics Metadata: user email + period dates in JSON/HTML reports

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed `userEmail`, `periodStart`, and `periodEnd` into every analytics report (`ReportMeta`), add the user email slug to default report filenames, and wire the data through both the per-session agent-exit path and the interactive `codemie analytics` CLI path.

**Architecture:** Three-layer change — (1) type extensions to `ReportMeta` / `PayloadContext`, (2) default filename helpers get an optional email slug, (3) both callers of `buildPayload` (`session-report.ts` via `BaseAgentAdapter`, and `analytics/index.ts`) are updated to stamp the new context fields. The `buildPayload` function itself stays pure; callers stamp context.

**Tech Stack:** TypeScript, ES modules (`.js` imports required), Vitest for tests.

---

## File Map

| File | Change type |
|---|---|
| `src/cli/commands/analytics/report/types.ts` | Extend `ReportMeta` |
| `src/cli/commands/analytics/report/payload-builder.ts` | Extend `PayloadContext`; map new fields in `buildPayload` |
| `src/cli/commands/analytics/report/report-generator.ts` | Add `emailSlug()`; update `getDefaultReportPath`/`getDefaultReportJsonPath` signatures |
| `src/cli/commands/analytics/report/session-report.ts` | Extend `SessionReportOptions`; pass new fields into `PayloadContext`; update filename |
| `src/agents/core/BaseAgentAdapter.ts` | Extract email from `CODEMIE_PROFILE_CONFIG`; pass to `generateSessionReport` |
| `src/cli/commands/analytics/index.ts` | Read email from `ConfigLoader`; forward `fromDate`/`toDate` as ISO; use email in default paths |
| `src/cli/commands/analytics/report/__tests__/payload-builder.test.ts` | Add coverage for new `PayloadContext` fields |
| `src/cli/commands/analytics/report/__tests__/session-report.test.ts` | Add coverage for email/period options + filename |
| `src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts` | Add coverage for email extraction from env |

---

## Task 1: Extend `ReportMeta` type and wire it through `buildPayload`

**Files:**
- Modify: `src/cli/commands/analytics/report/types.ts:47-66`
- Modify: `src/cli/commands/analytics/report/payload-builder.ts:13-17` and `122-141`
- Modify: `src/cli/commands/analytics/report/__tests__/payload-builder.test.ts`

Test-first: yes — test that `buildPayload` with `userEmail`, `periodStart`, `periodEnd` in context produces those fields in `meta`.

- [ ] **Step 1: Write the failing test**

In `src/cli/commands/analytics/report/__tests__/payload-builder.test.ts`, add to the existing test suite:

```typescript
it('includes userEmail, periodStart, periodEnd in meta when provided in context', () => {
  const ctx: PayloadContext = {
    rangeLabel: 'custom',
    projectFilter: 'all',
    generatedAt: '2026-07-21T00:00:00.000Z',
    userEmail: 'alice@example.com',
    periodStart: '2026-07-01T00:00:00.000Z',
    periodEnd: '2026-07-21T23:59:59.000Z',
  };
  const payload = buildPayload(emptyRoot(), emptyCostIndex(), emptySummary(), ctx);
  expect(payload.meta.userEmail).toBe('alice@example.com');
  expect(payload.meta.periodStart).toBe('2026-07-01T00:00:00.000Z');
  expect(payload.meta.periodEnd).toBe('2026-07-21T23:59:59.000Z');
});

it('omits userEmail/periodStart/periodEnd in meta when absent from context', () => {
  const ctx: PayloadContext = {
    rangeLabel: 'all',
    projectFilter: 'all',
    generatedAt: '2026-07-21T00:00:00.000Z',
  };
  const payload = buildPayload(emptyRoot(), emptyCostIndex(), emptySummary(), ctx);
  expect(payload.meta.userEmail).toBeUndefined();
  expect(payload.meta.periodStart).toBeUndefined();
  expect(payload.meta.periodEnd).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/cli/commands/analytics/report/__tests__/payload-builder.test.ts --reporter=verbose
```

Expected: TypeScript error or test failure on missing `userEmail`/`periodStart`/`periodEnd` fields.

- [ ] **Step 3: Extend `ReportMeta` in `types.ts`**

In `src/cli/commands/analytics/report/types.ts`, after `coverage: AgentCoverage[];` (line 65), add three optional fields:

```typescript
export interface ReportMeta {
  generatedAt: string; // ISO
  rangeLabel: string; // e.g. "last 30d" or "all"
  agents: string[]; // distinct agents present
  projectFilter: string; // applied --project or "all"
  totals: {
    sessions: number;
    durationMs: number;
    turns: number;
    files: number;
    netLines: number;
    toolCallsTotal: number;
    toolSuccessRate: number;
    totalCostUSD: number;
    cacheReadCostUSD: number;
    pricedSessions: number;
  };
  unpricedModels: string[];
  coverage: AgentCoverage[]; // per-agent priced/total — "which tools are included"
  userEmail?: string;   // identity of the report owner; absent when not authenticated
  periodStart?: string; // ISO — start of the reported range; absent for unfiltered reports
  periodEnd?: string;   // ISO — end of the reported range; absent for unfiltered reports
}
```

- [ ] **Step 4: Extend `PayloadContext` and map in `buildPayload`**

In `src/cli/commands/analytics/report/payload-builder.ts`, update `PayloadContext`:

```typescript
export interface PayloadContext {
  rangeLabel: string;
  projectFilter: string;
  generatedAt: string; // ISO — caller stamps it
  userEmail?: string;   // caller stamps; absent when not authenticated
  periodStart?: string; // ISO — caller stamps from filter or session start
  periodEnd?: string;   // ISO — caller stamps from filter or session end
}
```

In `buildPayload`, update the `meta` object (around line 122) to spread the new optional fields:

```typescript
  const meta: ReportMeta = {
    generatedAt: ctx.generatedAt,
    rangeLabel: ctx.rangeLabel,
    agents: [...agents],
    projectFilter: ctx.projectFilter,
    totals: {
      sessions: sessions.length,
      durationMs,
      turns,
      files,
      netLines,
      toolCallsTotal,
      toolSuccessRate: toolCallsTotal ? Math.round((toolCallsSuccess / toolCallsTotal) * 1000) / 10 : 0,
      totalCostUSD,
      cacheReadCostUSD,
      pricedSessions,
    },
    unpricedModels: summary.unpricedModels,
    coverage: [...coverageMap.values()].sort((a, b) => b.total - a.total),
    ...(ctx.userEmail !== undefined && { userEmail: ctx.userEmail }),
    ...(ctx.periodStart !== undefined && { periodStart: ctx.periodStart }),
    ...(ctx.periodEnd !== undefined && { periodEnd: ctx.periodEnd }),
  };
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run src/cli/commands/analytics/report/__tests__/payload-builder.test.ts --reporter=verbose
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/analytics/report/types.ts src/cli/commands/analytics/report/payload-builder.ts src/cli/commands/analytics/report/__tests__/payload-builder.test.ts
git commit -m "feat(analytics): add userEmail, periodStart, periodEnd to ReportMeta and PayloadContext"
```

---

## Task 2: Add email slug to default report filename helpers

**Files:**
- Modify: `src/cli/commands/analytics/report/report-generator.ts:64-74`

Test-first: yes — test that `getDefaultReportPath` and `getDefaultReportJsonPath` include the email slug when provided.

- [ ] **Step 1: Write the failing test**

In `src/cli/commands/analytics/report/__tests__/report-generator.test.ts`, add:

```typescript
import { getDefaultReportPath, getDefaultReportJsonPath } from '../report-generator.js';

describe('getDefaultReportPath', () => {
  it('includes email slug in filename when email is provided', () => {
    const p = getDefaultReportPath('/tmp', 'alice@example.com');
    expect(p).toMatch(/codemie-analytics-alice-example-com-\d{4}-\d{2}-\d{2}\.html$/);
  });

  it('uses original format when email is absent', () => {
    const p = getDefaultReportPath('/tmp');
    expect(p).toMatch(/codemie-analytics-\d{4}-\d{2}-\d{2}\.html$/);
    expect(p).not.toContain('-at-');
  });
});

describe('getDefaultReportJsonPath', () => {
  it('includes email slug in filename when email is provided', () => {
    const p = getDefaultReportJsonPath('/tmp', 'alice@example.com');
    expect(p).toMatch(/codemie-analytics-alice-example-com-\d{4}-\d{2}-\d{2}\.report\.json$/);
  });

  it('uses original format when email is absent', () => {
    const p = getDefaultReportJsonPath('/tmp');
    expect(p).toMatch(/codemie-analytics-\d{4}-\d{2}-\d{2}\.report\.json$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/cli/commands/analytics/report/__tests__/report-generator.test.ts --reporter=verbose
```

Expected: test failures (wrong signature / missing email slug).

- [ ] **Step 3: Add `emailSlug` helper and update path functions**

In `src/cli/commands/analytics/report/report-generator.ts`, replace `getDefaultReportPath` and `getDefaultReportJsonPath` (lines 64–74):

```typescript
/** Sanitizes an email address into a filename-safe slug: `alice@example.com` → `alice-example-com`. */
function emailSlug(email: string): string {
  return email.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export function getDefaultReportPath(cwd: string, userEmail?: string): string {
  const date = new Date().toISOString().split('T')[0];
  const slug = userEmail ? `${emailSlug(userEmail)}-` : '';
  return join(cwd, `codemie-analytics-${slug}${date}.html`);
}

export function getDefaultReportJsonPath(cwd: string, userEmail?: string): string {
  const date = new Date().toISOString().split('T')[0];
  const slug = userEmail ? `${emailSlug(userEmail)}-` : '';
  // `.report.json` (not `.json`) so the default never collides with `--export json`,
  // which writes the cost-less analytics tree to `codemie-analytics-<date>.json`.
  return join(cwd, `codemie-analytics-${slug}${date}.report.json`);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/cli/commands/analytics/report/__tests__/report-generator.test.ts --reporter=verbose
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/analytics/report/report-generator.ts src/cli/commands/analytics/report/__tests__/report-generator.test.ts
git commit -m "feat(analytics): embed email slug in default report filenames"
```

---

## Task 3: Wire metadata through the per-session agent-exit path

**Files:**
- Modify: `src/cli/commands/analytics/report/session-report.ts`
- Modify: `src/agents/core/BaseAgentAdapter.ts:61-81`
- Modify: `src/cli/commands/analytics/report/__tests__/session-report.test.ts`
- Modify: `src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts`

Test-first: yes — test that `generateSessionReport` with `userEmail` passes it to `buildPayload` (via the written JSON), and that the output filename includes the email slug.

- [ ] **Step 1: Write the failing tests**

In `src/cli/commands/analytics/report/__tests__/session-report.test.ts`, add (alongside existing tests):

```typescript
it('includes userEmail in report meta when provided', async () => {
  // Use existing test infrastructure (vi.mock stubs for SessionsSource, enrichCosts, AnalyticsAggregator, buildPayload, writeReportWithFallback)
  const buildPayloadMock = vi.mocked(buildPayload);
  await generateSessionReport({
    sessionId: 'test-session-id',
    outputPath: '/tmp/out.json',
    userEmail: 'bob@example.com',
  });
  expect(buildPayloadMock).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ userEmail: 'bob@example.com' })
  );
});

it('uses email slug in output path when outputPath omitted and email provided', async () => {
  const writeReportMock = vi.mocked(writeReportWithFallback);
  await generateSessionReport({
    sessionId: 'abc-123',
    userEmail: 'bob@example.com',
  });
  expect(writeReportMock).toHaveBeenCalledWith(
    expect.any(Function),
    expect.stringContaining('codemie-analytics-bob-example-com-abc-123.json'),
    false
  );
});
```

In `src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts`, add:

```typescript
it('extracts userEmail from CODEMIE_PROFILE_CONFIG and passes it to generateSessionReport', async () => {
  const env = {
    CODEMIE_SESSION_ID: 'sess-42',
    CODEMIE_SESSION_ANALYTICS_REPORT: '1',
    CODEMIE_PROFILE_CONFIG: JSON.stringify({ userEmail: 'carol@example.com' }),
  };
  const generateMock = vi.mocked(generateSessionReport);
  await adapter.triggerSessionReport(env); // or however the test invokes maybeWriteSessionReport
  expect(generateMock).toHaveBeenCalledWith(
    expect.objectContaining({ userEmail: 'carol@example.com' })
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/cli/commands/analytics/report/__tests__/session-report.test.ts src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts --reporter=verbose
```

Expected: both test files report failures on missing `userEmail` option.

- [ ] **Step 3: Update `SessionReportOptions` and `generateSessionReport`**

In `src/cli/commands/analytics/report/session-report.ts`, update the interface and function:

```typescript
export interface SessionReportOptions {
  /** Session id to scope the report to. */
  sessionId: string;
  /** Absolute or cwd-relative output path for the JSON report. Defaults to `docs/codemie/analytics/codemie-analytics-[email-]<sessionId>.json` relative to cwd. */
  outputPath?: string;
  /** Include native agent-log discovery (default true). */
  scanNative?: boolean;
  /** User email to embed in report metadata and filename. */
  userEmail?: string;
}
```

Update `generateSessionReport` to use the email and derive period from the session data:

```typescript
export async function generateSessionReport(options: SessionReportOptions): Promise<SessionReportResult> {
  const scanNative = options.scanNative ?? true;
  const { rawSessions } = await new SessionsSource().load({
    filter: { sessionId: options.sessionId },
    scanNative,
  });
  if (rawSessions.length === 0) {
    return { written: null, sessions: 0 };
  }

  const { index, summary } = await enrichCosts(rawSessions);
  const keepSessionIds = new Set(
    [...index.values()].filter((c) => c.tokens.total > 0).map((c) => c.sessionId)
  );
  const analytics = AnalyticsAggregator.aggregate(rawSessions, true, keepSessionIds);
  if (analytics.totalSessions === 0) {
    return { written: null, sessions: 0 };
  }

  const session = rawSessions[0];
  const periodStart = session.startEvent?.data.startTime
    ? new Date(session.startEvent.data.startTime).toISOString()
    : undefined;
  const periodEnd = session.endEvent?.data.endTime
    ? new Date(session.endEvent.data.endTime).toISOString()
    : undefined;

  const payload = buildPayload(analytics, index, summary, {
    rangeLabel: 'all',
    projectFilter: 'all',
    generatedAt: new Date().toISOString(),
    ...(options.userEmail !== undefined && { userEmail: options.userEmail }),
    ...(periodStart !== undefined && { periodStart }),
    ...(periodEnd !== undefined && { periodEnd }),
  });

  // Build output path with email slug when not explicitly provided
  const emailSlug = options.userEmail
    ? options.userEmail.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') + '-'
    : '';
  const outputPath =
    options.outputPath ??
    join(process.cwd(), 'docs', 'codemie', 'analytics', `codemie-analytics-${emailSlug}${options.sessionId}.json`);

  const result = writeReportWithFallback((p) => generateReportJson(payload, p), outputPath, false);
  return { written: result.path, sessions: payload.meta.totals.sessions };
}
```

Also add the `join` import if not already present — it is imported from `node:path` in the existing file. Check the import block; if `join` is missing, add it:

```typescript
import { join } from 'node:path';
```

- [ ] **Step 4: Update `BaseAgentAdapter.maybeWriteSessionReport`**

In `src/agents/core/BaseAgentAdapter.ts`, update `maybeWriteSessionReport` (lines 61–81):

```typescript
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
        userEmail = profileConfig.userEmail ?? undefined;
      } catch {
        // malformed env — omit email gracefully
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

Note: `outputPath` is now optional in `SessionReportOptions` so the explicit `join(...)` line is removed here; `session-report.ts` derives it including the email slug.

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run src/cli/commands/analytics/report/__tests__/session-report.test.ts src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts --reporter=verbose
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/analytics/report/session-report.ts src/agents/core/BaseAgentAdapter.ts src/cli/commands/analytics/report/__tests__/session-report.test.ts src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts
git commit -m "feat(analytics): wire userEmail and period metadata through per-session report path"
```

---

## Task 4: Wire metadata through the interactive CLI path

**Files:**
- Modify: `src/cli/commands/analytics/index.ts:134-167`

Test-first: yes — this is an integration/CLI path. The test is a lightweight check that `buildPayload` receives `userEmail`, `periodStart`, `periodEnd` when the CLI runs with `--from`/`--to`.

- [ ] **Step 1: Write the failing test**

In a new or existing integration test (or extend `src/cli/commands/analytics/__tests__/otel-report.integration.test.ts`), add:

```typescript
it('forwards fromDate, toDate as periodStart/periodEnd to buildPayload', async () => {
  const buildPayloadMock = vi.mocked(buildPayload);
  // Simulate runAnalytics with a mock source that returns one session and filter with from/to
  await runAnalytics(
    { report: true, reportFormat: 'json', from: '2026-07-01', to: '2026-07-21' } as AnalyticsOptions,
    mockSource
  );
  expect(buildPayloadMock).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.anything(),
    expect.objectContaining({
      periodStart: '2026-07-01T00:00:00.000Z',
      periodEnd: '2026-07-21T00:00:00.000Z',
    })
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/cli/commands/analytics/__tests__/otel-report.integration.test.ts --reporter=verbose
```

Expected: test failure — `buildPayload` called without `periodStart`/`periodEnd`.

- [ ] **Step 3: Update `analytics/index.ts` to stamp the new context fields**

In `src/cli/commands/analytics/index.ts`, update the `buildPayload` call inside `runAnalytics` (around line 144). First, load `userEmail` from config before the report block:

```typescript
    // Load user email for report metadata and filename; non-fatal if config is unavailable.
    let userEmail: string | undefined;
    try {
      const { ConfigLoader } = await import('../../../utils/config.js');
      const cfg = await ConfigLoader.loadMultiProviderConfig();
      userEmail = cfg.userEmail ?? undefined;
    } catch {
      // omit email gracefully
    }
```

Then update the `buildPayload` call:

```typescript
      const payload = buildPayload(analytics, costIndex, summary, {
        rangeLabel: options.last ?? (options.from || options.to ? 'custom' : 'all'),
        projectFilter: options.project ?? 'all',
        generatedAt: new Date().toISOString(),
        ...(userEmail !== undefined && { userEmail }),
        ...(filter.fromDate !== undefined && { periodStart: filter.fromDate.toISOString() }),
        ...(filter.toDate !== undefined && { periodEnd: filter.toDate.toISOString() }),
      });
```

Note: `filter` is the result of `parseFilterOptions(options)` — move it above the `wantReport` check so it is in scope here, or extract `filter` before the `if (wantReport && costResult)` block. It is already computed at line 65 as `const filter = parseFilterOptions(options)`, so it is already in scope.

Then update the default path calls to pass `userEmail`:

```typescript
      if (reportFormat === 'both') {
        const base = options.reportOutput?.replace(/\.(html|json)$/i, '');
        htmlPath = base ? `${base}.html` : getDefaultReportPath(cwd, userEmail);
        jsonPath = base ? `${base}.json` : getDefaultReportJsonPath(cwd, userEmail);
        htmlIsDefault = jsonIsDefault = !base;
      } else if (reportFormat === 'html') {
        htmlPath = options.reportOutput || getDefaultReportPath(cwd, userEmail);
        htmlIsDefault = !options.reportOutput;
      } else {
        jsonPath = options.reportOutput || getDefaultReportJsonPath(cwd, userEmail);
        jsonIsDefault = !options.reportOutput;
      }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/cli/commands/analytics/__tests__/otel-report.integration.test.ts --reporter=verbose
```

Expected: all tests PASS.

- [ ] **Step 5: Run full analytics test suite**

```bash
npx vitest run src/cli/commands/analytics --reporter=verbose
```

Expected: all existing tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/analytics/index.ts
git commit -m "feat(analytics): wire userEmail and period metadata through CLI analytics path"
```

---

## Scope note — HTML rendering

No changes to the HTML template or `renderReportHtml` are needed for this ticket. The `userEmail`, `periodStart`, and `periodEnd` fields on `ReportMeta` are automatically embedded in the HTML report's inline `window.__ANALYTICS__` data because `renderReportHtml` serializes the entire `ReportPayload` (which includes `meta`). Displaying the new fields in the dashboard UI is out of scope for this ticket.

---

## Handoff JSON — team-report skill (ai-hyperfactory-analytics)

The team-report skill is out of scope for this repo but must be built in `ai-hyperfactory-analytics`. Use the JSON below to brief the agent responsible for that work.

```json
{
  "ticket": "EPMCDME-13643",
  "target_repo": "ai-hyperfactory-analytics",
  "skill_name": "team-report",
  "skill_location": "skills/team-report/SKILL.md",
  "reference_skill": "skills/codemie-analytics/SKILL.md",
  "context": "codemie analytics generates JSON session reports that now include a metadata block. The team-report skill aggregates those reports per team member over a requested period.",
  "report_schema": {
    "source": "codemie-analytics JSON reports",
    "shape": {
      "meta": {
        "generatedAt": "ISO string",
        "rangeLabel": "string",
        "agents": ["string"],
        "projectFilter": "string",
        "userEmail": "string | undefined  — primary identity key; present from this release forward",
        "periodStart": "ISO string | undefined  — session start (per-session) or --from date (CLI); present from this release forward",
        "periodEnd": "ISO string | undefined  — session end (per-session) or --to date (CLI); present from this release forward",
        "totals": {
          "sessions": "number",
          "durationMs": "number",
          "turns": "number",
          "files": "number",
          "netLines": "number",
          "toolCallsTotal": "number",
          "toolSuccessRate": "number",
          "totalCostUSD": "number",
          "cacheReadCostUSD": "number",
          "pricedSessions": "number"
        },
        "unpricedModels": ["string"],
        "coverage": [{ "agentName": "string", "total": "number", "priced": "number", "withLog": "number" }]
      },
      "sessions": ["ReportSessionRecord — see src/cli/commands/analytics/report/types.ts in codemie-code"]
    }
  },
  "file_naming_conventions": {
    "per_session_new": "codemie-analytics-<email-slug>-<sessionId>.json  (e.g. codemie-analytics-alice-example-com-<uuid>.json)",
    "per_session_legacy": "codemie-analytics-<sessionId>.json  (no email, pre-this-release files)",
    "cli_report_json_new": "codemie-analytics-<email-slug>-<YYYY-MM-DD>.report.json",
    "cli_report_json_legacy": "codemie-analytics-<YYYY-MM-DD>.report.json",
    "cli_report_html_new": "codemie-analytics-<email-slug>-<YYYY-MM-DD>.html",
    "cli_report_html_legacy": "codemie-analytics-<YYYY-MM-DD>.html",
    "email_slug_rule": "email.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/, '')"
  },
  "skill_acceptance_criteria": [
    "Accept JSON report files with any valid filename",
    "Use meta.userEmail as the primary key to identify the team member",
    "Fall back to filename parsing (email slug before the UUID/date segment) when meta.userEmail is absent",
    "Use meta.periodStart and meta.periodEnd as the primary source for report period",
    "Fall back to session-level startTime / endTime from meta.totals or session records when period fields are absent",
    "Verify each file's resolved period overlaps with the requested reporting period",
    "Include a file only when its resolved period falls within the requested range",
    "Aggregate all matching files for the same team member (deduplicate sessions by sessionId)",
    "Sum totals across files (durationMs, turns, files, netLines, toolCallsTotal, totalCostUSD, cacheReadCostUSD)",
    "Output a per-member summary: email, periodCovered, sessionCount, aggregatedTotals",
    "Support files produced before this release (no meta.userEmail or period fields) via filename fallback"
  ],
  "aggregation_semantics": {
    "dedup_key": "sessions[].sessionId — deduplicate across files before summing",
    "sum_fields": ["durationMs", "turns", "fileOps", "netLines", "toolCallsTotal", "toolCallsSuccess", "toolCallsFailure", "costUSD", "cacheReadCostUSD"],
    "period_covered": "min(resolved periodStart across files) to max(resolved periodEnd across files)",
    "notes": "A single session may appear in multiple files (e.g. a CLI report and a per-session report). Dedup by sessionId before aggregating."
  },
  "fallback_strategy": {
    "email_from_filename": {
      "per_session_new": "extract segment between 'codemie-analytics-' and the last UUID segment",
      "cli_report_new": "extract segment between 'codemie-analytics-' and the date segment",
      "legacy": "no email recoverable — skip or bucket as 'unknown'"
    },
    "period_from_filename": {
      "cli_report": "date in filename (YYYY-MM-DD) used as both periodStart and periodEnd (day boundary)",
      "per_session": "no date in filename — fall back to sessions[0].startTime and last session endTime from the JSON content"
    }
  }
}
```
