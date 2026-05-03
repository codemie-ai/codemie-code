import { describe, it, expect } from 'vitest';
import { ContextStrategy, scoreMessage, buildDropCandidates } from '../transforms/icm.js';
import type { ICMMessage } from '../transforms/icm.js';

describe('ContextStrategy', () => {
  it('exports NONE, COMPRESS_FIRST, DROP_BY_SCORE values', () => {
    expect(ContextStrategy.NONE).toBe('none');
    expect(ContextStrategy.COMPRESS_FIRST).toBe('compress');
    expect(ContextStrategy.DROP_BY_SCORE).toBe('drop_scored');
  });
});

describe('scoreMessage', () => {
  it('gives newer messages higher recency scores', () => {
    const msgs: ICMMessage[] = [
      { role: 'user', content: 'first old message' },
      { role: 'user', content: 'second message' },
      { role: 'user', content: 'third recent message' },
    ];
    const scores = msgs.map((msg, idx) => scoreMessage(msg, idx, msgs.length));
    expect(scores[2].total).toBeGreaterThan(scores[0].total);
  });

  it('boosts messages containing error keywords', () => {
    const errorMsg: ICMMessage = { role: 'user', content: 'FATAL: database connection error stack trace' };
    const normalMsg: ICMMessage = { role: 'user', content: 'User clicked the button' };
    const errorScore = scoreMessage(errorMsg, 0, 2);
    const normalScore = scoreMessage(normalMsg, 0, 2);
    expect(errorScore.total).toBeGreaterThan(normalScore.total);
  });

  it('never returns a negative score', () => {
    const msg: ICMMessage = { role: 'user', content: 'abc' };
    const score = scoreMessage(msg, 0, 1);
    expect(score.total).toBeGreaterThanOrEqual(0);
  });
});

describe('buildDropCandidates', () => {
  it('returns candidates sorted by score ascending (lowest first to drop first)', () => {
    const msgs: ICMMessage[] = [
      { role: 'user', content: 'error: fatal crash' },     // index 0, low total (0 recency, 0.5 error → 0.15)
      { role: 'assistant', content: 'hi there' },           // index 1, low score
      { role: 'user', content: 'another message here' },    // index 2, medium score
    ];
    const protected_ = new Set<number>([]);
    const candidates = buildDropCandidates(msgs, protected_);
    // All candidates in ascending score order
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i].score).toBeGreaterThanOrEqual(candidates[i - 1].score);
    }
  });

  it('excludes protected indices from candidates', () => {
    const msgs: ICMMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user message' },
    ];
    const protected_ = new Set<number>([0]);
    const candidates = buildDropCandidates(msgs, protected_);
    expect(candidates.every(c => !c.indices.includes(0))).toBe(true);
  });
});
