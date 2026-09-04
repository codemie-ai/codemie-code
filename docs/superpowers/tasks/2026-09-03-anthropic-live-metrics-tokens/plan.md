# Anthropic-Subscription Live Metrics Token Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture per-turn Anthropic token usage into `MetricDelta` and propagate accumulated totals (incremental for tool-usage sync, cumulative for session-end) into the live `/v1/metrics` payload as four new flat optional numeric fields, with no cost/money computation anywhere.

**Architecture:** Read the already-detected `completedMsg.message.usage` object in `claude.metrics-processor.ts` into a new `MetricDelta.tokens` field; sum that field in two existing accumulation paths (`metrics-aggregator.ts` for periodic sync, a new read path in `hook.ts` for session-end); spread the sums into `ToolUsageAttributes`/`SessionLifecycleAttributes` as four new optional snake_case fields, following the codebase's existing "additive optional field, conditional spread" convention (`active_duration_ms`, v2 error arrays). No provider gating, no schema_version bump, no dict-shaped fields.

**Tech Stack:** TypeScript, Vitest.

**Spec:** `docs/superpowers/tasks/2026-09-03-anthropic-live-metrics-tokens/spec.md`

## Global Constraints

- No `provider === 'anthropic-subscription'` conditional/gate anywhere in this change — fields populate for all `claude`-agent sessions regardless of provider.
- No cost, price, or `money_spent` computation or transmission by the client, under any circumstance — token counts are raw usage facts only; pricing stays server-side.
- No changes to `gemini.metrics-processor.ts`, `kimi.metrics-processor.ts`, `codex.metrics-processor.ts`, `pi.metrics-processor.ts`, or `opencode.metrics-processor.ts` — scope is `claude.metrics-processor.ts` only.
- No `schema_version` bump on `SessionLifecycleAttributes` or `ToolUsageAttributes` — these are purely additive optional numeric fields.
- `ToolUsageAttributes.tool_counts?: never` stays untouched — the new token fields are separate flat optional numbers, never a dict/map shape.
- A missing or empty per-session metrics-delta file must yield omitted/zero token fields, never a thrown error or aborted session-end sync.

Commit per task using the repository's existing convention.

---

### Task 1: Add `tokens` field to `MetricDelta` and capture it in `claude.metrics-processor.ts`

**Files:**
- Modify: `src/agents/core/metrics/types.ts:41-97` (add field to `MetricDelta`)
- Modify: `src/agents/plugins/claude/session/processors/claude.metrics-processor.ts:257-268` (populate it in `processDelta`)
- Test: `src/agents/plugins/claude/session/processors/__tests__/claude.metrics-processor-tokens.test.ts`

**Interfaces:**
- Produces: `MetricDelta.tokens?: { input: number; output: number; cacheRead?: number; cacheCreation?: number }` — consumed by Task 2 (aggregator) and Task 3 (session-end reader).

**Test-first: yes — a `MetricsProcessor` delta built from a raw JSONL message group whose completed message carries `message.usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }` must produce a delta with `tokens: { input: 10, output: 5, cacheRead: 2, cacheCreation: 1 }`; a message group with no `cache_read_input_tokens`/`cache_creation_input_tokens` must produce `tokens: { input, output }` with no `cacheRead`/`cacheCreation` keys.**

- [ ] **Step 1: Write the failing test**

```ts
// src/agents/plugins/claude/session/processors/__tests__/claude.metrics-processor-tokens.test.ts
import { describe, it, expect } from 'vitest';
import { MetricsProcessor } from '../claude.metrics-processor.js';

function makeContext(rawMessages: unknown[]) {
  return {
    parsedSession: { messages: rawMessages, subagents: [] },
    sessionId: 'sess-1',
    agentSessionId: 'agent-sess-1',
  } as any;
}

describe('MetricsProcessor token capture', () => {
  it('captures input/output/cache token counts from a completed assistant message', async () => {
    const processor = new MetricsProcessor();
    const rawMessages = [
      {
        message: {
          id: 'msg-1',
          role: 'assistant',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 1,
          },
        },
        uuid: 'rec-1',
      },
    ];
    const deltas = await processor.extractDeltasFromMessages(rawMessages, makeContext(rawMessages));
    expect(deltas[0].tokens).toEqual({ input: 10, output: 5, cacheRead: 2, cacheCreation: 1 });
  });

  it('omits cacheRead/cacheCreation when the usage object does not carry them', async () => {
    const processor = new MetricsProcessor();
    const rawMessages = [
      {
        message: {
          id: 'msg-2',
          role: 'assistant',
          usage: { input_tokens: 7, output_tokens: 3 },
        },
        uuid: 'rec-2',
      },
    ];
    const deltas = await processor.extractDeltasFromMessages(rawMessages, makeContext(rawMessages));
    expect(deltas[0].tokens).toEqual({ input: 7, output: 3 });
  });
});
```

(Adjust the call into `extractDeltasFromMessages`/context shape to match the processor's real method signature — read `claude.metrics-processor.ts` in full before writing this test; the existing tests in `claude.metrics-processor-clear.test.ts` show the exact harness shape to reuse.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/plugins/claude/session/processors/__tests__/claude.metrics-processor-tokens.test.ts`
Expected: FAIL — `tokens` is `undefined` (field does not exist yet).

- [ ] **Step 3: Add the `tokens` field to `MetricDelta`**

In `src/agents/core/metrics/types.ts`, inside the `MetricDelta` interface (after the `fileOperations` block, line 78), add:

```ts
  // Token usage (Anthropic usage object, captured per completed turn)
  tokens?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheCreation?: number;
  };
```

- [ ] **Step 4: Populate `tokens` in `processDelta`**

In `claude.metrics-processor.ts`, immediately after the `completedMsg` guard (line 264-267), read the usage object and build the field:

```ts
      const usage = completedMsg.message?.usage;
      const tokens = usage
        ? {
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            ...(usage.cache_read_input_tokens !== undefined && { cacheRead: usage.cache_read_input_tokens }),
            ...(usage.cache_creation_input_tokens !== undefined && { cacheCreation: usage.cache_creation_input_tokens }),
          }
        : undefined;
```

Add `tokens` to the delta object literal this function returns/appends (wherever `models`/`apiErrorMessage` are currently assigned in the same function).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/agents/plugins/claude/session/processors/__tests__/claude.metrics-processor-tokens.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

---

### Task 2: Add the four token fields to `SessionLifecycleAttributes`/`ToolUsageAttributes` and accumulate them in `metrics-aggregator.ts`

**Files:**
- Modify: `src/providers/plugins/sso/session/processors/metrics/metrics-types.ts:25-108`
- Modify: `src/providers/plugins/sso/session/processors/metrics/metrics-aggregator.ts:117-276`
- Test: `src/providers/plugins/sso/session/processors/metrics/__tests__/metrics-aggregator-tokens.test.ts`

**Interfaces:**
- Consumes: `MetricDelta.tokens` from Task 1.
- Produces: `SessionLifecycleAttributes`/`ToolUsageAttributes` gain `input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_creation_tokens?: number` — consumed by Task 3 (session-end) and Task 4 (debug/dry-run logging).

**Test-first: yes — `buildSessionAttributes` (via `aggregateDeltas`) given deltas with `tokens: { input: 10, output: 5, cacheRead: 2 }` and `tokens: { input: 3, output: 1 }` must return `ToolUsageAttributes` with `input_tokens: 13, output_tokens: 6, cache_read_tokens: 2` and no `cache_creation_tokens` key; deltas with no `tokens` field at all must produce attributes with none of the four keys present.**

- [ ] **Step 1: Write the failing test**

```ts
// src/providers/plugins/sso/session/processors/metrics/__tests__/metrics-aggregator-tokens.test.ts
import { describe, it, expect } from 'vitest';
import { aggregateDeltas } from '../metrics-aggregator.js';
import type { MetricDelta } from '../../../../../../../agents/core/metrics/types.js';

function makeDelta(overrides: Partial<MetricDelta>): MetricDelta {
  return {
    recordId: 'r1',
    sessionId: 's1',
    agentSessionId: 'a1',
    timestamp: Date.now(),
    gitBranch: 'main',
    syncStatus: 'pending',
    syncAttempts: 0,
    ...overrides,
  };
}

describe('metrics-aggregator token accumulation', () => {
  it('sums tokens across deltas and omits fields with zero total', () => {
    const deltas = [
      makeDelta({ tokens: { input: 10, output: 5, cacheRead: 2 } }),
      makeDelta({ tokens: { input: 3, output: 1 } }),
    ];
    const result = aggregateDeltas(deltas, /* session */ { agentName: 'claude', workingDirectory: '/tmp', sessionId: 's1' } as any, '1.0.0', 'codemie-claude');
    const branchAttrs = result.get('main');
    expect(branchAttrs?.input_tokens).toBe(13);
    expect(branchAttrs?.output_tokens).toBe(6);
    expect(branchAttrs?.cache_read_tokens).toBe(2);
    expect(branchAttrs?.cache_creation_tokens).toBeUndefined();
  });

  it('omits all four token fields when no delta carries tokens', () => {
    const deltas = [makeDelta({})];
    const result = aggregateDeltas(deltas, { agentName: 'claude', workingDirectory: '/tmp', sessionId: 's1' } as any, '1.0.0', 'codemie-claude');
    const branchAttrs = result.get('main');
    expect(branchAttrs?.input_tokens).toBeUndefined();
    expect(branchAttrs?.output_tokens).toBeUndefined();
  });
});
```

(Read `aggregateDeltas`'s real signature/return shape in `metrics-aggregator.ts` before finalizing this test — the existing `metrics-post-processing.test.ts` shows the exact call shape to reuse.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/providers/plugins/sso/session/processors/metrics/__tests__/metrics-aggregator-tokens.test.ts`
Expected: FAIL — `input_tokens` is `undefined`.

- [ ] **Step 3: Add the four fields to both attribute interfaces**

In `metrics-types.ts`, add to `SessionLifecycleAttributes` (after `active_duration_ms` at line 30) and to `ToolUsageAttributes` (after `schema_version` at line 90), the same block in both:

```ts
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
```

Update the `ToolUsageAttributes` doc comment at line 80 ("NOTE: No token fields.") to instead note that `tool_counts` stays banned but flat numeric token totals are now carried — do not touch the `tool_counts?: never` line itself.

- [ ] **Step 4: Add token accumulators to `buildSessionAttributes`**

In `metrics-aggregator.ts`, alongside the accumulator declarations (after `linesRemoved` at line 127):

```ts
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
```

Inside the per-delta loop (alongside the `delta.fileOperations` block, around line 175):

```ts
    if (delta.tokens) {
      inputTokens += delta.tokens.input || 0;
      outputTokens += delta.tokens.output || 0;
      cacheReadTokens += delta.tokens.cacheRead || 0;
      cacheCreationTokens += delta.tokens.cacheCreation || 0;
    }
```

In the `ToolUsageAttributes` object literal (after `total_lines_removed` at line 257), spread conditionally:

```ts
    ...(inputTokens > 0 && { input_tokens: inputTokens }),
    ...(outputTokens > 0 && { output_tokens: outputTokens }),
    ...(cacheReadTokens > 0 && { cache_read_tokens: cacheReadTokens }),
    ...(cacheCreationTokens > 0 && { cache_creation_tokens: cacheCreationTokens }),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/providers/plugins/sso/session/processors/metrics/__tests__/metrics-aggregator-tokens.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

---

### Task 3: Thread cumulative session totals through `sendSessionEnd` and read them in `hook.ts`

**Files:**
- Modify: `src/providers/plugins/sso/session/processors/metrics/metrics-api-client.ts:489-538`
- Modify: `src/cli/commands/hook.ts:1187-1280` (`sendSessionEndMetrics`)
- Test: `src/providers/plugins/sso/session/processors/metrics/__tests__/metrics-upload-contract.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `SessionLifecycleAttributes` token fields from Task 2; `MetricsWriter.readAll()` (`MetricsWriter.ts:62-78`, unchanged, already tolerates a missing file by returning `[]`).
- Produces: `MetricsSender.sendSessionEnd(session, workingDirectory, status, durationMs, error?, activeDurationMs?, tokens?)` — the new 7th parameter `tokens?: { input?: number; output?: number; cacheRead?: number; cacheCreation?: number }` is optional and trailing, so `DesktopTelemetryRuntime.sendSessionEndMetric` (`DesktopTelemetryRuntime.ts:289-303`, which passes exactly 6 positional args) stays source-compatible unchanged — no edit needed there.

**Test-first: yes — `sendSessionEnd` called with `tokens: { input: 100, output: 40, cacheRead: 5, cacheCreation: 0 }` must produce a `SessionLifecycleAttributes` payload containing `input_tokens: 100, output_tokens: 40, cache_read_tokens: 5` and no `cache_creation_tokens` key (zero omitted); called with no `tokens` argument at all must produce a payload with none of the four keys, proving the 6-arg call shape (as used by `DesktopTelemetryRuntime`) still compiles and runs.**

- [ ] **Step 1: Write the failing test**

Add to `metrics-upload-contract.test.ts` (reuse its existing `MetricsSender` construction/mock-fetch harness):

```ts
it('includes non-zero token fields on sendSessionEnd when tokens are provided', async () => {
  const { sender, capturedBody } = /* reuse the file's existing sender+fetch-capture setup */ setupSenderCapture();
  await sender.sendSessionEnd(
    baseSession, '/tmp/repo',
    { status: 'completed' }, 1000, undefined, undefined,
    { input: 100, output: 40, cacheRead: 5, cacheCreation: 0 }
  );
  expect(capturedBody().attributes.input_tokens).toBe(100);
  expect(capturedBody().attributes.output_tokens).toBe(40);
  expect(capturedBody().attributes.cache_read_tokens).toBe(5);
  expect(capturedBody().attributes.cache_creation_tokens).toBeUndefined();
});

it('omits all token fields when sendSessionEnd is called without a tokens argument', async () => {
  const { sender, capturedBody } = setupSenderCapture();
  await sender.sendSessionEnd(baseSession, '/tmp/repo', { status: 'completed' }, 1000);
  expect(capturedBody().attributes.input_tokens).toBeUndefined();
});
```

(Wire `setupSenderCapture`/`baseSession` to this file's existing helpers — read the file first to match its real fixture names.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/providers/plugins/sso/session/processors/metrics/__tests__/metrics-upload-contract.test.ts`
Expected: FAIL — `sendSessionEnd` does not accept a 7th argument / `input_tokens` is `undefined`.

- [ ] **Step 3: Add the `tokens` parameter to `sendSessionEnd`**

In `metrics-api-client.ts`, add a 7th parameter to the signature at line 495:

```ts
    activeDurationMs?: number,
    tokens?: { input?: number; output?: number; cacheRead?: number; cacheCreation?: number }
```

In the `SessionLifecycleAttributes` object literal (after `active_duration_ms` at line 517):

```ts
      ...(tokens?.input !== undefined && tokens.input > 0 && { input_tokens: tokens.input }),
      ...(tokens?.output !== undefined && tokens.output > 0 && { output_tokens: tokens.output }),
      ...(tokens?.cacheRead !== undefined && tokens.cacheRead > 0 && { cache_read_tokens: tokens.cacheRead }),
      ...(tokens?.cacheCreation !== undefined && tokens.cacheCreation > 0 && { cache_creation_tokens: tokens.cacheCreation }),
```

- [ ] **Step 4: Read and sum deltas in `hook.ts:sendSessionEndMetrics`**

After the session is loaded and the external-origin check passes (after line 1217), before `status` is built:

```ts
    const { MetricsWriter } = await import(
      '../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js'
    );
    const metricsWriter = new MetricsWriter(sessionId);
    const allDeltas = await metricsWriter.readAll();
    const tokens = allDeltas.reduce(
      (acc, delta) => {
        if (!delta.tokens) return acc;
        acc.input += delta.tokens.input || 0;
        acc.output += delta.tokens.output || 0;
        acc.cacheRead = (acc.cacheRead || 0) + (delta.tokens.cacheRead || 0);
        acc.cacheCreation = (acc.cacheCreation || 0) + (delta.tokens.cacheCreation || 0);
        return acc;
      },
      { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
    );
```

(Verify the relative import path against the file's existing dynamic-import style before finalizing — `hook.ts` already dynamic-imports `SessionStore`/`CodeMieSSO`/`MetricsSender` this same way.)

Pass `tokens` as the 7th argument to the existing `sender.sendSessionEnd(...)` call (line 1270).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/providers/plugins/sso/session/processors/metrics/__tests__/metrics-upload-contract.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

---

### Task 4: Add the four fields to debug-log and dry-run projections

**Files:**
- Modify: `src/providers/plugins/sso/session/processors/metrics/metrics-api-client.ts:108-148` (`sendRequest` debug-log allow-list), `:540-561` (`sendSessionEnd` dry-run log)
- Test: `src/providers/plugins/sso/session/processors/metrics/__tests__/metrics-upload-contract.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `SessionLifecycleAttributes`/`ToolUsageAttributes` token fields from Task 2/3.

**Test-first: yes — a `sendRequest` debug-log call for a metric whose attributes carry `input_tokens: 5, output_tokens: 2` must produce a logged projection object containing `input_tokens: 5, output_tokens: 2` (asserted via a spy on `logger.debug`); a `sendSessionEnd` call in dry-run mode with `tokens: { input: 5, output: 2 }` must produce a logged dry-run payload containing the token totals.**

- [ ] **Step 1: Write the failing test**

```ts
it('includes token fields in the sendRequest debug-log projection', async () => {
  const debugSpy = vi.spyOn(logger, 'debug');
  const { sender } = setupSenderCapture();
  await sender.sendSessionMetric({
    name: 'codemie_cli_tool_usage_total',
    attributes: { ...toolUsageBase, input_tokens: 5, output_tokens: 2 },
  } as any);
  const call = debugSpy.mock.calls.find(c => c[0] === '[MetricsApiClient] Sending metric payload');
  expect(call?.[1].attributes.input_tokens).toBe(5);
  expect(call?.[1].attributes.output_tokens).toBe(2);
});

it('includes token totals in the sendSessionEnd dry-run log', async () => {
  const infoSpy = vi.spyOn(logger, 'info');
  const { dryRunSender } = setupDryRunSender();
  await dryRunSender.sendSessionEnd(
    baseSession, '/tmp/repo', { status: 'completed' }, 1000, undefined, undefined,
    { input: 5, output: 2 }
  );
  const call = infoSpy.mock.calls.find(c => c[0] === '[MetricsSender] [DRY-RUN] Would send session end metric:');
  expect(call?.[1].metric.attributes.input_tokens).toBe(5);
  expect(call?.[1].metric.attributes.output_tokens).toBe(2);
});
```

(Reuse the file's existing `logger` import/spy pattern and add a `setupDryRunSender` helper alongside the existing dry-run tests if one is not already present.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/providers/plugins/sso/session/processors/metrics/__tests__/metrics-upload-contract.test.ts`
Expected: FAIL — the logged projection objects do not carry the four token keys.

- [ ] **Step 3: Add the fields to the `sendRequest` debug-log allow-list**

In `metrics-api-client.ts`, inside the `attributes: {...}` block of the `logger.debug('[MetricsApiClient] Sending metric payload', ...)` call (after `total_lines_removed` at line 146):

```ts
        input_tokens: 'input_tokens' in metric.attributes ? metric.attributes.input_tokens : undefined,
        output_tokens: 'output_tokens' in metric.attributes ? metric.attributes.output_tokens : undefined,
        cache_read_tokens: 'cache_read_tokens' in metric.attributes ? metric.attributes.cache_read_tokens : undefined,
        cache_creation_tokens: 'cache_creation_tokens' in metric.attributes ? metric.attributes.cache_creation_tokens : undefined,
```

- [ ] **Step 4: Add the fields to the `sendSessionEnd` dry-run log**

In the dry-run `logger.info('[MetricsSender] [DRY-RUN] Would send session end metric:', ...)` block (inside `metric.attributes` at line 546-556), add:

```ts
            ...(attributes.input_tokens !== undefined && { input_tokens: attributes.input_tokens }),
            ...(attributes.output_tokens !== undefined && { output_tokens: attributes.output_tokens }),
            ...(attributes.cache_read_tokens !== undefined && { cache_read_tokens: attributes.cache_read_tokens }),
            ...(attributes.cache_creation_tokens !== undefined && { cache_creation_tokens: attributes.cache_creation_tokens }),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/providers/plugins/sso/session/processors/metrics/__tests__/metrics-upload-contract.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

---

## Negative-constraint pass

- No `provider === 'anthropic-subscription'` gate: Tasks 1-4 add fields unconditionally to `MetricDelta`, both attribute interfaces, `sendSessionEnd`, and the log projections — no provider check appears anywhere in any task. Confirmed no task violates this.
- No cost/money computation or transmission: no task reads, computes, or forwards a price/cost/money field; only raw token counts (`input`/`output`/`cacheRead`/`cacheCreation`) are handled, end to end. Confirmed no task violates this.
- No changes to gemini/kimi/codex/pi/opencode metrics-processor.ts: only `claude.metrics-processor.ts` is modified (Task 1); the other five are never named as a Modify/Create target in any task.
- No `schema_version` bump: Task 2's `metrics-types.ts` edit adds four optional fields only; no task touches the `schema_version` line or increments its value anywhere (`metrics-aggregator.ts:263`, `metrics-api-client.ts:433`, `:533` all stay untouched).
- `tool_counts?: never` stays untouched: Task 2 explicitly instructs updating only the doc comment above it, not the `tool_counts` line itself; no task's steps modify that field's type.
- Missing/empty delta file tolerance: Task 3 reuses `MetricsWriter.readAll()` as-is (no modification task against `MetricsWriter.ts` exists) and its `reduce` starts from a zeroed accumulator, so an empty array yields all-zero (then omitted, since Task 3's spread conditions require `> 0`) totals — no new error handling was added, matching the constraint.
