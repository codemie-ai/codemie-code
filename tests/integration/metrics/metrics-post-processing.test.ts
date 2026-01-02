/**
 * Metrics Post-Processing Integration Tests
 *
 * End-to-end tests for metrics aggregation and sanitization
 */

import {describe, it, expect, beforeEach} from 'vitest';
import {aggregateDeltas} from '../../../src/providers/plugins/sso/metrics/sync/sso.metrics-aggregator.js';
import type {MetricDelta, MetricsSession} from '../../../src/providers/plugins/sso/metrics/types.js';

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
        retryCount: 0
      },
      monitoring: {
        isActive: false,
        changeCount: 0
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
        tokens: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheCreation: 0
        },
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
        tokens: {
          input: 200,
          output: 100,
          cacheRead: 50,
          cacheCreation: 25
        },
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

    // Check token aggregation
    expect(metric.attributes.total_input_tokens).toBe(300);
    expect(metric.attributes.total_output_tokens).toBe(150);
    expect(metric.attributes.total_cache_read_input_tokens).toBe(50);
    expect(metric.attributes.total_cache_creation_tokens).toBe(25);

    // Check tool aggregation
    expect(metric.attributes.total_tool_calls).toBe(5);
    expect(metric.attributes.successful_tool_calls).toBe(4);
    expect(metric.attributes.failed_tool_calls).toBe(1);

    // Check file operations
    expect(metric.attributes.files_created).toBe(1);
    expect(metric.attributes.files_modified).toBe(1);
    expect(metric.attributes.total_lines_added).toBe(15);
    expect(metric.attributes.total_lines_removed).toBe(3);

    // Check error filtering (Bash should be excluded for Claude agent)
    // Since only Bash tool failed and it's excluded, had_errors should be false
    expect(metric.attributes.had_errors).toBe(false);
    expect(metric.attributes.errors).toBeUndefined();

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
        tokens: {input: 100, output: 50},
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
        tokens: {input: 200, output: 100},
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

    // Check token separation
    expect(mainMetric!.attributes.total_input_tokens).toBe(100);
    expect(featureMetric!.attributes.total_input_tokens).toBe(200);
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
        tokens: {input: 100, output: 50},
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
        tokens: {input: 100, output: 50},
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
    expect(metrics[0].attributes.had_errors).toBe(true);
    expect(metrics[0].attributes.errors).toBeDefined();

    if (metrics[0].attributes.errors) {
      const readErrors = metrics[0].attributes.errors.Read;
      expect(readErrors).toBeDefined();
      expect(readErrors[0]).not.toContain('\x1b'); // ANSI stripped
      expect(readErrors[0]).toContain('\\n'); // Newlines escaped
    }
  });

  it('should handle metrics with no errors', () => {
    const deltas: MetricDelta[] = [
      {
        recordId: 'record-1',
        sessionId: 'test-session-id',
        agentSessionId: 'agent-session-1',
        timestamp: Date.now(),
        gitBranch: 'main',
        tokens: {input: 100, output: 50},
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
    expect(metrics[0].attributes.errors).toBeUndefined();
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
        tokens: {input: 100, output: 50},
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

    if (metrics[0].attributes.errors) {
      const readErrors = metrics[0].attributes.errors.Read;
      expect(readErrors).toBeDefined();
      expect(readErrors[0].length).toBeLessThanOrEqual(1017); // 1000 + '...[truncated]'
      expect(readErrors[0]).toContain('...[truncated]');
    }
  });
});
