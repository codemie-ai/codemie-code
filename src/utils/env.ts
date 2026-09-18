/**
 * Environment variable parsing helpers.
 */

/**
 * Parse a boolean-ish environment variable value.
 *
 * Unset or empty (`undefined`, `null`, `''`) yields the default; otherwise the
 * lowercased, trimmed value must be 'true', '1', or 'yes' to count as enabled —
 * everything else (e.g. 'false', '0', 'no') disables.
 */
export function parseBooleanEnv(raw: string | undefined | null, defaultValue: boolean): boolean {
  if (raw === undefined || raw === null || raw === '') {
    return defaultValue;
  }

  const normalized = raw.toLowerCase().trim();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}
