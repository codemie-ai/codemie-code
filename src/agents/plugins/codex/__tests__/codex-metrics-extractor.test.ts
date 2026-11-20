import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractCodexMetrics } from '../session/codex-metrics-extractor.js';
import type { CodexRolloutRecord } from '../codex-message-types.js';
import type { MetricDelta } from '../../../core/metrics/types.js';

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const fixtureDir = join(__dirname, 'fixtures');

function load(name: string): CodexRolloutRecord[] {
  return readFileSync(join(fixtureDir, name), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CodexRolloutRecord);
}

const addPatch = (callId: string, path: string): CodexRolloutRecord[] => [
  {
    type: 'response_item',
    payload: { type: 'custom_tool_call', status: 'completed', call_id: callId, name: 'apply_patch', input: `*** Begin Patch\n*** Add File: ${path}\n+a\n+b\n*** End Patch` },
  },
  { type: 'event_msg', payload: { type: 'patch_apply_end', call_id: callId, success: true } },
] as unknown as CodexRolloutRecord[];

describe('extractCodexMetrics apply_patch', () => {
  it('reports the real fixture as edit operations', () => {
    const metrics = extractCodexMetrics(load('rollout-2026-05-11T11-26-55-019e1625-789d-76c0-80ab-3724b5ddb799.jsonl'));
    expect(metrics.tools.apply_patch).toBe(3);
    expect(metrics.fileOperations).toHaveLength(3);
    expect(metrics.fileOperations.every((o) => o.type === 'edit')).toBe(true);
    expect(metrics.toolStatus.apply_patch).toEqual({ success: 3, failure: 0 });
  });

  it('reports an Add File as write', () => {
    const metrics = extractCodexMetrics(addPatch('c1', 'new.ts'));
    expect(metrics.fileOperations).toEqual([
      { type: 'write', path: 'new.ts', linesAdded: 2, linesRemoved: 0, linesModified: 2 },
    ]);
  });

  it('skips a result-less apply_patch call, as the processor does', () => {
    const pending = [
      { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'p1', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: x.ts\n+a\n*** End Patch' } },
    ] as unknown as CodexRolloutRecord[];
    const metrics = extractCodexMetrics(pending);
    expect(metrics.tools.apply_patch).toBeUndefined();
    expect(metrics.toolStatus.apply_patch).toBeUndefined();
  });

  it('reports a failed patch with no operations and a failure status', () => {
    const metrics = extractCodexMetrics(load('apply-patch-failures.jsonl'));
    expect(metrics.fileOperations).toEqual([]);
    expect(metrics.tools.apply_patch).toBe(2);
    expect(metrics.toolStatus.apply_patch.failure).toBe(2);
  });

  it('aggregates one write and one edit to files_created 1 and files_modified 1', async () => {
    const { aggregateDeltas } = await import('../../../../providers/plugins/sso/session/processors/metrics/metrics-aggregator.js');
    const records = [
      ...addPatch('c1', 'new.ts'),
      {
        type: 'response_item',
        payload: { type: 'custom_tool_call', call_id: 'c2', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: old.ts\n@@\n-a\n+b\n*** End Patch' },
      },
      { type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'c2', success: true } },
    ] as unknown as CodexRolloutRecord[];
    const metrics = extractCodexMetrics(records);
    const delta = {
      recordId: 'd1', sessionId: 's', agentSessionId: 's', timestamp: 1000, gitBranch: 'main',
      tools: metrics.tools, toolStatus: metrics.toolStatus, fileOperations: metrics.fileOperations,
      syncStatus: 'synced', syncAttempts: 0,
    } as MetricDelta;
    const [metric] = aggregateDeltas([delta], { sessionId: 's', startTime: 0, workingDirectory: '/tmp', agentName: 'codex' } as never, '1.0.0', 'codemie-codex');
    expect(metric.attributes).toMatchObject({ files_created: 1, files_modified: 1 });
  });
});
