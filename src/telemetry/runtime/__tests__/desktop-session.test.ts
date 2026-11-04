/**
 * hasActivityAfter boundary tests
 * @group unit
 */
import { describe, it, expect } from 'vitest';
import type { Session } from '@/agents/core/session/types.js';
import { hasActivityAfter } from '../desktop-session.js';

function record(lastSeenActivityAt?: number, endTime?: number): Session {
  return {
    sessionId: 's-1',
    ...(lastSeenActivityAt === undefined ? {} : { runtimeCheckpoint: { lastSeenActivityAt } }),
    ...(endTime === undefined ? {} : { endTime })
  } as Session;
}

describe('hasActivityAfter', () => {
  it.each([
    { name: 'equal to the end, later than the activity', activity: 100, end: 200, updatedAt: 200, expected: false },
    { name: 'above the activity, below a later end', activity: 100, end: 200, updatedAt: 150, expected: false },
    { name: 'above both, the end later', activity: 100, end: 200, updatedAt: 201, expected: true },
    { name: 'equal to the activity, later than the end', activity: 300, end: 200, updatedAt: 300, expected: false },
    { name: 'above the end, below a later activity', activity: 300, end: 200, updatedAt: 250, expected: false },
    { name: 'above both, the activity later', activity: 300, end: 200, updatedAt: 301, expected: true },
    { name: 'a record with neither', activity: undefined, end: undefined, updatedAt: 1, expected: true }
  ])('$name: $expected', ({ activity, end, updatedAt, expected }) => {
    expect(hasActivityAfter(record(activity, end), updatedAt)).toBe(expected);
  });
});
