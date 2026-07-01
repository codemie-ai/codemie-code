import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSyncProcessor } from '../syncProcessor.js';

describe('createSyncProcessor — CODEMIE_CONV_SYNC_DISABLED guard', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.CODEMIE_CONV_SYNC_DISABLED;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CODEMIE_CONV_SYNC_DISABLED;
    } else {
      process.env.CODEMIE_CONV_SYNC_DISABLED = originalEnv;
    }
  });

  it('returns early with a disabled message when CODEMIE_CONV_SYNC_DISABLED=1', async () => {
    process.env.CODEMIE_CONV_SYNC_DISABLED = '1';
    const processor = createSyncProcessor();
    const result = await processor.process(
      { sessionId: 'test-session' } as never,
      {} as never,
    );
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/disabled/i);
  });
});
