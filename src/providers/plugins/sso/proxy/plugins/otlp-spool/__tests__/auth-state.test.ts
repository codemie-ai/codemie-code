import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('auth-state', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('starts fresh and marks/clears idempotently', async () => {
    const { areCredentialsStale, markCredentialsStale, clearCredentialsStale } = await import('../auth-state.js');

    expect(areCredentialsStale()).toBe(false);

    markCredentialsStale();
    expect(areCredentialsStale()).toBe(true);
    markCredentialsStale(); // second call is a no-op, not a second warn
    expect(areCredentialsStale()).toBe(true);

    clearCredentialsStale();
    expect(areCredentialsStale()).toBe(false);
    clearCredentialsStale(); // second call is a no-op
    expect(areCredentialsStale()).toBe(false);
  });

  it('can be marked stale again after being cleared', async () => {
    const { areCredentialsStale, markCredentialsStale, clearCredentialsStale } = await import('../auth-state.js');

    markCredentialsStale();
    clearCredentialsStale();
    markCredentialsStale();

    expect(areCredentialsStale()).toBe(true);
  });
});
