export class CodeMieError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeMieError';
  }
}

export class ConfigurationError extends CodeMieError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export class AgentNotFoundError extends CodeMieError {
  constructor(agentName: string) {
    super(`Agent not found: ${agentName}`);
    this.name = 'AgentNotFoundError';
  }
}

export class AgentInstallationError extends CodeMieError {
  constructor(agentName: string, reason: string) {
    super(`Failed to install agent ${agentName}: ${reason}`);
    this.name = 'AgentInstallationError';
  }
}

export class ToolExecutionError extends CodeMieError {
  constructor(toolName: string, reason: string) {
    super(`Tool ${toolName} failed: ${reason}`);
    this.name = 'ToolExecutionError';
  }
}

export class PathSecurityError extends CodeMieError {
  constructor(path: string, reason: string) {
    super(`Path security violation: ${path} - ${reason}`);
    this.name = 'PathSecurityError';
  }
}

/**
 * npm error codes for categorizing failures
 */
export enum NpmErrorCode {
  NETWORK_ERROR = 'NETWORK_ERROR',
  PERMISSION_ERROR = 'PERMISSION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  TIMEOUT = 'TIMEOUT',
  UNKNOWN = 'UNKNOWN'
}

/**
 * Custom error class for npm operations
 */
export class NpmError extends CodeMieError {
  constructor(
    message: string,
    public code: NpmErrorCode,
    public originalError?: Error
  ) {
    super(message);
    this.name = 'NpmError';
  }
}

/**
 * Parse npm error from exec failure and create appropriate NpmError
 * @param error - The caught error from exec
 * @param context - Context message (e.g., "Failed to install package-name")
 * @returns Parsed NpmError with appropriate error code
 */
export function parseNpmError(error: unknown, context: string): NpmError {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const lowerMessage = errorMessage.toLowerCase();

  // Detect error type from message patterns
  let code: NpmErrorCode = NpmErrorCode.UNKNOWN;
  let hint = '';

  // Timeout (check first - most specific)
  if (lowerMessage.includes('timed out')) {
    code = NpmErrorCode.TIMEOUT;
    hint = 'Operation timed out. Try increasing the timeout or check your connection.';
  }
  // Permission errors
  else if (lowerMessage.includes('eacces') || lowerMessage.includes('eperm')) {
    code = NpmErrorCode.PERMISSION_ERROR;
    hint =
      'Try running with elevated permissions (sudo on Unix) or check directory permissions.';
  }
  // Package not found (check before network errors to prioritize 404)
  else if (
    lowerMessage.includes('404') ||
    lowerMessage.includes('e404')
  ) {
    code = NpmErrorCode.NOT_FOUND;
    hint = 'Verify the package name and version are correct.';
  }
  // Network errors
  else if (
    lowerMessage.includes('enotfound') ||
    lowerMessage.includes('etimedout') ||
    lowerMessage.includes('eai_again') ||
    lowerMessage.includes('network')
  ) {
    code = NpmErrorCode.NETWORK_ERROR;
    hint = 'Check your internet connection and npm registry configuration.';
  }

  const fullMessage = hint ? `${context}: ${errorMessage}\nHint: ${hint}` : `${context}: ${errorMessage}`;

  return new NpmError(
    fullMessage,
    code,
    error instanceof Error ? error : undefined
  );
}

/**
 * Extracts error message from unknown error type
 * @param error - The caught error (unknown type)
 * @returns Error message as string
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// ============================================================================
// Error Context and Formatting
// ============================================================================

import { platform, release, arch } from 'os';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Comprehensive error context for debugging
 */
export interface ErrorContext {
  // Error details
  error: {
    message: string;
    name: string;
    stack?: string;
    code?: string;
  };

  // System information
  system: {
    platform: string;
    platformVersion: string;
    arch: string;
    nodeVersion: string;
  };

  // Client information
  client: {
    name: string;
    version: string;
  };

  // Session context (if available)
  session?: {
    sessionId?: string;
    agent?: string;
    provider?: string;
    model?: string;
    profile?: string;
  };

  // Timestamp
  timestamp: string;
}

/**
 * Get client version from package.json
 */
function getClientVersion(): string {
  try {
    // Try to read package.json from project root
    const packageJsonPath = join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Get detailed OS information
 */
function getSystemInfo(): ErrorContext['system'] {
  return {
    platform: platform(),
    platformVersion: release(),
    arch: arch(),
    nodeVersion: process.version
  };
}

/**
 * Extract error details from unknown error type
 */
function extractErrorDetails(error: unknown): ErrorContext['error'] {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
      code: (error as NodeJS.ErrnoException).code
    };
  }

  if (typeof error === 'string') {
    return {
      message: error,
      name: 'Error',
      stack: new Error(error).stack
    };
  }

  // Handle objects (extract meaningful info)
  if (typeof error === 'object' && error !== null) {
    const errorObj = error as Record<string, unknown>;

    let message: string;

    if (typeof errorObj.message === 'string' && errorObj.message.trim()) {
      message = errorObj.message;
    } else if (typeof errorObj.error === 'string' && errorObj.error.trim()) {
      message = errorObj.error;
    } else if (typeof errorObj.description === 'string' && errorObj.description.trim()) {
      message = errorObj.description;
    } else {
      try {
        const stringified = JSON.stringify(error, null, 2);
        if (stringified && stringified !== '{}' && stringified !== '[object Object]') {
          message = stringified;
        } else {
          message = `Error object: ${Object.keys(errorObj).join(', ')}`;
        }
      } catch {
        message = `Error object: ${Object.keys(errorObj).join(', ')}`;
      }
    }

    const name = (typeof errorObj.name === 'string' ? errorObj.name : null) || 'UnknownError';
    const code = (typeof errorObj.code === 'string' ? errorObj.code : undefined);
    const stack = (typeof errorObj.stack === 'string' ? errorObj.stack : undefined) || new Error(message).stack;

    return {
      message,
      name,
      stack,
      code
    };
  }

  // Fallback for primitives
  const message = String(error);
  return {
    message,
    name: 'UnknownError',
    stack: new Error(message).stack
  };
}

/**
 * Create comprehensive error context for logging and debugging
 *
 * @param error - The error that occurred
 * @param sessionContext - Optional session context (session ID, agent, provider, etc.)
 * @returns Complete error context with system info, client version, and stack trace
 *
 * @example
 * ```typescript
 * try {
 *   await writeMetrics();
 * } catch (error) {
 *   const context = createErrorContext(error, { sessionId, agent: 'claude' });
 *   logger.error('Metrics write failed', context);
 * }
 * ```
 */
export function createErrorContext(
  error: unknown,
  sessionContext?: ErrorContext['session']
): ErrorContext {
  return {
    error: extractErrorDetails(error),
    system: getSystemInfo(),
    client: {
      name: 'codemie-code',
      version: getClientVersion()
    },
    session: sessionContext,
    timestamp: new Date().toISOString()
  };
}

/**
 * Wrap text to a maximum line length
 */
function wrapText(text: string, maxLength: number, indent: string = ''): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = indent;

  for (const word of words) {
    const testLine = currentLine + (currentLine === indent ? '' : ' ') + word;
    if (testLine.length <= maxLength) {
      currentLine = testLine;
    } else {
      if (currentLine !== indent) {
        lines.push(currentLine);
      }
      currentLine = indent + word;
    }
  }

  if (currentLine !== indent) {
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Format error context as human-readable string for console display
 *
 * @param context - Error context to format
 * @param options - Formatting options
 * @returns Formatted error message
 *
 * @example
 * ```typescript
 * const context = createErrorContext(error, { sessionId });
 * console.error(formatErrorForUser(context, { showStack: false }));
 * ```
 */
export function formatErrorForUser(
  context: ErrorContext,
  options: { showStack?: boolean; showSystem?: boolean } = {}
): string {
  const { showStack = false, showSystem = true } = options;

  const lines: string[] = [];

  // Error message (just the message, not the name) - wrapped at 100 chars
  const wrappedError = wrapText(context.error.message, 97, '   '); // 97 to account for "❌ " prefix
  lines.push(`❌ ${wrappedError[0].trim()}`);
  for (let i = 1; i < wrappedError.length; i++) {
    lines.push(wrappedError[i]);
  }

  // System info (for support/debugging)
  if (showSystem) {
    lines.push('');
    lines.push('System Information:');
    lines.push(`  • OS: ${context.system.platform} ${context.system.platformVersion} (${context.system.arch})`);
    lines.push(`  • Node.js: ${context.system.nodeVersion}`);
    lines.push(`  • CodeMie CLI: v${context.client.version}`);
  }

  // Session context (if available)
  if (context.session) {
    lines.push('');
    lines.push('Session Information:');
    if (context.session.sessionId) {
      lines.push(`  • Session ID: ${context.session.sessionId}`);
    }
    if (context.session.agent) {
      lines.push(`  • Agent: ${context.session.agent}`);
    }
    if (context.session.provider) {
      lines.push(`  • Provider: ${context.session.provider}`);
    }
    if (context.session.model) {
      lines.push(`  • Model: ${context.session.model}`);
    }
    if (context.session.profile) {
      lines.push(`  • Profile: ${context.session.profile}`);
    }
  }

  // Stack trace (for debugging)
  if (showStack && context.error.stack) {
    lines.push('');
    lines.push('Stack Trace:');
    lines.push(context.error.stack);
  }

  // Timestamp
  lines.push('');
  lines.push(`Timestamp: ${context.timestamp}`);

  return lines.join('\n');
}

/**
 * Format error context as JSON for logging to file
 *
 * @param context - Error context to format
 * @returns JSON string with full error details
 */
export function formatErrorForLog(context: ErrorContext): string {
  return JSON.stringify(context, null, 2);
}

/**
 * Create user-friendly explanation for common error types
 *
 * @param error - The error that occurred
 * @returns Human-readable explanation and suggested actions
 */
export function getErrorExplanation(error: unknown): {
  explanation: string;
  suggestions: string[];
} {
  const errorDetails = extractErrorDetails(error);
  const message = errorDetails.message.toLowerCase();
  const code = errorDetails.code?.toUpperCase();

  // File system errors - metrics specific context
  if (code === 'ENOENT') {
    return {
      explanation: 'Unable to access metrics storage directory. The agent will work, but you\'re missing important features: token usage tracking, cost monitoring, session history, and usage analytics. This limits your ability to optimize and monitor your AI usage.',
      suggestions: [
        'Without metrics: No token tracking, no usage insights, no session history',
        'To enable these features: Check if ~/.codemie/metrics/ directory exists',
        'Ensure you have proper file system permissions'
      ]
    };
  }

  if (code === 'EACCES' || code === 'EPERM') {
    return {
      explanation: 'Cannot write to metrics directory due to permissions. The agent will work, but important features are disabled: token tracking (you won\'t know your costs), usage analytics (can\'t optimize), and session history (can\'t review past work). We recommend fixing this.',
      suggestions: [
        'You\'re missing: Token/cost tracking, usage insights, session history',
        'To enable these features: Fix file permissions on ~/.codemie/ directory',
        'Run: chmod -R u+w ~/.codemie/ to restore access'
      ]
    };
  }

  if (code === 'ENOSPC') {
    return {
      explanation: 'Insufficient disk space for metrics storage. The agent will work, but critical features are unavailable: you cannot track token usage, monitor costs, view session history, or access usage insights until space is freed.',
      suggestions: [
        'You\'re missing: Token/cost tracking, usage insights, session history',
        'Free up disk space to enable these important features',
        'Clean up old log files: ~/.codemie/logs/ or other unnecessary files'
      ]
    };
  }

  // Network errors
  if (message.includes('timeout') || code === 'ETIMEDOUT') {
    return {
      explanation: 'Network timeout during metrics sync. The agent will work, but your usage data isn\'t being synced to the server. You\'ll lose visibility into token usage, costs, and session history across devices or for team analytics.',
      suggestions: [
        'You\'re missing: Cross-device sync, team analytics, historical usage data',
        'Check your internet connection to restore sync',
        'Local metrics will sync automatically when connection is restored'
      ]
    };
  }

  if (message.includes('econnrefused') || code === 'ECONNREFUSED') {
    return {
      explanation: 'Cannot connect to analytics server. The agent will work, but you\'re losing important tracking: no token usage monitoring, no cost tracking, no session history. You won\'t be able to optimize your AI usage or track expenses.',
      suggestions: [
        'You\'re missing: Token/cost tracking, session history, usage optimization',
        'Check if the analytics service is running and accessible',
        'Verify your network and firewall settings allow connections'
      ]
    };
  }

  // Metrics-specific errors
  if (message.includes('metric') || message.includes('session')) {
    return {
      explanation: 'Unable to store usage analytics. The agent will work, but you cannot track tokens, monitor costs, view session history, or access usage insights. This is a significant disadvantage for managing AI usage and expenses.',
      suggestions: [
        'You\'re missing: Token/cost tracking, usage insights, session history',
        'To enable these important features: Check ~/.codemie/metrics/ directory permissions',
        'These features help you optimize usage and control costs'
      ]
    };
  }

  // Generic error
  return {
    explanation: 'Metrics collection encountered an issue. The agent will work, but important features are unavailable: token tracking, cost monitoring, usage analytics, and session history. You won\'t be able to optimize your AI usage or track expenses.',
    suggestions: [
      'You\'re missing: Token/cost tracking, usage insights, session history',
      'These features are important for monitoring and optimizing AI usage',
      'See log details below for technical information to resolve this'
    ]
  };
}

/**
 * Format error with explanation for user display
 *
 * @param error - The error that occurred
 * @param sessionContext - Optional session context
 * @returns Formatted error message with explanation
 */
export function formatErrorWithExplanation(
  error: unknown,
  sessionContext?: ErrorContext['session']
): string {
  const context = createErrorContext(error, sessionContext);
  const { explanation, suggestions } = getErrorExplanation(error);

  const lines: string[] = [];

  // Explanation first (user-friendly) - wrapped at 100 chars
  const wrappedExplanation = wrapText(explanation, 97, '   '); // 97 to account for "💡 " prefix
  lines.push(`💡 ${wrappedExplanation[0].trim()}`);
  for (let i = 1; i < wrappedExplanation.length; i++) {
    lines.push(wrappedExplanation[i]);
  }
  lines.push('');

  // Technical error details
  lines.push(formatErrorForUser(context, { showStack: false, showSystem: true }));

  // Suggestions
  if (suggestions.length > 0) {
    lines.push('');
    lines.push('Suggested actions:');
    suggestions.forEach(suggestion => {
      // Wrap each suggestion at 100 chars, accounting for "  • " prefix
      const wrappedSuggestion = wrapText(suggestion, 96, '    '); // 96 to account for "  • " prefix
      lines.push(`  • ${wrappedSuggestion[0].trim()}`);
      for (let i = 1; i < wrappedSuggestion.length; i++) {
        lines.push(wrappedSuggestion[i]);
      }
    });
  }

  return lines.join('\n');
}
