/**
 * Privacy utilities for analytics
 * Handles sensitive data redaction
 */

/**
 * Redact sensitive data from parameters
 * Removes API keys, tokens, passwords, secrets
 */
export function redactSensitive(
  params: Record<string, unknown>
): Record<string, unknown> {
  const sensitive = ['apikey', 'api_key', 'token', 'password', 'secret', 'auth'];
  const result = { ...params };

  for (const key of Object.keys(result)) {
    const lowerKey = key.toLowerCase();
    if (sensitive.some((s) => lowerKey.includes(s))) {
      result[key] = '[REDACTED]';
    }
  }

  return result;
}
