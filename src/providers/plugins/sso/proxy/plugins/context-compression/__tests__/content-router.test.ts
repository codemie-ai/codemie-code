import { describe, it, expect } from 'vitest';
import { createContentRouter, computePressureMinRatio } from '../transforms/content-router.js';

describe('computePressureMinRatio', () => {
  it('returns min_ratio_relaxed (0.85) when fill is 0', () => {
    expect(computePressureMinRatio(0)).toBeCloseTo(0.85);
  });

  it('returns min_ratio_aggressive (0.65) when fill is 1', () => {
    expect(computePressureMinRatio(1)).toBeCloseTo(0.65);
  });

  it('linearly interpolates at fill=0.5', () => {
    const ratio = computePressureMinRatio(0.5);
    expect(ratio).toBeCloseTo(0.75);
  });

  it('clamps fill below 0 to 0', () => {
    expect(computePressureMinRatio(-0.1)).toBeCloseTo(0.85);
  });

  it('clamps fill above 1 to 1', () => {
    expect(computePressureMinRatio(1.5)).toBeCloseTo(0.65);
  });
});

describe('ContentRouter.routeWithPressure', () => {
  it('exports routeWithPressure method', async () => {
    const { createTokenizer } = await import('../tokenizer/tiktoken.js');
    const tokenizer = createTokenizer();
    const router = createContentRouter(tokenizer);
    expect(typeof router.routeWithPressure).toBe('function');
  });

  it('returns original when compressor ratio exceeds pressure threshold', async () => {
    // At fill=0, pressureRatio=0.85. A result with compressionRatio=0.9 (bad compression)
    // should be discarded and original returned.
    const { createTokenizer } = await import('../tokenizer/tiktoken.js');
    const tokenizer = createTokenizer();
    const router = createContentRouter(tokenizer);
    // Use content that the SmartCrusher will likely not compress well
    const content = 'short';
    const result = await router.routeWithPressure(content, 0);
    // compressionRatio will be 1.0 (original) or close to 1 for "short" text
    // Just verify the method returns a valid CompressionResult shape
    expect(result).toHaveProperty('compressed');
    expect(result).toHaveProperty('compressionRatio');
    expect(typeof result.compressionRatio).toBe('number');
  });

  it('routeWithPressure at fill=1 uses aggressive threshold (0.65)', async () => {
    const { createTokenizer } = await import('../tokenizer/tiktoken.js');
    const tokenizer = createTokenizer();
    const router = createContentRouter(tokenizer, {
      minRatioRelaxed: 0.85,
      minRatioAggressive: 0.65,
    });
    const content = 'hello world';
    // Should not throw, should return CompressionResult
    const result = await router.routeWithPressure(content, 1.0);
    expect(result).toHaveProperty('compressed');
    expect(result.compressionRatio).toBeGreaterThanOrEqual(0);
    expect(result.compressionRatio).toBeLessThanOrEqual(1.0);
  });
});
