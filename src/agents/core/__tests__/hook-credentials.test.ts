import { describe, it, expect, vi, beforeEach } from 'vitest';

const readStateMock = vi.fn();
const getStoredCredentialsMock = vi.fn();

vi.mock('@/cli/commands/proxy/daemon-manager.js', () => ({ readState: readStateMock }));
vi.mock('@/providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: class {
    getStoredCredentials = getStoredCredentialsMock;
  },
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { resolveHookCredentials } = await import('../hook-credentials.js');

const creds = (apiUrl: string) => ({ cookies: {}, apiUrl, timestamp: 0 });

describe('resolveHookCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getStoredCredentialsMock.mockResolvedValue(null);
  });

  it('prefers the credentials stored for syncCodeMieUrl', async () => {
    readStateMock.mockResolvedValue({ syncCodeMieUrl: 'https://sync', targetUrl: 'https://target' });
    getStoredCredentialsMock.mockImplementation(async (url: string) => creds(url));

    await expect(resolveHookCredentials()).resolves.toMatchObject({ apiUrl: 'https://sync' });
    expect(getStoredCredentialsMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the targetUrl credentials when the sync URL is unset', async () => {
    readStateMock.mockResolvedValue({ targetUrl: 'https://target' });
    getStoredCredentialsMock.mockImplementation(async (url: string) => creds(url));

    await expect(resolveHookCredentials()).resolves.toMatchObject({ apiUrl: 'https://target' });
    expect(getStoredCredentialsMock).toHaveBeenCalledWith('https://target');
  });

  it('falls back to the targetUrl credentials when the sync URL has none stored', async () => {
    readStateMock.mockResolvedValue({ syncCodeMieUrl: 'https://sync', targetUrl: 'https://target' });
    getStoredCredentialsMock.mockImplementation(async (url: string) => (url === 'https://target' ? creds(url) : null));

    await expect(resolveHookCredentials()).resolves.toMatchObject({ apiUrl: 'https://target' });
  });

  it('returns null without daemon state', async () => {
    readStateMock.mockResolvedValue(null);
    await expect(resolveHookCredentials()).resolves.toBeNull();
    expect(getStoredCredentialsMock).not.toHaveBeenCalled();
  });

  it('returns null when nothing is stored', async () => {
    readStateMock.mockResolvedValue({ syncCodeMieUrl: 'https://sync', targetUrl: 'https://target' });
    await expect(resolveHookCredentials()).resolves.toBeNull();
  });

  it('never throws', async () => {
    readStateMock.mockRejectedValue(new Error('state unreadable'));
    await expect(resolveHookCredentials()).resolves.toBeNull();

    readStateMock.mockResolvedValue({ targetUrl: 'https://target' });
    getStoredCredentialsMock.mockRejectedValue(new Error('keychain locked'));
    await expect(resolveHookCredentials()).resolves.toBeNull();
  });
});
