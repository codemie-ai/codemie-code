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
import type {SessionMetric} from './types.js';
import type {AgentMetricsConfig} from '../../agents/core/types.js';
import {METRICS_CONFIG} from '../config.js';
import {logger} from '../../utils/logger.js';

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

  // 2. Filter and sanitize errors
  if (sanitized.attributes.had_errors && sanitized.attributes.errors) {
    sanitized.attributes.errors = filterAndSanitizeErrors(
      sanitized.attributes.errors,
      agentConfig
    );

    // If all errors were filtered, update had_errors flag
    if (Object.keys(sanitized.attributes.errors).length === 0) {
      sanitized.attributes.had_errors = false;
      delete sanitized.attributes.errors;
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
 * Filter and sanitize errors based on agent configuration
 * Removes errors from excluded tools and sanitizes remaining errors
 *
 * @param errors - Map of tool names to error message arrays
 * @param agentConfig - Optional agent-specific configuration (overrides global defaults)
 */
export function filterAndSanitizeErrors(
  errors: Record<string, string[]>,
  agentConfig?: AgentMetricsConfig
): Record<string, string[]> {
  // Get excluded tools from agent config or fall back to global defaults
  const excludedTools = agentConfig?.excludeErrorsFromTools
    || (METRICS_CONFIG as any).excludeErrorsFromTools
    || [];

  logger.debug(`[post-processor] Filtering errors, excluded tools: [${excludedTools.join(', ')}]`);

  const filtered: Record<string, string[]> = {};

  for (const [toolName, errorMessages] of Object.entries(errors)) {
    // Skip errors from excluded tools
    if (excludedTools.includes(toolName)) {
      logger.debug(`[post-processor] Excluding errors from tool: ${toolName}`);
      continue;
    }

    // Sanitize error messages
    const sanitizedMessages = errorMessages.map(sanitizeError);
    filtered[toolName] = sanitizedMessages;
  }

  return filtered;
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
