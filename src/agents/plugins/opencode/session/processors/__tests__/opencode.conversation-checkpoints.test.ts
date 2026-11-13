/**
 * getPriorRunsCheckpoint: the watermark of the session's events before the record's start.
 */
import { describe, it, expect } from 'vitest';
import { getPriorRunsCheckpoint } from '../opencode.conversation-checkpoints.js';

describe('getPriorRunsCheckpoint', () => {
  it('an event whose date does not parse is no earlier run\'s event', () => {
    const startTime = Date.parse('2026-10-01T10:00:00Z');
    const events = [
      { kind: 'user_prompt', sourceIndex: 0, date: '2026-10-01T09:00:00Z' },
      { kind: 'user_prompt', sourceIndex: 1, date: 'n/a' },
      { kind: 'user_prompt', sourceIndex: 2, date: '2026-10-01T10:05:00Z' },
    ];

    expect(getPriorRunsCheckpoint(events, startTime)).toEqual({ sourceIndex: 0, historyIndex: 0 });
  });
});
