import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const startSync = vi.fn();
const stopSync = vi.fn();
vi.mock('../codex.incremental-sync.js', () => ({
  startCodexIncrementalSync: startSync,
  stopCodexIncrementalSync: stopSync,
}));

describe('CodexPluginMetadata.lifecycle — timer wiring', () => {
  beforeEach(() => {
    startSync.mockReset();
    stopSync.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.CODEMIE_CODEX_STARTED_AT;
  });

  it('starts the incremental-sync timer on SessionStart', async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent }));

    const { CodexPluginMetadata } = await import('../codex.plugin.js');
    const env: NodeJS.ProcessEnv = {
      CODEMIE_AGENT: 'codex',
      CODEMIE_PROVIDER: 'ai-run-sso',
      CODEMIE_BASE_URL: 'http://127.0.0.1:49152',
      CODEMIE_URL: 'https://codemie.example.com',
      CODEMIE_CLI_VERSION: '0.1.0',
      CODEMIE_PROJECT: 'p',
      CODEMIE_MODEL: 'gpt-5.4',
    };

    await CodexPluginMetadata.lifecycle!.onSessionStart!('sid-start', env);

    expect(startSync).toHaveBeenCalledTimes(1);
    const opts = startSync.mock.calls[0][0];
    expect(opts).toMatchObject({
      sessionId: 'sid-start',
      cwd: process.cwd(),
    });
    expect(typeof opts.startedAt).toBe('number');
    expect(typeof opts.buildContext).toBe('function');
    expect(opts.metadata).toBe(CodexPluginMetadata);

    const ctx = opts.buildContext();
    expect(ctx).toMatchObject({
      sessionId: 'sid-start',
      apiBaseUrl: 'http://127.0.0.1:49152',
      clientType: 'codemie-codex',
      version: '0.1.0',
      dryRun: false,
    });
  });

  it('stops the timer on SessionEnd before processEvent', async () => {
    const calls: string[] = [];
    stopSync.mockImplementation(() => calls.push('stop'));
    const processEvent = vi.fn().mockImplementation(async () => {
      calls.push('processEvent');
    });
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent }));

    const { CodexPluginMetadata } = await import('../codex.plugin.js');
    await CodexPluginMetadata.lifecycle!.onSessionEnd!(0, {
      CODEMIE_SESSION_ID: 'sid-end',
      CODEMIE_AGENT: 'codex',
      CODEMIE_PROVIDER: 'ai-run-sso',
      CODEMIE_BASE_URL: 'http://localhost',
      CODEMIE_URL: 'https://codemie.example.com',
      CODEMIE_CLI_VERSION: '0.1.0',
    });

    expect(stopSync).toHaveBeenCalledWith('sid-end');
    expect(calls[0]).toBe('stop');
    expect(calls).toContain('processEvent');
  });

  it('skips both stop and processEvent when CODEMIE_SESSION_ID is unset', async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent }));

    const { CodexPluginMetadata } = await import('../codex.plugin.js');
    await CodexPluginMetadata.lifecycle!.onSessionEnd!(0, {});

    expect(stopSync).not.toHaveBeenCalled();
    expect(processEvent).not.toHaveBeenCalled();
  });
});
