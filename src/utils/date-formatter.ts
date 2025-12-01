/**
 * Date formatting utilities for analytics
 * Handles UTC to local timezone conversion for display
 */

/**
 * Get local date string from UTC date
 * Converts UTC date to user's local timezone and returns YYYY-MM-DD format
 *
 * @param utcDate - Date object or ISO string in UTC
 * @returns Local date string in YYYY-MM-DD format
 */
export function getLocalDateString(utcDate: Date | string = new Date()): string {
  const date = typeof utcDate === 'string' ? new Date(utcDate) : utcDate;

  // Get local date components
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/**
 * Get UTC date string from date
 * Returns YYYY-MM-DD format in UTC timezone (for file operations)
 *
 * @param date - Date object
 * @returns UTC date string in YYYY-MM-DD format
 */
export function getUTCDateString(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}

/**
 * Convert local date string to UTC date range
 * Takes a local date (YYYY-MM-DD) and returns the UTC date range that covers it
 *
 * @param localDate - Local date string in YYYY-MM-DD format
 * @returns Object with UTC start and end dates for the local day
 */
export function localDateToUTCRange(localDate: string): { start: Date; end: Date } {
  // Parse local date as local midnight
  const [year, month, day] = localDate.split('-').map(Number);
  const startOfDay = new Date(year, month - 1, day, 0, 0, 0, 0);
  const endOfDay = new Date(year, month - 1, day, 23, 59, 59, 999);

  return {
    start: startOfDay,
    end: endOfDay
  };
}

/**
 * Get local "today" date string
 * Returns today's date in local timezone as YYYY-MM-DD
 *
 * @returns Today's date in local timezone
 */
export function getLocalToday(): string {
  return getLocalDateString(new Date());
}

/**
 * Get UTC files needed for a local date
 * Returns array of UTC date strings (YYYY-MM-DD) that might contain events for the local date
 * Accounts for timezone offset potentially spanning two UTC dates
 *
 * @param localDate - Local date string in YYYY-MM-DD format
 * @returns Array of UTC date strings to check
 */
export function getUTCFilesForLocalDate(localDate: string): string[] {
  const { start, end } = localDateToUTCRange(localDate);

  const startUTC = getUTCDateString(start);
  const endUTC = getUTCDateString(end);

  // If timezone offset causes the local day to span two UTC dates, return both
  if (startUTC === endUTC) {
    return [startUTC];
  }

  return [startUTC, endUTC];
}

/**
 * Get default date range in local timezone
 * Returns last N days in local timezone
 *
 * @param days - Number of days to look back (default: 7)
 * @returns Object with from and to dates in local timezone
 */
export function getDefaultLocalDateRange(days: number = 7): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - days);

  return {
    from: getLocalDateString(from),
    to: getLocalDateString(today)
  };
}

/**
 * Format timestamp for display in local timezone
 * Converts UTC timestamp to local timezone string
 *
 * @param utcTimestamp - ISO timestamp string in UTC
 * @param includeTime - Include time in output (default: true)
 * @returns Formatted date/time string in local timezone
 */
export function formatLocalTimestamp(utcTimestamp: string, includeTime: boolean = true): string {
  const date = new Date(utcTimestamp);

  if (includeTime) {
    return date.toLocaleString();
  }

  return date.toLocaleDateString();
}

/**
 * Convert local date string to UTC dates for file reading
 * Determines which UTC date files to read for a given local date
 *
 * @param localDate - Local date string in YYYY-MM-DD format
 * @returns Array of UTC date strings in YYYY-MM-DD format
 */
export function localDateToUTCDates(localDate: string): string[] {
  return getUTCFilesForLocalDate(localDate);
}

/**
 * Get local date range that covers UTC date range
 * Expands UTC date range to ensure all local dates are covered
 *
 * @param utcFrom - UTC start date in YYYY-MM-DD format
 * @param utcTo - UTC end date in YYYY-MM-DD format
 * @returns Local date range
 */
export function expandUTCRangeToLocal(utcFrom: string, utcTo: string): { from: string; to: string } {
  // Parse UTC dates
  const fromDate = new Date(utcFrom + 'T00:00:00.000Z');
  const toDate = new Date(utcTo + 'T23:59:59.999Z');

  // Convert to local dates
  return {
    from: getLocalDateString(fromDate),
    to: getLocalDateString(toDate)
  };
}
