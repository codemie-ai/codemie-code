/**
 * Metrics Aggregator
 *
 * Aggregates metric deltas into a single session metric.
 * Reuses patterns from analytics system.
 */

import stripAnsi from 'strip-ansi';
import type { MetricDelta } from '../../../../../../agents/core/metrics/types.js';
import type { Session } from '../../../../../../agents/core/session/types.js';
import type {ToolUsageAttributes, SessionMetric} from './metrics-types.js';
import type {AgentMetricsConfig} from '../../../../../../agents/core/types.js';
import {logger} from '../../../../../../utils/logger.js';
import { extractRepository } from '../../../../../../utils/paths.js';
import {postProcessMetric} from './metrics-post-processor.js';
import {MetricsSender} from './metrics-api-client.js';

const ERROR_TOOLS_CAP = 100;
const ERROR_MESSAGES_CAP = 200;
const ERROR_TOOL_MAX_LEN = 200;
const ERROR_MESSAGE_MAX_LEN = 500;

/**
 * Sanitize a tool name for error_tools: strip control chars and <>" then truncate.
 * Returns null if the result is empty or contains internal spaces (garbled XML/JSX noise).
 * e.g. `Agent\" id=\"agent_discovery` → strips `"` → `Agent\ id=\agent_discovery` → null (space)
 */
function sanitizeToolNameForError(name: string): string | null {
  // eslint-disable-next-line no-control-regex
  const stripped = name.replace(/[\x00-\x1f\x7f<>"]/g, '').trim();
  if (!stripped || stripped.includes(' ')) return null;
  return stripped.substring(0, ERROR_TOOL_MAX_LEN);
}

/**
 * Sanitize an error message: strip ANSI, normalize newlines, truncate.
 */
function sanitizeErrorMessage(message: string): string {
  let s = stripAnsi(message);
  s = s.replace(/\r\n/g, '\n');
  return s.substring(0, ERROR_MESSAGE_MAX_LEN);
}

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
  session: Session,
  version: string,
  clientType: string,
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
    const attributes = buildSessionAttributes(branchDeltas, session, version, clientType, branch);

    // Create session metric for this branch
    const metric: SessionMetric = {
      name: MetricsSender.METRIC_TOOL_USAGE_TOTAL,
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
  session: Session,
  version: string,
  clientType: string,
  branch: string
): ToolUsageAttributes {
  // Use agent session ID from session correlation for API calls
  // This is the canonical source of truth set during SessionStart
  // Fallback: If correlation not set, try deltas, then session ID
  const agentSessionId = session.correlation?.agentSessionId
    || deltas[0]?.agentSessionId
    || session.sessionId;

  // Tool tracking (internal — counts used for totals/tool_names only, not emitted as dict)
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

  // Error tracking — parallel arrays (v2 schema, no dict keys in ES)
  let hadErrors = false;
  const errorToolSet = new Set<string>(); // deduped
  const errorMessages: string[] = [];
  const apiErrors: string[] = [];

  // Aggregate all deltas
  for (const delta of deltas) {
    // Tools (defensive: old deltas might not have tools field)
    if (delta.tools) {
      for (const [toolName, count] of Object.entries(delta.tools)) {
        const clean = sanitizeToolNameForError(toolName);
        if (!clean) {
          logger.debug(`[aggregator] Skipping malformed tool name: "${toolName.substring(0, 60)}"`);
          continue;
        }
        toolCounts[clean] = (toolCounts[clean] || 0) + count;
      }
    }

    // Tool status
    if (delta.toolStatus) {
      for (const [toolName, status] of Object.entries(delta.toolStatus)) {
        const clean = sanitizeToolNameForError(toolName);
        if (!clean) continue;
        toolSuccess[clean] = (toolSuccess[clean] || 0) + status.success;
        toolFailures[clean] = (toolFailures[clean] || 0) + status.failure;
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

    // Errors — collect into parallel arrays (correlation intentionally dropped per spec)
    if (delta.apiErrorMessage) {
      hadErrors = true;

      const hasToolErrors = delta.toolStatus &&
        Object.values(delta.toolStatus).some(status => status.failure > 0);

      if (hasToolErrors) {
        for (const [toolName, status] of Object.entries(delta.toolStatus ?? {})) {
          if (status.failure > 0) {
            const clean = sanitizeToolNameForError(toolName);
            if (clean) errorToolSet.add(clean);
          }
        }

        if (errorMessages.length < ERROR_MESSAGES_CAP) {
          errorMessages.push(sanitizeErrorMessage(delta.apiErrorMessage));
        }
      } else {
        if (apiErrors.length < ERROR_MESSAGES_CAP) {
          apiErrors.push(sanitizeErrorMessage(delta.apiErrorMessage));
        }
      }
    }
  }

  // Determine most-used model
  const sessionModel = (session as Session & { model?: string }).model;
  const primaryModel = getMostUsedModel(modelCounts) || sessionModel;

  // Calculate total tool calls from internal counts
  const totalToolCalls = Object.values(toolCounts).reduce((sum, c) => sum + c, 0);
  const successfulToolCalls = Object.values(toolSuccess).reduce((sum, c) => sum + c, 0);
  const failedToolCalls = Object.values(toolFailures).reduce((sum, c) => sum + c, 0);

  // tool_names is repeated once per invocation so backend raw-document classifiers can
  // recover per-tool counts (tool_counts dict is intentionally not emitted — ES drops docs
  // containing dict fields with unbounded keys).
  const toolNames = expandToolNames(toolCounts);

  // Calculate session duration from deltas (incremental batch duration)
  const sessionDuration = calculateDurationFromDeltas(deltas, session);

  // Build attributes — v2 schema: no errors dict, no tool_counts dict
  const attributes: ToolUsageAttributes = {
    // Identity
    agent: session.agentName,
    agent_version: version,
    codemie_client: clientType,
    llm_model: primaryModel || 'unknown',
    repository: session.repository ?? extractRepository(session.workingDirectory),
    session_id: agentSessionId,
    branch: branch,
    ...(session.project && { project: session.project }),

    // Interaction Metrics
    total_user_prompts: userPromptCount,

    // Tool Metrics — tool_counts dict intentionally omitted; tool_names is per-invocation
    tool_names: toolNames,
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
    schema_version: 2,
    count: 1 // Prometheus compatibility
  };

  // Add parallel error arrays only when present (v2 — no dict keys, ES mapping stays bounded)
  if (hadErrors) {
    const tools = [...errorToolSet].slice(0, ERROR_TOOLS_CAP);
    if (tools.length > 0) attributes.error_tools = tools;
    if (errorMessages.length > 0) attributes.error_messages = errorMessages;
    if (apiErrors.length > 0) attributes.api_errors = apiErrors;
  }

  return attributes;
}

function expandToolNames(toolCounts: Record<string, number>): string[] {
  const names: string[] = [];
  for (const toolName of Object.keys(toolCounts).sort()) {
    const count = Math.max(0, Math.floor(toolCounts[toolName] || 0));
    for (let index = 0; index < count; index++) {
      names.push(toolName);
    }
  }
  return names;
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
function calculateDurationFromDeltas(deltas: MetricDelta[], session: Session): number {
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
