/**
 * Sanitization utilities for preventing sensitive data exposure in logs
 */

/**
 * Patterns to identify sensitive keys in objects
 */
const SENSITIVE_KEY_PATTERNS = [
  /api[_-]?key/i,
  /auth[_-]?token/i,
  /access[_-]?token/i,
  /refresh[_-]?token/i,
  /bearer[_-]?token/i,
  /password/i,
  /secret/i,
  /credential/i,
  /private[_-]?key/i,
  /session[_-]?id/i,
  /cookie/i,
  /authorization/i
];

/**
 * Patterns to identify sensitive values (even if key name is not sensitive)
 */
const SENSITIVE_VALUE_PATTERNS = [
  /^sk-[a-zA-Z0-9]{20,}$/, // OpenAI API keys
  /^sk-ant-[a-zA-Z0-9-_]{95,}$/, // Anthropic API keys
  /^ya29\.[a-zA-Z0-9-_]{100,}$/, // Google OAuth tokens
  /^[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]{20,}$/, // JWT tokens
  /^Bearer\s+[A-Za-z0-9-_.+/=]{20,}$/i, // Bearer tokens
];

/**
 * Check if a key name indicates sensitive data
 */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some(pattern => pattern.test(key));
}

/**
 * Check if a value looks like sensitive data
 */
function isSensitiveValue(value: string): boolean {
  if (value.length < 20) return false; // Short strings unlikely to be secrets
  return SENSITIVE_VALUE_PATTERNS.some(pattern => pattern.test(value));
}

/**
 * Mask a sensitive string, showing only first and last few characters
 */
function maskString(value: string, showChars = 4): string {
  if (value.length <= showChars * 2) {
    return '[REDACTED]';
  }
  return `${value.slice(0, showChars)}...${value.slice(-showChars)} [REDACTED]`;
}

/**
 * Sanitize a value for logging
 */
export function sanitizeValue(value: unknown, key?: string): unknown {
  // Handle null/undefined
  if (value === null || value === undefined) {
    return value;
  }

  // Check if key name is sensitive
  if (key && isSensitiveKey(key)) {
    if (typeof value === 'string') {
      return maskString(value);
    }
    if (typeof value === 'object') {
      return '[REDACTED OBJECT]';
    }
    return '[REDACTED]';
  }

  // Handle strings
  if (typeof value === 'string') {
    if (isSensitiveValue(value)) {
      return maskString(value);
    }
    return value;
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value.map(item => sanitizeValue(item));
  }

  // Handle objects
  if (typeof value === 'object') {
    return sanitizeObject(value as Record<string, unknown>);
  }

  // Handle primitives (numbers, booleans, etc.)
  return value;
}

/**
 * Sanitize an object for logging
 */
export function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    sanitized[key] = sanitizeValue(value, key);
  }

  return sanitized;
}

/**
 * Sanitize cookie object - only show cookie names and count
 */
export function sanitizeCookies(cookies: Record<string, string> | undefined): string {
  if (!cookies || typeof cookies !== 'object') {
    return 'none';
  }

  const names = Object.keys(cookies);
  if (names.length === 0) {
    return 'none';
  }

  return `${names.length} cookie(s): ${names.join(', ')} [values redacted]`;
}

/**
 * Sanitize authentication token - only show type and prefix
 */
export function sanitizeAuthToken(token: string | undefined): string {
  if (!token) {
    return 'none';
  }

  if (token === 'sso-authenticated') {
    return 'sso-authenticated (placeholder)';
  }

  // Show only prefix for real tokens
  if (token.length > 8) {
    return `${token.slice(0, 8)}... [${token.length} chars, redacted]`;
  }

  return '[REDACTED]';
}

/**
 * Sanitize HTTP headers - special handling for cookie and set-cookie headers
 */
export function sanitizeHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!headers || typeof headers !== 'object') {
    return {};
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();

    // Special handling for cookie headers
    if (lowerKey === 'cookie') {
      if (typeof value === 'string') {
        // Parse cookie string and show names only
        const cookieNames = value.split(';')
          .map(c => c.trim().split('=')[0])
          .filter(Boolean);
        sanitized[key] = `${cookieNames.length} cookie(s): ${cookieNames.join(', ')} [values redacted]`;
      } else {
        sanitized[key] = '[REDACTED]';
      }
    }
    // Special handling for set-cookie headers (array of strings)
    else if (lowerKey === 'set-cookie') {
      if (Array.isArray(value)) {
        const cookieNames = value.map(cookie => {
          const name = cookie.split('=')[0].trim();
          return name;
        });
        sanitized[key] = `Setting ${cookieNames.length} cookie(s): ${cookieNames.join(', ')} [values redacted]`;
      } else if (typeof value === 'string') {
        const name = value.split('=')[0].trim();
        sanitized[key] = `Setting cookie: ${name} [value redacted]`;
      } else {
        sanitized[key] = '[REDACTED]';
      }
    }
    // Special handling for authorization header
    else if (lowerKey === 'authorization') {
      if (typeof value === 'string') {
        const parts = value.split(' ');
        if (parts.length === 2) {
          sanitized[key] = `${parts[0]} [token redacted]`;
        } else {
          sanitized[key] = '[REDACTED]';
        }
      } else {
        sanitized[key] = '[REDACTED]';
      }
    }
    // Other sensitive headers
    else if (isSensitiveKey(key)) {
      sanitized[key] = '[REDACTED]';
    }
    // Non-sensitive headers pass through
    else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Sanitize log arguments before writing to console or file
 */
export function sanitizeLogArgs(...args: unknown[]): unknown[] {
  return args.map(arg => {
    if (typeof arg === 'string') {
      // Check if string looks like sensitive data
      if (isSensitiveValue(arg)) {
        return maskString(arg);
      }
      return arg;
    }

    if (typeof arg === 'object' && arg !== null) {
      return sanitizeValue(arg);
    }

    return arg;
  });
}
