import { describe, expect, it } from 'vitest';

import { dailyWindow } from '../window.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('dailyWindow', () => {
  it('spans lookbackDays when there is no marker', () => {
    const now = new Date('2026-10-29T00:00:00.000Z');
    const window = dailyWindow(now, null, 7);

    expect(window.to).toEqual(now);
    expect(window.from).toEqual(new Date(now.getTime() - 7 * DAY_MS));
  });

  it('spans lookbackDays when the marker is more recent than the lookback window', () => {
    const now = new Date('2026-10-29T00:00:00.000Z');
    const lastSent = new Date(now.getTime() - 2 * DAY_MS);
    const window = dailyWindow(now, lastSent, 7);

    expect(window.from).toEqual(new Date(now.getTime() - 7 * DAY_MS));
  });

  it('spans marker age plus a 1 hour safety margin when the marker is older than the lookback window', () => {
    const now = new Date('2026-10-29T00:00:00.000Z');
    const lastSent = new Date(now.getTime() - 10 * DAY_MS);
    const window = dailyWindow(now, lastSent, 7);

    expect(window.from).toEqual(new Date(now.getTime() - 10 * DAY_MS - HOUR_MS));
  });

  it('labels the window YYYY-MM-DD-to-YYYY-MM-DD in UTC', () => {
    const now = new Date('2026-10-29T00:00:00.000Z');
    const window = dailyWindow(now, null, 7);

    expect(window.label).toBe('2026-10-22-to-2026-10-29');
  });
});
