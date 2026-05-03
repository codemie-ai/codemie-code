import { describe, it, expect } from 'vitest';
import { findKneedle, boostErrors } from '../compressors/search-compressor.js';

describe('findKneedle', () => {
  it('returns 1 for a flat score array', () => {
    const scores = [0.9, 0.9, 0.9, 0.9, 0.9];
    expect(findKneedle(scores)).toBe(1);
  });

  it('finds the elbow in a typical score curve', () => {
    const scores = [1.0, 0.95, 0.90, 0.3, 0.1, 0.05];
    const k = findKneedle(scores);
    expect(k).toBeGreaterThanOrEqual(2);
    expect(k).toBeLessThanOrEqual(4);
  });

  it('returns at least 1', () => {
    expect(findKneedle([0.5])).toBeGreaterThanOrEqual(1);
  });

  it('returns at most scores.length', () => {
    const scores = [1.0, 0.9, 0.8];
    expect(findKneedle(scores)).toBeLessThanOrEqual(3);
  });
});

describe('boostErrors', () => {
  it('adds bonus weight to lines containing error keywords', () => {
    const lines = [
      { content: 'INFO: all good', score: 0.5 },
      { content: 'ERROR: connection failed', score: 0.5 },
    ];
    const boosted = boostErrors(lines);
    expect(boosted[1].score).toBeGreaterThan(boosted[0].score);
  });

  it('does not modify lines without error keywords', () => {
    const lines = [{ content: 'normal log line', score: 0.3 }];
    const boosted = boostErrors(lines);
    expect(boosted[0].score).toBe(0.3);
  });
});
