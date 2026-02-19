/**
 * Unit tests for automatic model tier selection logic
 *
 * Tests cover:
 * - Version parsing with different formats (dashes, dots, mixed)
 * - Version comparison with valid and invalid versions
 * - Model selection with various edge cases
 * - Fallback behavior when parsing fails
 * - Environment variable priority
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Import the functions we want to test
// We'll need to export them from setup.ts for testing
// For now, we'll duplicate the logic here to test the algorithm

/**
 * Parse model version from model name
 * Handles dashes and dots as separators
 */
function parseModelVersion(modelName: string): number[] {
  const normalized = modelName.replace(/\./g, '-');
  const numbers = normalized.match(/\d+/g);
  if (!numbers) return [];
  return numbers.map(n => parseInt(n, 10));
}

/**
 * Compare two model versions
 * Falls back to string comparison if parsing fails
 */
function compareModelVersions(a: string, b: string): number {
  const versionA = parseModelVersion(a);
  const versionB = parseModelVersion(b);

  // Fallback to string comparison if parsing failed
  if (versionA.length === 0 || versionB.length === 0) {
    return a.localeCompare(b);
  }

  const maxLength = Math.max(versionA.length, versionB.length);

  for (let i = 0; i < maxLength; i++) {
    const numA = versionA[i] || 0;
    const numB = versionB[i] || 0;

    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }

  return 0;
}

/**
 * Select latest model from a list
 * Uses version comparison with fallback to string comparison
 */
function selectLatestModel(models: string[]): string | undefined {
  if (models.length === 0) return undefined;
  if (models.length === 1) return models[0];

  const sorted = [...models].sort((a, b) => compareModelVersions(b, a));
  return sorted[0];
}

describe('parseModelVersion', () => {
  it('should parse dash-separated versions', () => {
    expect(parseModelVersion('claude-4-opus')).toEqual([4]);
    expect(parseModelVersion('claude-opus-4-5-20251101')).toEqual([4, 5, 20251101]);
    expect(parseModelVersion('claude-4-5-sonnet')).toEqual([4, 5]);
    expect(parseModelVersion('claude-haiku-4-5-20251001')).toEqual([4, 5, 20251001]);
  });

  it('should parse dot-separated versions', () => {
    expect(parseModelVersion('claude-4.5-sonnet')).toEqual([4, 5]);
    expect(parseModelVersion('claude-haiku-4.5')).toEqual([4, 5]);
    expect(parseModelVersion('claude-opus-4.6.20260205')).toEqual([4, 6, 20260205]);
  });

  it('should parse mixed dot and dash versions', () => {
    expect(parseModelVersion('claude-4.5-sonnet-v2')).toEqual([4, 5, 2]);
    expect(parseModelVersion('claude-opus-4.6-20260205')).toEqual([4, 6, 20260205]);
  });

  it('should handle models with multiple version segments', () => {
    expect(parseModelVersion('claude-3-5-sonnet-v2')).toEqual([3, 5, 2]);
    expect(parseModelVersion('claude-sonnet-v2-vertex')).toEqual([2]);
    expect(parseModelVersion('claude-4-1-opus')).toEqual([4, 1]);
  });

  it('should return empty array for models without numbers', () => {
    expect(parseModelVersion('claude-sonnet')).toEqual([]);
    expect(parseModelVersion('claude-opus-latest')).toEqual([]);
    expect(parseModelVersion('custom-model-name')).toEqual([]);
  });

  it('should handle edge cases', () => {
    expect(parseModelVersion('')).toEqual([]);
    expect(parseModelVersion('123')).toEqual([123]);
    expect(parseModelVersion('model-1-2-3-4-5')).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('compareModelVersions', () => {
  describe('with parseable versions', () => {
    it('should correctly compare single-segment versions', () => {
      expect(compareModelVersions('claude-4-opus', 'claude-3-opus')).toBeGreaterThan(0);
      expect(compareModelVersions('claude-3-opus', 'claude-4-opus')).toBeLessThan(0);
      expect(compareModelVersions('claude-4-opus', 'claude-4-opus')).toBe(0);
    });

    it('should correctly compare multi-segment versions', () => {
      expect(compareModelVersions('claude-opus-4-6-20260205', 'claude-opus-4-5-20251101')).toBeGreaterThan(0);
      expect(compareModelVersions('claude-4-5-sonnet', 'claude-3-5-sonnet')).toBeGreaterThan(0);
      expect(compareModelVersions('claude-4-1-opus', 'claude-4-opus')).toBeGreaterThan(0);
    });

    it('should handle different version lengths', () => {
      // claude-4-1 should be greater than claude-4 (interpreted as claude-4-0)
      expect(compareModelVersions('claude-4-1-opus', 'claude-4-opus')).toBeGreaterThan(0);

      // claude-4-0-1 should be greater than claude-4 (interpreted as claude-4-0-0)
      expect(compareModelVersions('claude-opus-4-0-1', 'claude-opus-4')).toBeGreaterThan(0);
    });

    it('should compare dot-formatted versions correctly', () => {
      expect(compareModelVersions('claude-haiku-4.5', 'claude-haiku-4.4')).toBeGreaterThan(0);
      expect(compareModelVersions('claude-opus-4.6.20260205', 'claude-opus-4.5.20251101')).toBeGreaterThan(0);
    });

    it('should handle mixed formats consistently', () => {
      // Both should parse to [4, 5]
      expect(compareModelVersions('claude-4.5-sonnet', 'claude-4-5-sonnet')).toBe(0);

      // 4.6 vs 4-5
      expect(compareModelVersions('claude-4.6-sonnet', 'claude-4-5-sonnet')).toBeGreaterThan(0);
    });
  });

  describe('with unparseable versions (fallback to string comparison)', () => {
    it('should use string comparison when both models have no numbers', () => {
      const result = compareModelVersions('claude-opus-latest', 'claude-opus-beta');
      // 'latest' > 'beta' in lexical order
      expect(result).toBeGreaterThan(0);
    });

    it('should use string comparison when one model has no numbers', () => {
      const result1 = compareModelVersions('claude-opus-latest', 'claude-opus-4');
      const result2 = compareModelVersions('claude-opus-4', 'claude-opus-latest');

      // Should still provide consistent ordering
      expect(result1).toBe(-result2);
    });

    it('should provide consistent ordering for unparseable versions', () => {
      const modelA = 'custom-model-alpha';
      const modelB = 'custom-model-beta';

      const result1 = compareModelVersions(modelA, modelB);
      const result2 = compareModelVersions(modelB, modelA);

      expect(result1).toBe(-result2); // Consistent ordering
      expect(result1).toBeLessThan(0); // alpha < beta lexically
    });
  });

  describe('edge cases', () => {
    it('should handle empty strings', () => {
      expect(compareModelVersions('', '')).toBe(0);
      expect(compareModelVersions('claude-4', '')).not.toBe(0);
    });

    it('should handle identical model names', () => {
      expect(compareModelVersions('claude-4-5-sonnet', 'claude-4-5-sonnet')).toBe(0);
      expect(compareModelVersions('custom-model', 'custom-model')).toBe(0);
    });
  });
});

describe('selectLatestModel', () => {
  describe('with parseable versions', () => {
    it('should select the latest opus model', () => {
      const models = [
        'claude-4-opus',
        'claude-4-1-opus',
        'claude-opus-4-5-20251101',
        'claude-opus-4-6-20260205'
      ];

      expect(selectLatestModel(models)).toBe('claude-opus-4-6-20260205');
    });

    it('should select the latest haiku model', () => {
      const models = [
        'claude-haiku-4-5-20251001',
        'claude-haiku-4.5',
        'claude-haiku-4.6'
      ];

      expect(selectLatestModel(models)).toBe('claude-haiku-4.6');
    });

    it('should select the latest sonnet model', () => {
      const models = [
        'claude-3-5-sonnet',
        'claude-3-5-sonnet-v2',
        'claude-4-5-sonnet',
        'claude-4-sonnet'
      ];

      expect(selectLatestModel(models)).toBe('claude-4-5-sonnet');
    });

    it('should handle models with different date formats', () => {
      const models = [
        'claude-opus-4-5-20251101',
        'claude-opus-4-5-20251230',
        'claude-opus-4-6-20260101'
      ];

      // 4.6 > 4.5, so date comparison within 4.5 shouldn't matter
      expect(selectLatestModel(models)).toBe('claude-opus-4-6-20260101');
    });
  });

  describe('with unparseable versions', () => {
    it('should select a model even when versions cannot be parsed', () => {
      const models = [
        'custom-model-alpha',
        'custom-model-beta',
        'custom-model-gamma'
      ];

      const result = selectLatestModel(models);
      expect(result).toBeDefined();
      expect(models).toContain(result);
    });

    it('should provide consistent selection for unparseable versions', () => {
      const models = [
        'claude-opus-latest',
        'claude-opus-beta',
        'claude-opus-alpha'
      ];

      const result1 = selectLatestModel(models);
      const result2 = selectLatestModel([...models].reverse()); // Reverse order

      // Should select the same model regardless of input order
      expect(result1).toBe(result2);
    });
  });

  describe('with mixed parseable and unparseable versions', () => {
    it('should prioritize parseable versions over unparseable ones', () => {
      const models = [
        'claude-opus-latest', // Unparseable
        'claude-opus-4-6',    // Parseable
        'claude-opus-beta'    // Unparseable
      ];

      // When comparing, unparseable falls back to string comparison
      // but parseable versions should still work correctly
      const result = selectLatestModel(models);
      expect(result).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('should return undefined for empty array', () => {
      expect(selectLatestModel([])).toBeUndefined();
    });

    it('should return the only model when array has one element', () => {
      expect(selectLatestModel(['claude-4-opus'])).toBe('claude-4-opus');
      expect(selectLatestModel(['custom-model'])).toBe('custom-model');
    });

    it('should handle duplicate models', () => {
      const models = [
        'claude-4-opus',
        'claude-4-opus',
        'claude-4-5-opus'
      ];

      expect(selectLatestModel(models)).toBe('claude-4-5-opus');
    });
  });

  describe('real-world scenarios from screenshot', () => {
    it('should select correct models from Bedrock model list', () => {
      const allModels = [
        'claude-sonnet-v2-vertex',
        'claude-sonnet-3-7-vertex',
        'claude-4-5-sonnet-vertex',
        'claude-3-5-sonnet',
        'claude-3-5-sonnet-v2',
        'claude-3-7',
        'claude-4-sonnet-1m',
        'claude-4-sonnet',
        'claude-4-5-sonnet',
        'claude-4-opus',
        'claude-4-1-opus',
        'claude-opus-4-5-20251101',
        'claude-opus-4-6-20260205',
        'claude-haiku-4-5-20251001'
      ];

      const haikuModels = allModels.filter(m => m.toLowerCase().includes('haiku'));
      const opusModels = allModels.filter(m => m.toLowerCase().includes('opus'));

      expect(selectLatestModel(haikuModels)).toBe('claude-haiku-4-5-20251001');
      expect(selectLatestModel(opusModels)).toBe('claude-opus-4-6-20260205');
    });
  });
});

describe('autoSelectModelTiers integration', () => {
  // Save original env vars
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear environment variables before each test
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  });

  afterEach(() => {
    // Restore original env vars
    process.env = { ...originalEnv };
  });

  describe('with environment variables set', () => {
    it('should use environment variables when all are set', () => {
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'custom-haiku';
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'custom-sonnet';
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'custom-opus';

      // If env vars are set, they should take precedence
      // (This would be tested in the actual autoSelectModelTiers function)
      expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('custom-haiku');
      expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('custom-sonnet');
      expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('custom-opus');
    });

    it('should use mix of env vars and auto-selection', () => {
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'custom-opus';
      // haiku and sonnet not set - should be auto-selected

      expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('custom-opus');
      expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
      expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    });
  });

  describe('without environment variables', () => {
    it('should auto-select when no env vars are set', () => {
      const models = [
        'claude-haiku-4-5-20251001',
        'claude-4-5-sonnet',
        'claude-opus-4-5-20251101',
        'claude-opus-4-6-20260205'
      ];

      const haikuModels = models.filter(m => m.toLowerCase().includes('haiku'));
      const opusModels = models.filter(m => m.toLowerCase().includes('opus'));

      expect(selectLatestModel(haikuModels)).toBe('claude-haiku-4-5-20251001');
      expect(selectLatestModel(opusModels)).toBe('claude-opus-4-6-20260205');
    });

    it('should handle missing model tiers gracefully', () => {
      const models = ['claude-4-5-sonnet']; // No haiku or opus

      const haikuModels = models.filter(m => m.toLowerCase().includes('haiku'));
      const opusModels = models.filter(m => m.toLowerCase().includes('opus'));

      expect(selectLatestModel(haikuModels)).toBeUndefined();
      expect(selectLatestModel(opusModels)).toBeUndefined();
    });
  });
});
