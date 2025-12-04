/**
 * Remote Analytics Submission System
 *
 * Scheduled submission of analytics metrics to /v1/metrics endpoint
 * with event-level tracking and backend-aligned metric transformation.
 */

export { RemoteAnalyticsSubmitter } from './submitter.js';
export { CursorManager } from './cursor-manager.js';
export { LockManager } from './lock-manager.js';
export { createSessionMetric } from './metric-transformer.js';
export type {
  MetricPayload,
  MetricName,
  SessionMetricAttributes,
  CursorState,
  AgentCursorState,
  SessionSubmissionState,
  LockInfo,
  RemoteSubmissionConfig,
  SessionStatus
} from './types.js';
