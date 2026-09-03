/**
 * Verifies that metrics-aggregator sums MetricDelta.tokens across deltas into the four
 * flat token fields on ToolUsageAttributes, omitting fields whose total is zero.
 */
import { describe, it, expect } from 'vitest';
import { aggregateDeltas } from '../metrics-aggregator.js';
import type { MetricDelta } from '../../../../../../../agents/core/metrics/types.js';
import type { Session } from '../../../../../../../agents/core/session/types.js';

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

function makeSession(): Session {
  return {
    sessionId: 's1',
    agentName: 'claude',
    provider: 'ai-run-sso',
    startTime: Date.now(),
    workingDirectory: '/tmp',
    correlation: {} as Session['correlation'],
    status: 'active',
    activeDurationMs: 0,
  } as Session;
}

describe('metrics-aggregator token accumulation', () => {
  it('sums tokens across deltas and omits fields with zero total', () => {
    const deltas = [
      makeDelta({ tokens: { input: 10, output: 5, cacheRead: 2 } }),
      makeDelta({ tokens: { input: 3, output: 1 } }),
    ];
    const metrics = aggregateDeltas(deltas, makeSession(), '1.0.0', 'codemie-claude');
    const attrs = metrics[0].attributes as import('../metrics-types.js').ToolUsageAttributes;
    expect(attrs.input_tokens).toBe(13);
    expect(attrs.output_tokens).toBe(6);
    expect(attrs.cache_read_tokens).toBe(2);
    expect(attrs.cache_creation_tokens).toBeUndefined();
  });

  it('omits all four token fields when no delta carries tokens', () => {
    const deltas = [makeDelta({})];
    const metrics = aggregateDeltas(deltas, makeSession(), '1.0.0', 'codemie-claude');
    const attrs = metrics[0].attributes as import('../metrics-types.js').ToolUsageAttributes;
    expect(attrs.input_tokens).toBeUndefined();
    expect(attrs.output_tokens).toBeUndefined();
    expect(attrs.cache_read_tokens).toBeUndefined();
    expect(attrs.cache_creation_tokens).toBeUndefined();
  });
});
