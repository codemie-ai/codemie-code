import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isDateOnly, parseDateOnly, parseFilterDate } from '../date-filter.js';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

describe.each(['UTC', 'America/New_York'])('parseDateOnly under TZ=%s', (tz) => {
  let savedTz: string | undefined;

  beforeEach(() => {
    savedTz = process.env.TZ;
    process.env.TZ = tz;
  });

  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it("'from' is start of the UTC day", () => {
    expect(iso(parseDateOnly('2026-10-25', 'from'))).toBe('2026-10-25T00:00:00.000Z');
  });

  it("'to' is the last millisecond of the UTC day: 23:59 included, next-day 00:00 excluded", () => {
    const to = parseDateOnly('2026-10-25', 'to')!;
    expect(iso(to)).toBe('2026-10-25T23:59:59.999Z');
    expect(Date.parse('2026-10-25T23:59:00.000Z')).toBeLessThanOrEqual(to.getTime());
    expect(Date.parse('2026-10-26T00:00:00.000Z')).toBeGreaterThan(to.getTime());
  });

  it.each(['10/25/2026', '2026-13-40', '2026-02-30', '2026-02-31', '2025-02-29', '2026-10-25T10:00:00Z'])(
    'rejects %s',
    (value) => {
      expect(parseDateOnly(value, 'from')).toBeNull();
      expect(parseDateOnly(value, 'to')).toBeNull();
    }
  );

  it('accepts a leap day for both bounds', () => {
    expect(iso(parseDateOnly('2028-02-29', 'from'))).toBe('2028-02-29T00:00:00.000Z');
    expect(iso(parseDateOnly('2028-02-29', 'to'))).toBe('2028-02-29T23:59:59.999Z');
  });
});

describe('isDateOnly', () => {
  it('checks shape only', () => {
    expect(isDateOnly('2026-02-30')).toBe(true);
    expect(isDateOnly('2026-10-25T10:00:00Z')).toBe(false);
  });
});

describe.each(['UTC', 'America/New_York'])('parseFilterDate under TZ=%s', (tz) => {
  let savedTz: string | undefined;

  beforeEach(() => {
    savedTz = process.env.TZ;
    process.env.TZ = tz;
  });

  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it('date-only uses the UTC day bounds', () => {
    expect(iso(parseFilterDate('2026-10-25', 'from'))).toBe('2026-10-25T00:00:00.000Z');
    expect(iso(parseFilterDate('2026-10-25', 'to'))).toBe('2026-10-25T23:59:59.999Z');
  });

  it('a timestamp with Z or an offset is an exact instant, not widened to end of day', () => {
    expect(iso(parseFilterDate('2026-10-25T10:00:00Z', 'to'))).toBe('2026-10-25T10:00:00.000Z');
    expect(iso(parseFilterDate('2026-10-25T10:00:00+02:00', 'to'))).toBe('2026-10-25T08:00:00.000Z');
  });

  it('a timestamp without a timezone is local time', () => {
    const expected = new Date(2026, 9, 25, 10, 0, 0).toISOString();
    expect(iso(parseFilterDate('2026-10-25T10:00', 'from'))).toBe(expected);
  });

  it.each(['10/25/2026', 'Oct 25 2026', '2026-02-30', '2026-10-25T99:00', '2026-10-25T10:00 junk', ''])(
    'rejects %s',
    (value) => {
      expect(parseFilterDate(value, 'from')).toBeNull();
      expect(parseFilterDate(value, 'to')).toBeNull();
    }
  );
});
