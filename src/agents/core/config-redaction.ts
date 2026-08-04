const SECRET_KEY_PATTERN = /api[-_]?key|private[-_]?key|token|secret|password|credentials?|authorization/i;

/**
 * Recursively redacts values whose object key matches a secret-like name
 * (apiKey, token, secret, authorization — case-insensitive), at any depth.
 * Does not mutate the input.
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SECRET_KEY_PATTERN.test(key) ? '***REDACTED***' : redactSecrets(val);
    }
    return result;
  }

  return value;
}
