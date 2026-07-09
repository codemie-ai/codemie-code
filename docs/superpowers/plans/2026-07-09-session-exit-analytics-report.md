# Session-exit Analytics Report Finalizer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On codemie-claude/codex/opencode session exit, programmatically generate a per-session analytics JSON report as part of `BaseAgentAdapter` finalization — enabled by default for those agents, disable-able via a `--no-analytics-report` flag, non-fatal on failure.

**Architecture:** A new dedicated, side-effect-free programmatic API (`generateSessionReport`) composes the existing analytics building blocks (`SessionsSource` → `enrichCosts` → `AnalyticsAggregator.aggregate` → `buildPayload` → `generateReportJson`). `BaseAgentAdapter.run()`'s shared `child.on('exit')` finalization calls a private `maybeWriteSessionReport(env)` that is gated by a per-agent `sessionAnalyticsReport` metadata flag plus a `CODEMIE_SESSION_ANALYTICS_REPORT` env kill-switch set by the `AgentCLI` `--no-analytics-report` flag.

**Tech Stack:** Node.js ≥20, TypeScript, ES modules (import paths end in `.js`), Vitest, commander.

## Global Constraints

- ES modules only; every relative import ends in `.js`. No `require`/`__dirname`.
- No `console.log` in library/finalization code — use `logger` (protects ACP/silent JSON-RPC stdout).
- Report-generation failure MUST be non-fatal: never throw out of finalization, never `process.exit`.
- Output path (verbatim requirement): `<cwd>/docs/codemie/analytics/codemie-analytics-<sessionId>.json`, JSON format.
- Enabled by default for claude, codex, opencode (and claude-acp by metadata inheritance). Disable via `--no-analytics-report`.
- Baseline branch: `fix/analytics-session-filter`. Do not reformat or refactor unrelated code.
- Follow existing Vitest house style: `describe/it/expect`, `vi.mock(...)` with dynamic `await import(...)` after mocks when needed.

---

### Task 1: Programmatic session-report API (`generateSessionReport`)

**Files:**
- Create: `src/cli/commands/analytics/report/session-report.ts`
- Test: `src/cli/commands/analytics/report/__tests__/session-report.test.ts`

**Interfaces:**
- Consumes (existing, verified signatures):
  - `new SessionsSource().load({ filter, scanNative }): Promise<{ rawSessions: RawSessionData[] }>` (`../sources/sessions-source.js`)
  - `enrichCosts(sessions): Promise<{ index: SessionCostIndex; summary: CostSummary }>` (`../cost/cost-enricher.js`; `realDeps` is the default 2nd arg)
  - `AnalyticsAggregator.aggregate(rawSessions, normalizeModels=true, keepSessionIds?): RootAnalytics` (`../aggregator.js`)
  - `buildPayload(root, costIndex, summary, ctx): ReportPayload` (`./payload-builder.js`; `ctx = { rangeLabel, projectFilter, generatedAt }`)
  - `generateReportJson(payload, outputPath): void` and `writeReportWithFallback(write, path, allowFallback): ReportWriteResult` (`./report-generator.js`)
- Produces (relied on by Task 3):
  - `interface SessionReportOptions { sessionId: string; outputPath: string; scanNative?: boolean }`
  - `interface SessionReportResult { written: string | null; sessions: number }`
  - `async function generateSessionReport(options: SessionReportOptions): Promise<SessionReportResult>`

**Test-first: yes — a test that expects `generateSessionReport` to write a JSON report for a session that has data, and to write nothing (returning `{written:null,sessions:0}`) when the session has no data; the module does not exist yet so the import fails.**

- [ ] **Step 1: Write the failing test**

```ts
// src/cli/commands/analytics/report/__tests__/session-report.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const loadMock = vi.fn();
vi.mock('../../sources/sessions-source.js', () => ({
  SessionsSource: class { load = loadMock; },
}));
const enrichCostsMock = vi.fn();
vi.mock('../../cost/cost-enricher.js', () => ({ enrichCosts: (...a: unknown[]) => enrichCostsMock(...a) }));
const aggregateMock = vi.fn();
vi.mock('../../aggregator.js', () => ({ AnalyticsAggregator: { aggregate: (...a: unknown[]) => aggregateMock(...a) } }));
const buildPayloadMock = vi.fn();
vi.mock('../payload-builder.js', () => ({ buildPayload: (...a: unknown[]) => buildPayloadMock(...a) }));
const generateReportJsonMock = vi.fn();
vi.mock('../report-generator.js', () => ({
  generateReportJson: (...a: unknown[]) => generateReportJsonMock(...a),
  // Real fallback semantics: just invoke the writer with the preferred path.
  writeReportWithFallback: (write: (p: string) => void, p: string) => { write(p); return { path: p }; },
}));

describe('generateSessionReport', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes a JSON report for a session that has data', async () => {
    loadMock.mockResolvedValue({ rawSessions: [{ sessionId: 's1' }] });
    enrichCostsMock.mockResolvedValue({
      index: new Map([['s1', { sessionId: 's1', tokens: { total: 10 } }]]),
      summary: { totalCostUSD: 0, pricedSessions: 1, totalSessions: 1 },
    });
    aggregateMock.mockReturnValue({ totalSessions: 1, projects: [] });
    buildPayloadMock.mockReturnValue({ meta: { totals: { sessions: 1 } }, sessions: [{ sessionId: 's1' }] });

    const { generateSessionReport } = await import('../session-report.js');
    const res = await generateSessionReport({ sessionId: 's1', outputPath: '/tmp/out.json' });

    expect(loadMock).toHaveBeenCalledWith({ filter: { sessionId: 's1' }, scanNative: true });
    expect(generateReportJsonMock).toHaveBeenCalledWith(expect.anything(), '/tmp/out.json');
    expect(res).toEqual({ written: '/tmp/out.json', sessions: 1 });
  });

  it('writes nothing when the session has no data', async () => {
    loadMock.mockResolvedValue({ rawSessions: [] });
    const { generateSessionReport } = await import('../session-report.js');
    const res = await generateSessionReport({ sessionId: 'missing', outputPath: '/tmp/none.json' });
    expect(generateReportJsonMock).not.toHaveBeenCalled();
    expect(res).toEqual({ written: null, sessions: 0 });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/cli/commands/analytics/report/__tests__/session-report.test.ts`
Expected: FAIL — `Cannot find module '../session-report.js'`.

- [ ] **Step 3: Implement `generateSessionReport`**

```ts
// src/cli/commands/analytics/report/session-report.ts
/**
 * Programmatic, side-effect-free session-scoped analytics report generator.
 * Composes the same building blocks the `analytics --report --report-format json`
 * CLI path uses, but prints nothing and never calls process.exit — safe to invoke
 * from agent session finalization. Failures propagate to the caller (who logs them).
 */

import { SessionsSource } from '../sources/sessions-source.js';
import { enrichCosts } from '../cost/cost-enricher.js';
import { AnalyticsAggregator } from '../aggregator.js';
import { buildPayload } from './payload-builder.js';
import { generateReportJson, writeReportWithFallback } from './report-generator.js';

export interface SessionReportOptions {
  /** Session id to scope the report to. */
  sessionId: string;
  /** Absolute or cwd-relative output path for the JSON report. */
  outputPath: string;
  /** Include native agent-log discovery (default true). */
  scanNative?: boolean;
}

export interface SessionReportResult {
  /** Path written, or null when the session had no analytics data. */
  written: string | null;
  /** Number of sessions included in the payload. */
  sessions: number;
}

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
  const payload = buildPayload(analytics, index, summary, {
    rangeLabel: 'all',
    projectFilter: 'all',
    generatedAt: new Date().toISOString(),
  });

  // Explicit path ⇒ no home/tmp fallback; a write error propagates to the caller.
  const result = writeReportWithFallback((p) => generateReportJson(payload, p), options.outputPath, false);
  return { written: result.path, sessions: payload.meta.totals.sessions };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/cli/commands/analytics/report/__tests__/session-report.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/analytics/report/session-report.ts src/cli/commands/analytics/report/__tests__/session-report.test.ts
git commit -m "feat(analytics): add programmatic generateSessionReport API"
```

---

### Task 2: Opt-in metadata flag on claude/codex/opencode

**Files:**
- Modify: `src/agents/core/types.ts` (add field to `AgentMetadata`, near `metricsConfig?` ~line 326)
- Modify: `src/agents/plugins/claude/claude.plugin.ts` (`ClaudePluginMetadata`, ~line 62)
- Modify: `src/agents/plugins/codex/codex.plugin.ts` (`CodexPluginMetadata`, ~line 105)
- Modify: `src/agents/plugins/opencode/opencode.plugin.ts` (`OpenCodePluginMetadata`, ~line 17)
- Test: `src/agents/plugins/__tests__/session-analytics-report-metadata.test.ts` (create)

**Interfaces:**
- Produces (relied on by Task 3): `AgentMetadata.sessionAnalyticsReport?: boolean`.
- Note: `ClaudeAcpPluginMetadata` is built via `{ ...ClaudePluginMetadata, ... }`, so it inherits `sessionAnalyticsReport: true` automatically (intended — ACP finalizes through the same `child.on('exit')` path). No change needed there.

**Test-first: yes — a test asserting the three plugin metadata objects (and the ACP inheritance) expose `sessionAnalyticsReport === true`; fails because the fields are not set yet.**

- [ ] **Step 1: Write the failing test**

```ts
// src/agents/plugins/__tests__/session-analytics-report-metadata.test.ts
import { describe, it, expect } from 'vitest';
import { ClaudePluginMetadata } from '../claude/claude.plugin.js';
import { CodexPluginMetadata } from '../codex/codex.plugin.js';
import { OpenCodePluginMetadata } from '../opencode/opencode.plugin.js';
import { ClaudeAcpPluginMetadata } from '../claude/claude-acp.plugin.js';

describe('sessionAnalyticsReport opt-in metadata', () => {
  it('is enabled by default for claude, codex, opencode', () => {
    expect(ClaudePluginMetadata.sessionAnalyticsReport).toBe(true);
    expect(CodexPluginMetadata.sessionAnalyticsReport).toBe(true);
    expect(OpenCodePluginMetadata.sessionAnalyticsReport).toBe(true);
  });

  it('is inherited by claude-acp via metadata spread', () => {
    expect(ClaudeAcpPluginMetadata.sessionAnalyticsReport).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/agents/plugins/__tests__/session-analytics-report-metadata.test.ts`
Expected: FAIL — values are `undefined`, not `true`.

- [ ] **Step 3: Add the field to `AgentMetadata`**

In `src/agents/core/types.ts`, inside `interface AgentMetadata` near the runtime-behavior/metrics fields (e.g. just above `metricsConfig?`):

```ts
  /**
   * When true, a per-session analytics JSON report is written automatically on
   * session exit (see BaseAgentAdapter finalization). Default off; enabled on the
   * interactive agents. A `--no-analytics-report` CLI flag disables it per run.
   */
  sessionAnalyticsReport?: boolean;
```

- [ ] **Step 4: Set the flag on the three plugin metadata objects**

In each metadata object literal add the field (place it among the top-level fields, e.g. after `cliCommand`):

`ClaudePluginMetadata` (claude.plugin.ts):
```ts
  sessionAnalyticsReport: true,
```
`CodexPluginMetadata` (codex.plugin.ts):
```ts
  sessionAnalyticsReport: true,
```
`OpenCodePluginMetadata` (opencode.plugin.ts):
```ts
  sessionAnalyticsReport: true,
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `npx vitest run src/agents/plugins/__tests__/session-analytics-report-metadata.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add src/agents/core/types.ts src/agents/plugins/claude/claude.plugin.ts src/agents/plugins/codex/codex.plugin.ts src/agents/plugins/opencode/opencode.plugin.ts src/agents/plugins/__tests__/session-analytics-report-metadata.test.ts
git commit -m "feat(agents): add sessionAnalyticsReport opt-in metadata (claude/codex/opencode)"
```

---

### Task 3: Finalization hook in `BaseAgentAdapter`

**Files:**
- Modify: `src/agents/core/BaseAgentAdapter.ts` (add private `maybeWriteSessionReport`; call it in the `child.on('exit')` handler after `executeAfterRun`, ~line 807)
- Test: `src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts` (create)

**Interfaces:**
- Consumes: `generateSessionReport` from `../../cli/commands/analytics/report/session-report.js` (Task 1); `this.metadata.sessionAnalyticsReport` (Task 2); `env.CODEMIE_SESSION_ID`, `env.CODEMIE_SESSION_ANALYTICS_REPORT` (Task 4 sets the latter).
- Produces: gated, non-fatal side effect (writes report file). No new public API.
- `logger` (top-level import, line 6) and `join` from `'path'` (line 19) are already imported — reuse them.

**Test-first: yes — tests asserting `maybeWriteSessionReport` calls `generateSessionReport` only when metadata flag is on, the env kill-switch is not `'0'`, and a session id exists; and that a thrown error is swallowed (non-fatal). Fails because the method does not exist.**

- [ ] **Step 1: Write the failing test**

```ts
// src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateSessionReportMock = vi.fn();
vi.mock('../../../cli/commands/analytics/report/session-report.js', () => ({
  generateSessionReport: (...a: unknown[]) => generateSessionReportMock(...a),
}));
vi.mock('../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), setSessionId: vi.fn(), setAgentName: vi.fn(), setProfileName: vi.fn() },
}));

import { BaseAgentAdapter } from '../BaseAgentAdapter.js';
import type { AgentMetadata } from '../types.js';

class TestAdapter extends BaseAgentAdapter {
  constructor(meta: Partial<AgentMetadata>) {
    super({ name: 't', displayName: 'T', description: 'd', envMapping: {}, supportedProviders: [], ...meta } as AgentMetadata);
  }
  // expose the private method for testing
  call(env: NodeJS.ProcessEnv) { return (this as unknown as { maybeWriteSessionReport(e: NodeJS.ProcessEnv): Promise<void> }).maybeWriteSessionReport(env); }
}

const baseEnv = { CODEMIE_SESSION_ID: 's1' } as NodeJS.ProcessEnv;

describe('BaseAgentAdapter.maybeWriteSessionReport', () => {
  beforeEach(() => { vi.clearAllMocks(); generateSessionReportMock.mockResolvedValue({ written: '/x.json', sessions: 1 }); });

  it('generates a report when enabled', async () => {
    await new TestAdapter({ sessionAnalyticsReport: true }).call(baseEnv);
    expect(generateSessionReportMock).toHaveBeenCalledTimes(1);
    const arg = generateSessionReportMock.mock.calls[0][0];
    expect(arg.sessionId).toBe('s1');
    expect(arg.outputPath).toContain('docs/codemie/analytics/codemie-analytics-s1.json');
  });

  it('skips when metadata flag is not set', async () => {
    await new TestAdapter({}).call(baseEnv);
    expect(generateSessionReportMock).not.toHaveBeenCalled();
  });

  it('skips when disabled via env kill-switch', async () => {
    await new TestAdapter({ sessionAnalyticsReport: true }).call({ ...baseEnv, CODEMIE_SESSION_ANALYTICS_REPORT: '0' });
    expect(generateSessionReportMock).not.toHaveBeenCalled();
  });

  it('skips when there is no session id', async () => {
    await new TestAdapter({ sessionAnalyticsReport: true }).call({} as NodeJS.ProcessEnv);
    expect(generateSessionReportMock).not.toHaveBeenCalled();
  });

  it('never throws when report generation fails (non-fatal)', async () => {
    generateSessionReportMock.mockRejectedValue(new Error('boom'));
    await expect(new TestAdapter({ sessionAnalyticsReport: true }).call(baseEnv)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts`
Expected: FAIL — `maybeWriteSessionReport` is not a function.

- [ ] **Step 3: Add the private method**

Add this method to the `BaseAgentAdapter` class (e.g. just after `setSilentMode`):

```ts
  /**
   * Writes a per-session analytics JSON report on session exit when the agent
   * opts in (`metadata.sessionAnalyticsReport`) and the run did not disable it
   * (`CODEMIE_SESSION_ANALYTICS_REPORT !== '0'`). Non-fatal: any failure is logged
   * and swallowed so session finalization always completes.
   */
  private async maybeWriteSessionReport(env: NodeJS.ProcessEnv): Promise<void> {
    if (!this.metadata.sessionAnalyticsReport) return;
    if (env.CODEMIE_SESSION_ANALYTICS_REPORT === '0') return;
    const sessionId = env.CODEMIE_SESSION_ID;
    if (!sessionId) return;

    try {
      const { generateSessionReport } = await import('../../cli/commands/analytics/report/session-report.js');
      const outputPath = join(process.cwd(), 'docs', 'codemie', 'analytics', `codemie-analytics-${sessionId}.json`);
      const result = await generateSessionReport({ sessionId, outputPath });
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

- [ ] **Step 4: Call it from the `child.on('exit')` finalization**

In the `child.on('exit', async (code) => { ... })` handler, immediately AFTER the `executeAfterRun(...)` call (the block guarded by `if (code !== null)`, ~line 807) and BEFORE the goodbye-message block, add:

```ts
          // Write the per-session analytics report (gated, non-fatal).
          await this.maybeWriteSessionReport(env);
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `npx vitest run src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add src/agents/core/BaseAgentAdapter.ts src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts
git commit -m "feat(agents): write per-session analytics report on session exit"
```

---

### Task 4: `--no-analytics-report` disable flag in `AgentCLI`

**Files:**
- Modify: `src/agents/core/AgentCLI.ts` (option declaration ~line 80; env propagation in `handleRun` near the `--status` block ~line 302; `configOnlyOptions` in `collectPassThroughArgs` ~line 530)
- Test: `src/agents/core/__tests__/AgentCLI-analytics-report.test.ts` (create; model the harness on `AgentCLI-resume.test.ts`)

**Interfaces:**
- Consumes: commander option `analyticsReport` (default `true`, `false` when `--no-analytics-report` given).
- Produces (relied on by Task 3): `providerEnv.CODEMIE_SESSION_ANALYTICS_REPORT === '0'` when disabled; the flag is never forwarded to the agent binary.

**Test-first: yes — a test asserting that running with `--no-analytics-report` makes `adapter.run` receive an env with `CODEMIE_SESSION_ANALYTICS_REPORT='0'` and that neither `--analytics-report` nor `--no-analytics-report` is in the agent args; and that the default run leaves the env var unset. Fails because the flag/propagation do not exist.**

- [ ] **Step 1: Write the failing test**

```ts
// src/agents/core/__tests__/AgentCLI-analytics-report.test.ts
// NOTE: mirror the mock harness used in AgentCLI-resume.test.ts (ConfigLoader, ProviderRegistry, logger, etc.).
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Reuse the neighbor test's mocks for ConfigLoader/providers so handleRun reaches adapter.run().
// (Copy the vi.mock blocks from AgentCLI-resume.test.ts.)

import { AgentCLI } from '../AgentCLI.js';
import type { AgentAdapter } from '../types.js';

function makeAdapter(runSpy: ReturnType<typeof vi.fn>): AgentAdapter {
  return {
    name: 'claude', displayName: 'Claude Code', description: 'd',
    isInstalled: vi.fn().mockResolvedValue(true),
    getVersion: vi.fn().mockResolvedValue('1.0.0'),
    run: runSpy,
  } as unknown as AgentAdapter;
}

describe('AgentCLI --no-analytics-report', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets CODEMIE_SESSION_ANALYTICS_REPORT=0 and does not forward the flag', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(makeAdapter(run));
    await cli.run(['node', 'codemie-claude', '--no-analytics-report', 'chat']);
    const [agentArgs, providerEnv] = run.mock.calls[0];
    expect(providerEnv.CODEMIE_SESSION_ANALYTICS_REPORT).toBe('0');
    expect(agentArgs).not.toContain('--analytics-report');
    expect(agentArgs).not.toContain('--no-analytics-report');
  });

  it('leaves the env var unset by default', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(makeAdapter(run));
    await cli.run(['node', 'codemie-claude', 'chat']);
    const [, providerEnv] = run.mock.calls[0];
    expect(providerEnv.CODEMIE_SESSION_ANALYTICS_REPORT).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/agents/core/__tests__/AgentCLI-analytics-report.test.ts`
Expected: FAIL — env var is undefined in the first test (flag not wired).

- [ ] **Step 3: Declare the option**

In `setupProgram()`, alongside the other options (after `.option('--resume ...')`, ~line 80):

```ts
      .option('--no-analytics-report', 'Disable the automatic per-session analytics report written on exit')
```

- [ ] **Step 4: Propagate to the adapter env**

In `handleRun`, near the `--status` propagation block (~line 302), add:

```ts
      // Disable per-session analytics report on exit (default enabled).
      // Commander sets options.analyticsReport = false only when --no-analytics-report is passed.
      if (options.analyticsReport === false) {
        providerEnv.CODEMIE_SESSION_ANALYTICS_REPORT = '0';
      }
```

- [ ] **Step 5: Keep the flag out of the agent args**

In `collectPassThroughArgs`, add `'analyticsReport'` to the `configOnlyOptions` array (~line 530):

```ts
    const configOnlyOptions = ['profile', 'provider', 'apiKey', 'baseUrl', 'timeout', 'model', 'silent', 'status', 'jwtToken', 'reasoningEffort', 'analyticsReport'];
```

- [ ] **Step 6: Run the test, verify it passes**

Run: `npx vitest run src/agents/core/__tests__/AgentCLI-analytics-report.test.ts`
Expected: PASS (2 tests). If the harness needs more provider/config mocks to reach `adapter.run`, copy them verbatim from `AgentCLI-resume.test.ts`.

- [ ] **Step 7: Typecheck + commit**

```bash
npm run typecheck
git add src/agents/core/AgentCLI.ts src/agents/core/__tests__/AgentCLI-analytics-report.test.ts
git commit -m "feat(cli): add --no-analytics-report flag to disable session-exit report"
```

---

### Task 5: Documentation note

**Files:**
- Modify: `docs/ANALYTICS-REPORT.md` (add a short "Automatic per-session report on exit" section)

**Test-first: no — documentation only.**

- [ ] **Step 1: Add a concise section** describing: the report is written automatically on codemie-claude/codex/opencode session exit to `./docs/codemie/analytics/codemie-analytics-<session_id>.json`; enabled by default; disable per run with `codemie claude --no-analytics-report ...` (same for codex/opencode); it is non-fatal (a failure never blocks exit) and skipped when the session produced no analytics data.

- [ ] **Step 2: Commit**

```bash
git add docs/ANALYTICS-REPORT.md
git commit -m "docs(analytics): document automatic per-session report on session exit"
```

---

## Self-Review

**Spec coverage:**
- Auto-generate on exit (default-on) → Task 2 (metadata) + Task 3 (hook). ✓
- Programmatic/in-process, not a separate command → Task 1 (`generateSessionReport`, no CLI). ✓
- Params (session/json/fixed path) → Task 1 (json via `generateReportJson`) + Task 3 (path `docs/codemie/analytics/codemie-analytics-<sessionId>.json`). ✓
- `--no-analytics-report` disable flag → Task 4. ✓
- codex/opencode parity → Task 2 (metadata on all three) + shared hook in Task 3. ✓
- Non-fatal → Task 1 (returns instead of throwing on no-data; explicit path) + Task 3 (try/catch, logger). ✓
- claude-acp reviewer follow-up → Task 2 note (inherits via spread; funnels through shared `child.on('exit')`). ✓
- generateSessionReport surface reviewer follow-up → Task 1 keeps json-only, minimal options. ✓

**Placeholder scan:** none — all steps contain concrete code/commands.

**Type consistency:** `SessionReportOptions`/`SessionReportResult`/`generateSessionReport` names match across Tasks 1 and 3; `CODEMIE_SESSION_ANALYTICS_REPORT` and `sessionAnalyticsReport` used consistently across Tasks 2–4; `written: string | null` returned by Task 1 and consumed by Task 3.

**Note on tests:** This plan is executed under the SDLC autonomous TDD pipeline (test-first evidence required per task); test tasks are in scope for this run.
