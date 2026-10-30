/**
 * Date and duration argument parsing shared by the analytics command and `analytics sync`.
 */

/**
 * Parse date string (YYYY-MM-DD) to Date object
 */
export function parseDate(dateStr: string): Date | null {
  // Enforce the documented YYYY-MM-DD shape. Without this, `new Date()` accepts ambiguous
  // inputs (MM/DD/YYYY, prose dates) with format-dependent timezone handling, silently
  // producing a wrong filter window instead of triggering the caller's "invalid date" warning.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return null;
  }
  const date = new Date(dateStr);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Parse duration string (e.g., "7d", "24h") to milliseconds
 */
export function parseDuration(durationStr: string): number | null {
  const match = durationStr.match(/^(\d+)([dhm])$/);
  if (!match) {
    return null;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'm':
      return value * 60 * 1000;
    default:
      return null;
  }
}
