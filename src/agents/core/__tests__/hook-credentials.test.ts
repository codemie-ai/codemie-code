import { describe, it, expect, vi, beforeEach } from 'vitest';

const readStateMock = vi.fn();
const getStoredCredentialsMock = vi.fn();
const readRecordMock = vi.fn();
const loadConfigMock = vi.fn();

vi.mock('@/cli/commands/proxy/daemon-manager.js', () => ({ readState: readStateMock, readConnectionRecord: readRecordMock }));
vi.mock('@/utils/config.js', () => ({ ConfigLoader: { load: loadConfigMock } }));
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
    readRecordMock.mockResolvedValue(null);
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

  it('without daemon state uses the URLs of the profile proxy connect recorded (EPMCDME-17854)', async () => {
    readStateMock.mockResolvedValue(null);
    readRecordMock.mockResolvedValue({ profile: 'work' });
    loadConfigMock.mockResolvedValue({ name: 'work', codeMieUrl: 'https://sync', baseUrl: 'https://target' });
    getStoredCredentialsMock.mockImplementation(async (url: string) => creds(url));

    await expect(resolveHookCredentials()).resolves.toMatchObject({ apiUrl: 'https://sync' });
    expect(loadConfigMock).toHaveBeenCalledWith(process.cwd(), { name: 'work' });
  });

  it('without daemon state ignores a recorded profile the configs do not know (it loads as another one)', async () => {
    readStateMock.mockResolvedValue(null);
    readRecordMock.mockResolvedValue({ profile: 'gone' });
    loadConfigMock.mockResolvedValue({ name: 'default', codeMieUrl: 'https://sync', baseUrl: 'https://target' });
    getStoredCredentialsMock.mockImplementation(async (url: string) => creds(url));

    await expect(resolveHookCredentials()).resolves.toBeNull();
    expect(getStoredCredentialsMock).not.toHaveBeenCalled();
  });

  it('the daemon state wins over the recorded profile', async () => {
    readStateMock.mockResolvedValue({ targetUrl: 'https://target' });
    readRecordMock.mockResolvedValue({ profile: 'work' });
    getStoredCredentialsMock.mockImplementation(async (url: string) => creds(url));

    await expect(resolveHookCredentials()).resolves.toMatchObject({ apiUrl: 'https://target' });
    expect(readRecordMock).not.toHaveBeenCalled();
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
