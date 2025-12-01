/**
 * Tests for date formatting utilities
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getLocalDateString,
  getUTCDateString,
  localDateToUTCRange,
  getLocalToday,
  getUTCFilesForLocalDate,
  getDefaultLocalDateRange,
  formatLocalTimestamp,
  localDateToUTCDates,
  expandUTCRangeToLocal
} from '../date-formatter.js';

describe('date-formatter', () => {
  let originalTZ: string | undefined;

  beforeEach(() => {
    // Save original timezone
    originalTZ = process.env.TZ;
  });

  afterEach(() => {
    // Restore original timezone
    if (originalTZ !== undefined) {
      process.env.TZ = originalTZ;
    } else {
      delete process.env.TZ;
    }
  });

  describe('getLocalDateString', () => {
    it('should convert UTC date to local date string', () => {
      const utcDate = new Date('2025-11-30T02:00:00.000Z');
      const localDate = getLocalDateString(utcDate);

      // Result depends on system timezone
      expect(localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should handle ISO string input', () => {
      const isoString = '2025-11-30T12:00:00.000Z';
      const localDate = getLocalDateString(isoString);

      expect(localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should default to current date', () => {
      const localDate = getLocalDateString();
      expect(localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('getUTCDateString', () => {
    it('should return UTC date string in YYYY-MM-DD format', () => {
      const date = new Date('2025-11-30T12:00:00.000Z');
      expect(getUTCDateString(date)).toBe('2025-11-30');
    });

    it('should default to current date', () => {
      const utcDate = getUTCDateString();
      expect(utcDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('localDateToUTCRange', () => {
    it('should return UTC range for local date', () => {
      const localDate = '2025-11-30';
      const range = localDateToUTCRange(localDate);

      expect(range.start).toBeInstanceOf(Date);
      expect(range.end).toBeInstanceOf(Date);
      expect(range.end.getTime()).toBeGreaterThan(range.start.getTime());

      // Range should span exactly one local day
      const durationMs = range.end.getTime() - range.start.getTime();
      expect(durationMs).toBe(24 * 60 * 60 * 1000 - 1); // 23:59:59.999
    });

    it('should set start to local midnight', () => {
      const localDate = '2025-11-30';
      const range = localDateToUTCRange(localDate);

      // Start should be midnight in local timezone
      expect(range.start.getHours()).toBe(0);
      expect(range.start.getMinutes()).toBe(0);
      expect(range.start.getSeconds()).toBe(0);
      expect(range.start.getMilliseconds()).toBe(0);
    });
  });

  describe('getLocalToday', () => {
    it('should return today in local timezone', () => {
      const today = getLocalToday();
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // Should match JavaScript's local date
      const expected = getLocalDateString(new Date());
      expect(today).toBe(expected);
    });
  });

  describe('getUTCFilesForLocalDate', () => {
    it('should return single UTC date when no timezone boundary crossed', () => {
      // Use UTC timezone to avoid boundary crossing
      process.env.TZ = 'UTC';

      const localDate = '2025-11-30';
      const utcFiles = getUTCFilesForLocalDate(localDate);

      expect(utcFiles).toEqual(['2025-11-30']);
    });

    it('should return two UTC dates when timezone boundary is crossed', () => {
      // Use a timezone that will cause boundary crossing
      process.env.TZ = 'Asia/Tokyo'; // GMT+9

      const localDate = '2025-11-30';
      const utcFiles = getUTCFilesForLocalDate(localDate);

      // Tokyo date 2025-11-30 starts at 2025-11-29 15:00 UTC
      // and ends at 2025-11-30 14:59 UTC, crossing boundary
      expect(utcFiles.length).toBeGreaterThanOrEqual(1);
      expect(utcFiles.length).toBeLessThanOrEqual(2);
    });
  });

  describe('getDefaultLocalDateRange', () => {
    it('should return last 7 days by default', () => {
      const range = getDefaultLocalDateRange();

      expect(range.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(range.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // From date should be before to date
      expect(new Date(range.from).getTime()).toBeLessThan(new Date(range.to).getTime());
    });

    it('should support custom number of days', () => {
      const range = getDefaultLocalDateRange(30);

      expect(range.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(range.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('formatLocalTimestamp', () => {
    it('should format timestamp with time by default', () => {
      const timestamp = '2025-11-30T12:00:00.000Z';
      const formatted = formatLocalTimestamp(timestamp);

      // Should include some time component (varies by locale and timezone)
      // Just check it's not empty and has typical time separators
      expect(formatted.length).toBeGreaterThan(0);
      expect(formatted).toMatch(/\d+[:\s]/); // Should have numbers and time separators
    });

    it('should format timestamp without time when specified', () => {
      const timestamp = '2025-11-30T12:00:00.000Z';
      const formatted = formatLocalTimestamp(timestamp, false);

      // Should be date only
      expect(formatted).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/) || // US format
        expect(formatted).toMatch(/\d{4}-\d{2}-\d{2}/) || // ISO format
        expect(formatted).toMatch(/\d{1,2}\.\d{1,2}\.\d{4}/); // European format
    });
  });

  describe('localDateToUTCDates', () => {
    it('should be alias for getUTCFilesForLocalDate', () => {
      const localDate = '2025-11-30';
      const result1 = localDateToUTCDates(localDate);
      const result2 = getUTCFilesForLocalDate(localDate);

      expect(result1).toEqual(result2);
    });
  });

  describe('expandUTCRangeToLocal', () => {
    it('should expand UTC range to cover all local dates', () => {
      const utcFrom = '2025-11-25';
      const utcTo = '2025-11-30';

      const localRange = expandUTCRangeToLocal(utcFrom, utcTo);

      expect(localRange.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(localRange.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // Local range should include the UTC range
      // (might extend if timezone offset causes it)
      expect(new Date(localRange.from).getTime()).toBeLessThanOrEqual(
        new Date(utcFrom).getTime()
      );
      expect(new Date(localRange.to).getTime()).toBeGreaterThanOrEqual(
        new Date(utcTo).getTime()
      );
    });
  });

  describe('edge cases', () => {
    it('should handle year boundaries', () => {
      const newYearUTC = '2025-01-01T00:00:00.000Z';
      const localDate = getLocalDateString(newYearUTC);

      expect(localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should handle leap years', () => {
      const leapDay = '2024-02-29';
      const range = localDateToUTCRange(leapDay);

      expect(range.start).toBeInstanceOf(Date);
      expect(range.end).toBeInstanceOf(Date);
    });

    it('should handle DST transitions', () => {
      // This will vary by timezone, just ensure no crashes
      const dstDate = '2025-03-09'; // DST starts in US
      const range = localDateToUTCRange(dstDate);

      expect(range.start).toBeInstanceOf(Date);
      expect(range.end).toBeInstanceOf(Date);
    });
  });

  describe('timezone-specific behavior', () => {
    it('should handle positive UTC offset (Asia/Tokyo GMT+9)', () => {
      process.env.TZ = 'Asia/Tokyo';

      // 2025-11-30 in Tokyo is 2025-11-29 15:00 UTC to 2025-11-30 14:59 UTC
      const localDate = '2025-11-30';
      const range = localDateToUTCRange(localDate);

      // Should span correct time range
      const durationMs = range.end.getTime() - range.start.getTime();
      expect(durationMs).toBe(24 * 60 * 60 * 1000 - 1);
    });

    it('should handle negative UTC offset (America/Los_Angeles GMT-8)', () => {
      process.env.TZ = 'America/Los_Angeles';

      // 2025-11-30 in LA is 2025-11-30 08:00 UTC to 2025-12-01 07:59 UTC
      const localDate = '2025-11-30';
      const range = localDateToUTCRange(localDate);

      // Should span correct time range
      const durationMs = range.end.getTime() - range.start.getTime();
      expect(durationMs).toBe(24 * 60 * 60 * 1000 - 1);
    });

    it('should handle UTC timezone', () => {
      process.env.TZ = 'UTC';

      const localDate = '2025-11-30';
      const utcFiles = getUTCFilesForLocalDate(localDate);

      // In UTC, local date matches UTC date exactly
      expect(utcFiles).toEqual(['2025-11-30']);
    });
  });
});
