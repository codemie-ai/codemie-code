import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../../utils/version-warnings.js', () => ({
  VersionWarningStore: {
    clear: vi.fn(),
  },
}));

describe('resetVersionWarnings', () => {
  const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy.mockClear();
  });

  it('returns 0 and prints "0 marker(s) removed" when store is empty', async () => {
    const { VersionWarningStore } = await import('../../../../utils/version-warnings.js');
    vi.mocked(VersionWarningStore.clear).mockResolvedValue({ removed: 0 });
    const { resetVersionWarnings } = await import('../index.js');
    const removed = await resetVersionWarnings();
    expect(removed).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalledOnce();
    const [line] = consoleLogSpy.mock.calls[0] as [string];
    expect(line).toContain('0 marker(s) removed');
  });

  it('returns the removed count from the store', async () => {
    const { VersionWarningStore } = await import('../../../../utils/version-warnings.js');
    vi.mocked(VersionWarningStore.clear).mockResolvedValue({ removed: 3 });
    const { resetVersionWarnings } = await import('../index.js');
    const removed = await resetVersionWarnings();
    expect(removed).toBe(3);
    const [line] = consoleLogSpy.mock.calls[0] as [string];
    expect(line).toContain('3 marker(s) removed');
  });
});
