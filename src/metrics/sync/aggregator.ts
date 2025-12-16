/**
 * Metrics Aggregator
 *
 * Aggregates metric deltas into a single session metric.
 * Reuses patterns from analytics system.
 */

import type {MetricDelta, MetricsSession} from '../types.js';
import type {SessionAttributes, SessionMetric} from './types.js';
import type {AgentMetricsConfig} from '../../agents/core/types.js';
import {logger} from '../../utils/logger.js';
import {postProcessMetric} from './post-processor.js';

/**
 * Aggregate pending deltas into session metrics grouped by branch
 * Returns one metric per branch to prevent mixing metrics between branches
 *
 * @param deltas - Metric deltas to aggregate
 * @param session - Metrics session information
 * @param version - CLI version
 * @param agentConfig - Optional agent-specific metrics configuration (for post-processing)
 */
export function aggregateDeltas(
  deltas: MetricDelta[],
  session: MetricsSession,
  version: string,
  agentConfig?: AgentMetricsConfig
): SessionMetric[] {
  logger.debug(`[aggregator] Aggregating ${deltas.length} deltas for session ${session.sessionId}`);

  // Group deltas by branch
  const deltasByBranch = new Map<string, MetricDelta[]>();

  for (const delta of deltas) {
    const branch = delta.gitBranch || 'unknown';

    if (!deltasByBranch.has(branch)) {
      deltasByBranch.set(branch, []);
    }

    deltasByBranch.get(branch)!.push(delta);
  }

  logger.debug(`[aggregator] Grouped deltas into ${deltasByBranch.size} branches: ${Array.from(deltasByBranch.keys()).join(', ')}`);

  // Create one metric per branch
  const metrics: SessionMetric[] = [];

  for (const [branch, branchDeltas] of deltasByBranch) {
    logger.debug(`[aggregator] Building metric for branch "${branch}" with ${branchDeltas.length} deltas`);

    // Build attributes from deltas for this branch
    const attributes = buildSessionAttributes(branchDeltas, session, version, branch);

    // Create session metric for this branch
    const metric: SessionMetric = {
      name: 'codemie_cli_usage_total',
      attributes
    };

    // Post-process metric to sanitize sensitive data
    const sanitized = postProcessMetric(metric, agentConfig);
    metrics.push(sanitized);
  }

  return metrics;
}

/**
 * Build session attributes from deltas for a specific branch
 */
function buildSessionAttributes(
  deltas: MetricDelta[],
  session: MetricsSession,
  version: string,
  branch: string
): SessionAttributes {
  // Token aggregation
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;

  // Tool tracking
  const toolCounts: Record<string, number> = {};
  const toolSuccess: Record<string, number> = {};
  const toolFailures: Record<string, number> = {};

  // File operations
  let filesCreated = 0;
  let filesModified = 0;
  let filesDeleted = 0;
  let linesAdded = 0;
  let linesRemoved = 0;

  // Model tracking (count occurrences)
  const modelCounts: Record<string, number> = {};

  // User prompts
  let userPromptCount = 0;

  // Error tracking
  let hadErrors = false;
  const errorsByTool: Record<string, string[]> = {};

  // Aggregate all deltas
  for (const delta of deltas) {
    // Tokens
    totalInput += delta.tokens.input || 0;
    totalOutput += delta.tokens.output || 0;
    totalCacheRead += delta.tokens.cacheRead || 0;
    totalCacheCreation += delta.tokens.cacheCreation || 0;

    // Tools
    for (const [toolName, count] of Object.entries(delta.tools)) {
      toolCounts[toolName] = (toolCounts[toolName] || 0) + count;
    }

    // Tool status
    if (delta.toolStatus) {
      for (const [toolName, status] of Object.entries(delta.toolStatus)) {
        toolSuccess[toolName] = (toolSuccess[toolName] || 0) + status.success;
        toolFailures[toolName] = (toolFailures[toolName] || 0) + status.failure;
      }
    }

    // File operations
    if (delta.fileOperations) {
      for (const op of delta.fileOperations) {
        if (op.type === 'write') filesCreated++;
        if (op.type === 'edit') filesModified++;
        if (op.type === 'delete') filesDeleted++;

        linesAdded += op.linesAdded || 0;
        linesRemoved += op.linesRemoved || 0;
      }
    }

    // Models
    if (delta.models) {
      for (const model of delta.models) {
        modelCounts[model] = (modelCounts[model] || 0) + 1;
      }
    }

    // User prompts
    if (delta.userPrompts) {
      userPromptCount += delta.userPrompts.length;
    }

    // Errors - collect all tool-specific error messages (tools can have multiple errors)
    if (delta.apiErrorMessage) {
      hadErrors = true;

      // Try to extract tool name from delta
      // If we have toolStatus with failures, associate error with that tool
      if (delta.toolStatus) {
        for (const [toolName, status] of Object.entries(delta.toolStatus)) {
          if (status.failure > 0) {
            // Initialize array if not exists
            if (!errorsByTool[toolName]) {
              errorsByTool[toolName] = [];
            }
            // Add error to the tool's error list
            errorsByTool[toolName].push(delta.apiErrorMessage);
          }
        }
      }

      // If no tool status with failures, it's a general error
      if (Object.keys(errorsByTool).length === 0) {
        if (!errorsByTool['general']) {
          errorsByTool['general'] = [];
        }
        errorsByTool['general'].push(delta.apiErrorMessage);
      }
    }
  }

  // Determine most-used model
  const primaryModel = getMostUsedModel(modelCounts);

  // Calculate total tool calls
  const totalToolCalls = Object.values(toolCounts).reduce((sum, count) => sum + count, 0);
  const successfulToolCalls = Object.values(toolSuccess).reduce((sum, count) => sum + count, 0);
  const failedToolCalls = Object.values(toolFailures).reduce((sum, count) => sum + count, 0);

  // Calculate session duration from deltas (incremental batch duration)
  const sessionDuration = calculateDurationFromDeltas(deltas, session);

  // Build attributes
  const attributes: any = {
    // Identity
    agent: session.agentName,
    agent_version: version,
    llm_model: primaryModel || 'unknown',
    repository: session.workingDirectory,
    session_id: session.sessionId,
    branch: branch,

    // Interaction Metrics
    total_user_prompts: userPromptCount,

    // Token Metrics
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_cache_read_input_tokens: totalCacheRead,
    total_cache_creation_tokens: totalCacheCreation,

    // Tool Metrics
    total_tool_calls: totalToolCalls,
    successful_tool_calls: successfulToolCalls,
    failed_tool_calls: failedToolCalls,

    // File Operation Metrics
    files_created: filesCreated,
    files_modified: filesModified,
    files_deleted: filesDeleted,
    total_lines_added: linesAdded,
    total_lines_removed: linesRemoved,

    // Session Metadata
    session_duration_ms: sessionDuration,
    had_errors: hadErrors,
    count: 1 // Prometheus compatibility
  };

  // Add errors map only if there are errors
  if (hadErrors && Object.keys(errorsByTool).length > 0) {
    attributes.errors = errorsByTool;
  }

  return attributes;
}

/**
 * Get most-used model from counts
 */
function getMostUsedModel(modelCounts: Record<string, number>): string | null {
  const entries = Object.entries(modelCounts);

  if (entries.length === 0) {
    return null;
  }

  // Sort by count descending
  entries.sort((a, b) => b[1] - a[1]);

  return entries[0][0];
}

/**
 * Calculate session duration from deltas (incremental batch duration)
 * This calculates the time span covered by this batch of metrics,
 * not the total session duration.
 */
function calculateDurationFromDeltas(deltas: MetricDelta[], session: MetricsSession): number {
  if (deltas.length === 0) {
    return 0;
  }

  // Convert timestamps to numbers (handle both Unix ms and ISO strings)
  const timestamps = deltas.map((delta) => {
    const ts = delta.timestamp;
    return typeof ts === 'string' ? new Date(ts).getTime() : ts;
  });

  // Calculate duration from earliest to latest delta in this batch
  const minTimestamp = Math.min(...timestamps);
  const maxTimestamp = Math.max(...timestamps);

  // Duration covered by this batch of deltas
  const batchDuration = maxTimestamp - minTimestamp;

  // If this is the first batch (only one delta or all same timestamp),
  // use time since session start
  if (batchDuration === 0) {
    return maxTimestamp - session.startTime;
  }

  return batchDuration;
}

