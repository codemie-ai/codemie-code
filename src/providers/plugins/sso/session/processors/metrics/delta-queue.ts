import type { MetricDelta } from '@/agents/core/metrics/types.js';

/**
 * Whether a metric delta may still be sent: pending or failed, however many attempts it has
 * (`syncAttempts` is diagnostic only; a `rejected` delta is terminal).
 */
export function isDeltaSendCandidate(delta: Pick<MetricDelta, 'syncStatus' | 'syncAttempts'>): boolean {
  return delta.syncStatus === 'pending' || delta.syncStatus === 'failed';
}
