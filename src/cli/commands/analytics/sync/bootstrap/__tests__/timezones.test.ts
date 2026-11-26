import { describe, expect, it } from 'vitest';

import { BootstrapInputError } from '../links.js';
import { DEFAULT_TIME_ZONE, resolveTimeZone, WINDOWS_TIME_ZONES } from '../timezones.js';

describe('WINDOWS_TIME_ZONES', () => {
  it("is CLDR's 139 Windows IDs, without duplicates", () => {
    expect(WINDOWS_TIME_ZONES.length).toBe(139);
    expect(new Set(WINDOWS_TIME_ZONES).size).toBe(139);
    for (const zone of ['UTC', 'FLE Standard Time', 'W. Europe Standard Time', 'Eastern Standard Time']) {
      expect(WINDOWS_TIME_ZONES).toContain(zone);
    }
  });
});

describe('resolveTimeZone', () => {
  it('Enter means UTC', () => {
    expect(DEFAULT_TIME_ZONE).toBe('UTC');
    expect(resolveTimeZone('')).toBe('UTC');
  });

  it('matches case-insensitively and returns the canonical spelling', () => {
    expect(resolveTimeZone(' w. europe standard time ')).toBe('W. Europe Standard Time');
  });

  it('passes a well-known named zone verbatim', () => {
    expect(resolveTimeZone('Pacific Standard Time')).toBe('Pacific Standard Time');
  });

  it('suggests close names for a partial one', () => {
    try {
      resolveTimeZone('europe');
      throw new Error('expected resolveTimeZone to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(BootstrapInputError);
      expect((error as Error).message).toMatch(/Did you mean/);
      expect((error as Error).message).toMatch(/W\. Europe Standard Time/);
    }
  });

  it('rejects an unknown zone name outright', () => {
    expect(() => resolveTimeZone('Mars')).toThrow(BootstrapInputError);
  });

  it('explains that IANA names are not what Power Automate takes', () => {
    expect(() => resolveTimeZone('Europe/Kyiv')).toThrow(/IANA/);
  });
});
