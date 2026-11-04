const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** True when the value has the YYYY-MM-DD shape (valid calendar date or not). */
export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value);
}

/**
 * Parse a YYYY-MM-DD filter value in UTC. 'from' = 00:00:00.000Z, 'to' = 23:59:59.999Z (inclusive).
 * Returns null for bad shape or impossible calendar dates (no month rollover).
 */
export function parseDateOnly(value: string, bound: 'from' | 'to'): Date | null {
  if (!DATE_ONLY.test(value)) return null;
  const start = new Date(value);
  if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== value) return null;
  return bound === 'from' ? start : new Date(start.getTime() + 86_400_000 - 1);
}
