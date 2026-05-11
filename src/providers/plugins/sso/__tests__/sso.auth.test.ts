import { afterEach, describe, expect, it, vi } from 'vitest';

describe('CodeMieSSO module loading', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doUnmock('open');
  });

  it('does not load browser opener dependency until authentication is started', async () => {
    vi.doMock('open', () => {
      throw new Error('open dependency failed to load');
    });

    const { CodeMieSSO } = await import('../sso.auth.js');

    expect(new CodeMieSSO()).toBeInstanceOf(CodeMieSSO);
  });

  it('prints the SSO URL and continues waiting when browser launch fails', async () => {
    vi.doMock('open', () => ({
      default: vi.fn().mockRejectedValue(new Error('missing wsl-utils/index.js'))
    }));
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { CodeMieSSO } = await import('../sso.auth.js');
    const sso = new CodeMieSSO();

    const result = await sso.authenticate({
      codeMieUrl: 'https://codemie.example.com',
      timeout: 1
    });

    const output = consoleLog.mock.calls.map(call => call.join(' ')).join('\n');
    expect(output).toContain('Open this URL in your browser:');
    expect(output).toContain('https://codemie.example.com/code-assistant-api/v1/auth/login/');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Authentication timeout');
  });
});
