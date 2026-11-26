import { describe, it, expect, vi, beforeEach } from 'vitest';

const readStateMock = vi.fn();
const getStoredCredentialsMock = vi.fn();
const readRecordMock = vi.fn();
const coldStartProfileMock = vi.fn();

vi.mock('@/cli/commands/proxy/daemon-manager.js', () => ({ readState: readStateMock, readConnectionRecord: readRecordMock }));
const workingDirProfileMock = vi.fn();
vi.mock('@/cli/commands/proxy/otlp-cold-start.js', () => ({ resolveColdStartProfile: coldStartProfileMock, loadWorkingDirectoryProfile: workingDirProfileMock }));
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

  it('without daemon state, only for the recorded-profile caller, uses the cold start profile selection itself (EPMCDME-17854)', async () => {
    readStateMock.mockResolvedValue(null);
    readRecordMock.mockResolvedValue({ profile: 'work' });
    coldStartProfileMock.mockResolvedValue({ scope: 'global', config: { name: 'work', codeMieUrl: 'https://sync', baseUrl: 'https://target' } });
    getStoredCredentialsMock.mockImplementation(async (url: string) => creds(url));

    await expect(resolveHookCredentials({ recordedProfile: true })).resolves.toMatchObject({ apiUrl: 'https://sync' });
    expect(coldStartProfileMock).toHaveBeenCalledWith('work');
  });

  it('with no daemon state and no connection record, names the login of the working directory profile the cold start would start on', async () => {
    readStateMock.mockResolvedValue(null);
    readRecordMock.mockResolvedValue(null);
    workingDirProfileMock.mockResolvedValue({ name: 'work', codeMieUrl: 'https://sync', baseUrl: 'https://target' });
    getStoredCredentialsMock.mockImplementation(async (url: string) => creds(url));

    await expect(resolveHookCredentials({ recordedProfile: true })).resolves.toMatchObject({ apiUrl: 'https://sync' });
    expect(coldStartProfileMock).not.toHaveBeenCalled();
  });

  it('with no connection record, a working directory profile without a baseUrl (no daemon would start) gives no credentials', async () => {
    readStateMock.mockResolvedValue(null);
    workingDirProfileMock.mockResolvedValue({ name: 'default', codeMieUrl: 'https://sync', baseUrl: ' ' });
    getStoredCredentialsMock.mockImplementation(async (url: string) => creds(url));

    await expect(resolveHookCredentials({ recordedProfile: true })).resolves.toBeNull();
    expect(getStoredCredentialsMock).not.toHaveBeenCalled();
  });

  it('a sibling hook (no recordedProfile) never reads the recorded profile without daemon state', async () => {
    readStateMock.mockResolvedValue(null);
    readRecordMock.mockResolvedValue({ profile: 'work' });
    coldStartProfileMock.mockResolvedValue({ scope: 'global', config: { name: 'work', codeMieUrl: 'https://sync', baseUrl: 'https://target' } });

    await expect(resolveHookCredentials()).resolves.toBeNull();
    expect(readRecordMock).not.toHaveBeenCalled();
    expect(coldStartProfileMock).not.toHaveBeenCalled();
  });

  it('an unusable recorded profile (the cold start would skip it) gives no credentials', async () => {
    readStateMock.mockResolvedValue(null);
    readRecordMock.mockResolvedValue({ profile: 'gone' });
    coldStartProfileMock.mockResolvedValue({ skipReason: 'profile not found' });
    getStoredCredentialsMock.mockImplementation(async (url: string) => creds(url));

    await expect(resolveHookCredentials({ recordedProfile: true })).resolves.toBeNull();
    expect(getStoredCredentialsMock).not.toHaveBeenCalled();
  });

  it('the daemon state wins over the recorded profile', async () => {
    readStateMock.mockResolvedValue({ targetUrl: 'https://target' });
    readRecordMock.mockResolvedValue({ profile: 'work' });
    getStoredCredentialsMock.mockImplementation(async (url: string) => creds(url));

    await expect(resolveHookCredentials({ recordedProfile: true })).resolves.toMatchObject({ apiUrl: 'https://target' });
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
