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
