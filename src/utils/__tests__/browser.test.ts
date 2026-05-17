/**
 * Browser utility tests
 * @group unit
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('open', () => ({
  default: vi.fn(),
}));

describe('openUrlInBrowser', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('delegates URL opening to the cross-platform open package', async () => {
    const open = (await import('open')).default;
    const { openUrlInBrowser } = await import('../browser.js');

    vi.mocked(open).mockResolvedValue(undefined);

    await openUrlInBrowser('http://localhost:9749');

    expect(open).toHaveBeenCalledWith('http://localhost:9749', { wait: false });
  });
});
