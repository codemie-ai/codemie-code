/**
 * CODEMIE_PROFILE_MODELS narrowing of Pi's live model entries
 * (src/agents/plugins/pi/pi.models.ts: filterEntriesToProfile).
 *
 * fetchAndBuildPiModels() calls this pure helper against the live-catalogue
 * entries (post isCodexCompatibleModel-equivalent enabled-filter + conversion)
 * before writing them to models.json. Keeps the configured env.CODEMIE_MODEL
 * even when it is missing from the allowed CSV, and falls back to the
 * unfiltered list on an empty intersection (AC22).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import { filterEntriesToProfile, type PiModelEntry } from '../pi.models.js';
import { logger } from '@/utils/logger.js';

function entry(id: string): PiModelEntry {
  return { id, name: id, input: ['text'], contextWindow: 1000, maxTokens: 100 };
}

describe('filterEntriesToProfile', () => {
  const entries: PiModelEntry[] = [entry('a'), entry('b'), entry('c')];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps only entries whose id is in CODEMIE_PROFILE_MODELS', () => {
    const result = filterEntriesToProfile(entries, { CODEMIE_PROFILE_MODELS: 'a,b' });
    expect(result.map(e => e.id).sort()).toEqual(['a', 'b']);
  });

  it('returns the unfiltered list when CODEMIE_PROFILE_MODELS is unset', () => {
    const result = filterEntriesToProfile(entries, {});
    expect(result.map(e => e.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('keeps the configured CODEMIE_MODEL even when missing from the allowed list', () => {
    const result = filterEntriesToProfile(entries, { CODEMIE_PROFILE_MODELS: 'b', CODEMIE_MODEL: 'c' });
    expect(result.map(e => e.id).sort()).toEqual(['b', 'c']);
  });

  it('falls back to the unfiltered list and warns when the intersection is empty (AC22)', () => {
    const result = filterEntriesToProfile(entries, { CODEMIE_PROFILE_MODELS: 'z,y' });
    expect(result.map(e => e.id).sort()).toEqual(['a', 'b', 'c']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
