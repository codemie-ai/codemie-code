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
});
