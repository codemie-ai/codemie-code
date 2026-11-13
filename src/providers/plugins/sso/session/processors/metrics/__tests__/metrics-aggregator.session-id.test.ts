/**
 * aggregateDeltas: the session_id a metric carries
 * @group unit
 */
import { describe, it, expect } from 'vitest';
import { aggregateDeltas } from '../metrics-aggregator.js';
import type { MetricDelta } from '@/agents/core/metrics/types.js';
import type { Session } from '@/agents/core/session/types.js';

const delta = (overrides: Partial<MetricDelta> = {}): MetricDelta => ({
  recordId: 'r1',
  sessionId: 'fresh-uuid',
  agentSessionId: '',
  timestamp: 1_790_000_000_000,
  tools: {},
  syncStatus: 'pending',
  ...overrides,
} as MetricDelta);

const record = (overrides: Partial<Session> = {}): Session => ({
  sessionId: 'fresh-uuid',
  agentName: 'claude',
  provider: 'ai-run-sso',
  startTime: 1_790_000_000_000,
  workingDirectory: '/tmp/project',
  status: 'completed',
  activeDurationMs: 0,
  correlation: { status: 'matched', retryCount: 0 },
  ...overrides,
});

describe('aggregateDeltas session_id', () => {
  it('prefers the id the start metric was accepted under', () => {
    const [metric] = aggregateDeltas([delta()], record({ startMetricSessionId: 'accepted', originSessionId: 'origin' }), '1.0.0', 'codemie-cli');
    expect(metric.attributes.session_id).toBe('accepted');
  });

  it('falls back to the id a re-keyed /clear generation was known by, never its fresh id', () => {
    const [metric] = aggregateDeltas([delta()], record({ originSessionId: 'origin-session' }), '1.0.0', 'codemie-cli');
    expect(metric.attributes.session_id).toBe('origin-session');
  });

  it('falls back to the record id when nothing else names the session', () => {
    const [metric] = aggregateDeltas([delta()], record(), '1.0.0', 'codemie-cli');
    expect(metric.attributes.session_id).toBe('fresh-uuid');
  });
});
