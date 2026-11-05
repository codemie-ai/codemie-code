/**
 * CodeMieProxy.start suggests a login command that targets the platform host, not the API path.
 * @group unit
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../core/codemie-auth-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../core/codemie-auth-helpers.js')>()),
  getStoredPlatformCredentials: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../../core/registry.js', () => ({
  ProviderRegistry: { getProvider: vi.fn().mockReturnValue({ name: 'ai-run-sso', authType: 'sso' }) },
}));

const API_URL = 'https://codemie.lab.epam.com/code-assistant-api';

async function startError(syncCodeMieUrl?: string): Promise<string> {
  const { CodeMieProxy } = await import('../sso.proxy.js');
  const proxy = new CodeMieProxy({
    targetApiUrl: API_URL,
    host: '127.0.0.1',
    port: 0,
    provider: 'ai-run-sso',
    syncCodeMieUrl,
  });
  const error = await proxy.start().catch((e: unknown) => e);
  return (error as Error).message;
}

describe('CodeMieProxy.start without stored SSO credentials', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('suggests the platform origin, not the API URL', async () => {
    const message = await startError();

    expect(message).toContain('Please run: codemie profile login --url https://codemie.lab.epam.com');
    expect(message).not.toContain('--url https://codemie.lab.epam.com/code-assistant-api');
  });

  it('keeps a same-origin workspace codeMieUrl', async () => {
    const message = await startError('https://codemie.lab.epam.com/ui');

    expect(message).toContain('--url https://codemie.lab.epam.com/ui');
  });
});
