import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/utils/config.js', () => ({
  ConfigLoader: { load: vi.fn() },
}));

vi.mock('@/utils/auth.js', () => ({
  getAuthenticatedClient: vi.fn(),
}));

vi.mock('@/utils/logger.js', () => ({
  logger: { error: vi.fn(), debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const SSO_ERROR_MESSAGE =
  'SSO authentication required. Please run "codemie setup" with SSO provider first.';

describe('getSdkClient', () => {
  let exitCode: number | undefined;
  let stderr: string[];

  beforeEach(() => {
    exitCode = undefined;
    stderr = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit:${code}`);
    }) as never);
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('exits non-zero via handleSdkError with the remediation on stderr', async () => {
    const { ConfigLoader } = await import('@/utils/config.js');
    const { getAuthenticatedClient } = await import('@/utils/auth.js');
    const { ConfigurationError } = await import('@/utils/errors.js');

    vi.mocked(ConfigLoader.load).mockResolvedValue({} as never);
    vi.mocked(getAuthenticatedClient).mockRejectedValue(
      new ConfigurationError(SSO_ERROR_MESSAGE)
    );

    const { getSdkClient } = await import('../cli-utils.js');

    // handleSdkError terminates the process; the spy converts that into a throw.
    await expect(getSdkClient()).rejects.toThrow('process.exit:1');
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('codemie setup');
  });

  it('returns the client unchanged when authentication succeeds', async () => {
    const { ConfigLoader } = await import('@/utils/config.js');
    const { getAuthenticatedClient } = await import('@/utils/auth.js');

    const client = { marker: 'authenticated-client' };
    vi.mocked(ConfigLoader.load).mockResolvedValue({} as never);
    vi.mocked(getAuthenticatedClient).mockResolvedValue(client as never);

    const { getSdkClient } = await import('../cli-utils.js');

    await expect(getSdkClient()).resolves.toBe(client);
    expect(exitCode).toBeUndefined();
  });
});
