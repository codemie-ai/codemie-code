/**
 * Metrics Post-Processing Integration Tests
 *
 * End-to-end tests for metrics aggregation and sanitization
 */

import {describe, it, expect, beforeEach} from 'vitest';
import {aggregateDeltas} from '../../../src/providers/plugins/sso/session/processors/metrics/metrics-aggregator.js';
import type {MetricDelta} from '../../../src/agents/core/metrics/types.js';
import type {Session as MetricsSession} from '../../../src/agents/core/session/types.js';

describe('Metrics Post-Processing Integration', () => {
  let mockSession: MetricsSession;

  beforeEach(() => {
    mockSession = {
      sessionId: 'test-session-id',
      agentName: 'claude',
      provider: 'ai-run-sso',
      startTime: Date.now(),
      workingDirectory: '/Users/Nikita/repos/EPMCDME/codemie-ai/codemie-code',
      correlation: {
        status: 'matched',
        agentSessionId: 'test-session-id',
        retryCount: 0
      },
      status: 'active'
    };
  });

  it('should aggregate and sanitize metrics end-to-end', () => {
    const deltas: MetricDelta[] = [
      {
        recordId: 'record-1',
        sessionId: 'test-session-id',
        agentSessionId: 'agent-session-1',
        timestamp: Date.now(),
        gitBranch: 'main',
        tools: {
          Read: 2,
          Bash: 1
        },
        toolStatus: {
          Read: {success: 2, failure: 0},
          Bash: {success: 0, failure: 1}
        },
        apiErrorMessage: '\x1b[31mError: bash command failed\x1b[0m',
        syncStatus: 'pending',
        syncAttempts: 0
      },
      {
        recordId: 'record-2',
        sessionId: 'test-session-id',
        agentSessionId: 'agent-session-1',
        timestamp: Date.now() + 1000,
        gitBranch: 'main',
        tools: {
          Write: 1,
          Edit: 1
        },
        toolStatus: {
          Write: {success: 1, failure: 0},
          Edit: {success: 1, failure: 0}
        },
        fileOperations: [
          {
            type: 'write',
            path: '/foo/bar.ts',
            linesAdded: 10,
            linesRemoved: 0
          },
          {
            type: 'edit',
            path: '/foo/baz.ts',
            linesAdded: 5,
            linesRemoved: 3
          }
        ],
        models: ['claude-4-5-sonnet'],
        userPrompts: [{count: 1, text: 'test prompt'}],
        syncStatus: 'pending',
        syncAttempts: 0
      }
    ];

    const metrics = aggregateDeltas(deltas, mockSession, '1.0.0');

    expect(metrics).toHaveLength(1); // One metric for 'main' branch
    const metric = metrics[0];

    // Check repository path truncation
    expect(metric.attributes.repository).toBe('codemie-ai/codemie-code');
    expect(metric.attributes.repository).not.toContain('/Users/');

    // Check tool aggregation
    expect(metric.attributes.total_tool_calls).toBe(5);
    expect(metric.attributes.successful_tool_calls).toBe(4);
    expect(metric.attributes.failed_tool_calls).toBe(1);

    // Check file operations
    expect(metric.attributes.files_created).toBe(1);
    expect(metric.attributes.files_modified).toBe(1);
    expect(metric.attributes.total_lines_added).toBe(15);
    expect(metric.attributes.total_lines_removed).toBe(3);

    // Bash is excluded for claude agent — all tools filtered → session is error-free
    expect(metric.attributes.had_errors).toBe(false);
    expect((metric.attributes as any).error_tools).toBeUndefined();
    expect((metric.attributes as any).error_messages).toBeUndefined();

    // Check user prompts
    expect(metric.attributes.total_user_prompts).toBe(1);

    // Check model
    expect(metric.attributes.llm_model).toBe('claude-4-5-sonnet');

    // Check other attributes
    expect(metric.attributes.agent).toBe('claude');
    expect(metric.attributes.branch).toBe('main');
    expect(metric.attributes.session_id).toBe('test-session-id');
  });

  it('should handle multiple branches correctly', () => {
    const deltas: MetricDelta[] = [
      {
        recordId: 'record-1',
        sessionId: 'test-session-id',
        agentSessionId: 'agent-session-1',
        timestamp: Date.now(),
        gitBranch: 'main',
        tools: {Read: 1},
        syncStatus: 'pending',
        syncAttempts: 0
      },
      {
        recordId: 'record-2',
        sessionId: 'test-session-id',
        agentSessionId: 'agent-session-1',
        timestamp: Date.now() + 1000,
        gitBranch: 'feature/test',
        tools: {Write: 1},
        syncStatus: 'pending',
        syncAttempts: 0
      }
    ];

    const metrics = aggregateDeltas(deltas, mockSession, '1.0.0');

    expect(metrics).toHaveLength(2); // Two metrics for two branches

    const mainMetric = metrics.find(m => m.attributes.branch === 'main');
    const featureMetric = metrics.find(m => m.attributes.branch === 'feature/test');

    expect(mainMetric).toBeDefined();
    expect(featureMetric).toBeDefined();

    // Both should have sanitized repository paths
    expect(mainMetric!.attributes.repository).toBe('codemie-ai/codemie-code');
    expect(featureMetric!.attributes.repository).toBe('codemie-ai/codemie-code');

    // Check tool separation
    expect(mainMetric!.attributes.total_tool_calls).toBe(1);
    expect(featureMetric!.attributes.total_tool_calls).toBe(1);
  });

  it('should handle empty project paths gracefully', () => {
    const sessionWithEmptyPath: MetricsSession = {
      ...mockSession,
      workingDirectory: ''
    };

    const deltas: MetricDelta[] = [
      {
        recordId: 'record-1',
        sessionId: 'test-session-id',
        agentSessionId: 'agent-session-1',
        timestamp: Date.now(),
        gitBranch: 'main',
        tools: {Read: 1},
        syncStatus: 'pending',
        syncAttempts: 0
      }
    ];

    const metrics = aggregateDeltas(deltas, sessionWithEmptyPath, '1.0.0');

    expect(metrics).toHaveLength(1);
    expect(metrics[0].attributes.repository).toBe('unknown');
  });

  it('should sanitize non-excluded tool errors', () => {
    const deltas: MetricDelta[] = [
      {
        recordId: 'record-1',
        sessionId: 'test-session-id',
        agentSessionId: 'agent-session-1',
        timestamp: Date.now(),
        gitBranch: 'main',
        tools: {Read: 1},
        toolStatus: {
          Read: {success: 0, failure: 1}
        },
        apiErrorMessage: '\x1b[31mError: file not found\nPath: /secret/path\x1b[0m',
        syncStatus: 'pending',
        syncAttempts: 0
      }
    ];

    const metrics = aggregateDeltas(deltas, mockSession, '1.0.0');

    expect(metrics).toHaveLength(1);
    const attrs = metrics[0].attributes as any;
    expect(attrs.had_errors).toBe(true);
    expect(attrs.error_tools).toBeDefined();
    expect(attrs.error_tools).toContain('Read');
    expect(attrs.error_messages).toBeDefined();
    expect(attrs.error_messages[0]).not.toContain('\x1b'); // ANSI stripped
    expect(attrs.error_messages[0]).toContain('\n');       // newlines preserved (not JSON-escaped)
  });

  it('should handle metrics with no errors', () => {
    const deltas: MetricDelta[] = [
      {
        recordId: 'record-1',
        sessionId: 'test-session-id',
        agentSessionId: 'agent-session-1',
        timestamp: Date.now(),
        gitBranch: 'main',
        tools: {Read: 1},
        toolStatus: {
          Read: {success: 1, failure: 0}
        },
        syncStatus: 'pending',
        syncAttempts: 0
      }
    ];

    const metrics = aggregateDeltas(deltas, mockSession, '1.0.0');

    expect(metrics).toHaveLength(1);
    expect(metrics[0].attributes.had_errors).toBe(false);
    expect((metrics[0].attributes as any).error_tools).toBeUndefined();
    expect((metrics[0].attributes as any).error_messages).toBeUndefined();
  });

  it('should truncate very long error messages', () => {
    const longErrorMessage = 'Error: ' + 'a'.repeat(2000);

    const deltas: MetricDelta[] = [
      {
        recordId: 'record-1',
        sessionId: 'test-session-id',
        agentSessionId: 'agent-session-1',
        timestamp: Date.now(),
        gitBranch: 'main',
        tools: {Read: 1},
        toolStatus: {
          Read: {success: 0, failure: 1}
        },
        apiErrorMessage: longErrorMessage,
        syncStatus: 'pending',
        syncAttempts: 0
      }
    ];

    const metrics = aggregateDeltas(deltas, mockSession, '1.0.0');

    expect(metrics).toHaveLength(1);

    const truncAttrs = metrics[0].attributes as any;
    expect(truncAttrs.error_messages).toBeDefined();
    expect(truncAttrs.error_messages[0].length).toBeLessThanOrEqual(500); // v2 cap
  });
});
