/**
 * Proxy Error Hierarchy
 *
 * Simple error classes for different failure scenarios.
 * KISS principle: Only essential error types needed for debugging.
 */

/**
 * Base class for all proxy errors
 */
export class ProxyError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ProxyError';
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON(): Record<string, unknown> {
    return {
      type: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      ...this.details
    };
  }
}

/**
 * Authentication/Authorization errors (401)
 */
export class AuthenticationError extends ProxyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 401, 'AUTH_FAILED', details);
    this.name = 'AuthenticationError';
  }
}

/**
 * Network connection errors (502)
 */
export class NetworkError extends ProxyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 502, 'NETWORK_ERROR', details);
    this.name = 'NetworkError';
  }
}

/**
 * Request timeout errors (504)
 */
export class TimeoutError extends ProxyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 504, 'TIMEOUT', details);
    this.name = 'TimeoutError';
  }
}

/**
 * Upstream API errors (preserves status code)
 */
export class UpstreamError extends ProxyError {
  constructor(statusCode: number, message: string, details?: Record<string, unknown>) {
    super(message, statusCode, 'UPSTREAM_ERROR', details);
    this.name = 'UpstreamError';
  }
}

/**
 * Convert unknown errors to ProxyError
 */
export function normalizeError(error: unknown, context?: Record<string, unknown>): ProxyError {
  if (error instanceof ProxyError) {
    return error;
  }

  if (error instanceof Error) {
    // Network errors
    if ('code' in error) {
      const code = (error as any).code;

      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET') {
        return new NetworkError(`Cannot connect to upstream server: ${error.message}`, {
          originalError: error.message,
          errorCode: code,
          ...context
        });
      }

      if (code === 'ETIMEDOUT' || error.message.includes('timeout')) {
        return new TimeoutError(`Request timeout: ${error.message}`, {
          originalError: error.message,
          errorCode: code,
          ...context
        });
      }
    }

    // Generic error
    return new ProxyError(
      error.message,
      500,
      'INTERNAL_ERROR',
      {
        originalError: error.message,
        ...context
      }
    );
  }

  // Unknown error type
  return new ProxyError(
    String(error),
    500,
    'UNKNOWN_ERROR',
    { originalError: String(error), ...context }
  );
}
