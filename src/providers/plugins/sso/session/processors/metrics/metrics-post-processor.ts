/**
 * Metrics Post-Processor
 *
 * Sanitizes metrics before sending to API:
 * 1. Truncates project paths to prevent leaking sensitive directory info
 * 2. Filters out tool errors based on agent configuration
 * 3. Escapes/sanitizes error messages to prevent JSON issues
 */

import path from 'path';
import stripAnsi from 'strip-ansi';
import type {SessionMetric} from './metrics-types.js';
import type {AgentMetricsConfig} from '../../../../../../agents/core/types.js';
import {METRICS_CONFIG} from '../../../../../../agents/core/session/session-config.js';
import {logger} from '../../../../../../utils/logger.js';

/**
 * Post-process a session metric to sanitize sensitive data
 *
 * @param metric - The metric to sanitize
 * @param agentConfig - Optional agent-specific configuration (overrides global defaults)
 */
export function postProcessMetric(
  metric: SessionMetric,
  agentConfig?: AgentMetricsConfig
): SessionMetric {
  logger.debug(`[post-processor] Sanitizing metric`);

  // Clone to avoid mutation
  const sanitized: SessionMetric = {
    ...metric,
    attributes: {...metric.attributes}
  };

  // 1. Truncate repository path
  sanitized.attributes.repository = truncateProjectPath(sanitized.attributes.repository);

  // 2. Filter error_tools based on agent exclusion list
  if (sanitized.attributes.had_errors) {
    const attrs = sanitized.attributes as any;
    const originalErrorTools: string[] = attrs.error_tools ?? [];
    const removedTools: string[] = [];
    if (originalErrorTools.length) {
      const excludedTools = getExcludedTools(agentConfig);
      attrs.error_tools = originalErrorTools.filter((tool: string) => {
        if (excludedTools.includes(tool)) {
          removedTools.push(tool);
          return false;
        }
        return true;
      });
    }
    if (!attrs.error_tools?.length) {
      delete attrs.error_tools;
    }

    // Whenever any failing tool was excluded, replace the whole error_messages array
    // with generic placeholders. Messages are not correlated to individual tools at
    // this layer, so a message from an excluded tool cannot be removed selectively —
    // keeping the array because a non-excluded tool also failed would upload the raw
    // output the operator chose to exclude. This preserves the fact that errors
    // occurred (had_errors stays true) without leaking that output.
    if (removedTools.length > 0) {
      const uniqueRemoved = [...new Set(removedTools)];
      attrs.error_messages = uniqueRemoved.map((tool: string) => `Excluded tool failed: ${tool}`);
    } else if (!attrs.error_tools?.length) {
      delete attrs.error_messages;
    }

    if (!attrs.api_errors?.length) {
      delete attrs.api_errors;
    }

    if (!attrs.error_tools && !attrs.error_messages && !attrs.api_errors) {
      sanitized.attributes.had_errors = false;
    }
  }

  return sanitized;
}

/**
 * Truncate project path to parent/current format
 * Prevents leaking full directory structure
 *
 * Uses path.normalize() to handle mixed separators and edge cases
 *
 * @example
 * '/Users/Nikita/repos/EPMCDME/codemie-ai/codemie-code' → 'codemie-ai/codemie-code'
 * 'C:\\Users\\Dev\\projects\\my-app' → 'projects/my-app'
 * 'C:/Users/Name\\project' → 'Name/project' (mixed separators)
 * '/' → 'unknown' (root)
 * './parent/current' → 'parent/current' (relative)
 */
export function truncateProjectPath(fullPath: string): string {
  // Handle empty/null/undefined
  if (!fullPath || typeof fullPath !== 'string' || fullPath.trim() === '') {
    return 'unknown';
  }

  try {
    // Normalize path (handles mixed separators on Windows)
    const normalized = path.normalize(fullPath);

    // Split and filter empty segments and current directory markers
    const segments = normalized.split(path.sep).filter(s => s && s !== '.');

    // Handle edge cases
    if (segments.length === 0) {
      return 'unknown'; // Empty path after normalization
    }

    if (segments.length === 1) {
      // Single segment (e.g., root '/', drive 'C:', or single folder)
      const segment = segments[0];
      // Check if it's a root/drive indicator
      if (segment === '/' || segment.match(/^[A-Za-z]:$/)) {
        return 'unknown';
      }
      return segment;
    }

    // Take last 2 segments (parent/current)
    const last2 = segments.slice(-2);

    // Always use forward slash for API consistency
    return last2.join('/');
  } catch (error) {
    logger.warn(`[post-processor] Failed to truncate path "${fullPath}": ${error}`);
    return 'unknown';
  }
}

/**
 * Resolve the list of excluded tool names from agent config, falling back to
 * the global metrics config. The comparison is case-sensitive (tools are
 * emitted with their original casing; callers are expected to align casing).
 */
function getExcludedTools(agentConfig?: AgentMetricsConfig): string[] {
  return agentConfig?.excludeErrorsFromTools
    || (METRICS_CONFIG as any).excludeErrorsFromTools
    || [];
}

/**
 * Sanitize error message
 * 1. Strip ANSI color codes using strip-ansi library
 * 2. Normalize newlines
 * 3. Truncate at last complete line under 1000 chars (better UX)
 * 4. Escape for JSON safety
 */
export function sanitizeError(error: string): string {
  // 1. Strip ALL ANSI escape codes (handles OSC, CSI, etc.)
  let sanitized = stripAnsi(error);

  // 2. Normalize newlines (CRLF → LF)
  sanitized = sanitized.replace(/\r\n/g, '\n');

  // 3. Truncate at last complete line under 1000 chars (before escaping)
  const maxLength = 1000;
  if (sanitized.length > maxLength) {
    // Find last newline before maxLength
    const substring = sanitized.substring(0, maxLength);
    const lastNewline = substring.lastIndexOf('\n');

    // Use last complete line if it's past 50% threshold
    if (lastNewline > maxLength * 0.5) {
      sanitized = substring.substring(0, lastNewline) + '\n...[truncated]';
    } else {
      // Otherwise hard truncate
      sanitized = substring + '...[truncated]';
    }
  }

  // 4. Escape for JSON safety
  // IMPORTANT: Escape backslashes FIRST before other escape sequences
  sanitized = sanitized
    .replace(/\\/g, '\\\\')    // Escape backslashes first
    .replace(/"/g, '\\"')      // Escape quotes
    .replace(/\n/g, '\\n')     // Escape newlines
    .replace(/\t/g, '\\t');    // Escape tabs

  return sanitized;
}
