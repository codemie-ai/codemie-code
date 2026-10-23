/**
 * Unit tests for resolveProfileModels (src/utils/config.ts).
 *
 * resolveProfileModels normalizes a profile's model list at read time: a
 * missing `models` field is treated as `[model]`, so every consumer sees a
 * normalized array without a config migration.
 */

import { describe, it, expect } from 'vitest';
import { resolveProfileModels } from '../config.js';

describe('resolveProfileModels', () => {
  it('returns models when present, ignoring model', () => {
    expect(resolveProfileModels({ model: 'a', models: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('falls back to [model] when models is missing', () => {
    expect(resolveProfileModels({ model: 'a' })).toEqual(['a']);
  });

  it('returns an empty array when neither model nor models is set', () => {
    expect(resolveProfileModels({})).toEqual([]);
  });
});
