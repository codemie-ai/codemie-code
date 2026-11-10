import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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
      CODEMIE_TARGET_API_URL: 'https://codemie.example.com/code-assistant-api',
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

  it('tags buildContext and processEvent with CODEMIE_CLIENT_TYPE when set (e.g. by codex-acp)', async () => {
    // CodexAcpPluginMetadata inherits onSessionStart/onSessionEnd verbatim and relies
    // on BaseAgentAdapter setting env.CODEMIE_CLIENT_TYPE from its own ssoConfig —
    // regression guard for the hardcoded 'codemie-codex' this replaced.
    const processEvent = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent }));

    const { CodexPluginMetadata } = await import('../codex.plugin.js');
    const env: NodeJS.ProcessEnv = {
      CODEMIE_AGENT: 'codex',
      CODEMIE_CLIENT_TYPE: 'codemie-codex-acp',
      CODEMIE_PROVIDER: 'ai-run-sso',
      CODEMIE_BASE_URL: 'http://127.0.0.1:49152',
      CODEMIE_URL: 'https://codemie.example.com',
      CODEMIE_CLI_VERSION: '0.1.0',
      CODEMIE_MODEL: 'gpt-5.4',
    };

    await CodexPluginMetadata.lifecycle!.onSessionStart!('sid-client-type', env);

    const opts = startSync.mock.calls[0][0];
    expect(opts.buildContext()).toMatchObject({ clientType: 'codemie-codex-acp' });
    expect(processEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ clientType: 'codemie-codex-acp' }),
    );
  });

  it('falls back to codemie-codex when CODEMIE_CLIENT_TYPE is unset (unchanged plain-Codex behavior)', async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent }));

    const { CodexPluginMetadata } = await import('../codex.plugin.js');
    await CodexPluginMetadata.lifecycle!.onSessionStart!('sid-default', {
      CODEMIE_AGENT: 'codex',
      CODEMIE_PROVIDER: 'ai-run-sso',
      CODEMIE_BASE_URL: 'http://127.0.0.1:49152',
    });

    const opts = startSync.mock.calls[0][0];
    expect(opts.buildContext()).toMatchObject({ clientType: 'codemie-codex' });
    expect(processEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ clientType: 'codemie-codex' }),
    );
  });

  it('with no started proxy and no sync URL, the timer gets no send path: CODEMIE_BASE_URL is the LLM host', async () => {
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent: vi.fn().mockResolvedValue(undefined) }));

    const { CodexPluginMetadata } = await import('../codex.plugin.js');
    await CodexPluginMetadata.lifecycle!.onSessionStart!('sid-no-send-path', {
      CODEMIE_AGENT: 'codex',
      CODEMIE_PROVIDER: 'ai-run-sso',
      CODEMIE_URL: 'https://codemie.example.com',
      CODEMIE_BASE_URL: 'https://llm.example.com',
    });

    const opts = startSync.mock.calls[0][0];
    expect(opts.syncApiUrl).toBeUndefined();
    expect(opts.buildContext().apiBaseUrl).toBe('');
  });

  it('with the started proxy, the timer sends through it', async () => {
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent: vi.fn().mockResolvedValue(undefined) }));

    const { CodexPluginMetadata } = await import('../codex.plugin.js');
    await CodexPluginMetadata.lifecycle!.onSessionStart!('sid-proxy', {
      CODEMIE_AGENT: 'codex',
      CODEMIE_PROVIDER: 'ai-run-sso',
      CODEMIE_URL: 'https://codemie.example.com',
      CODEMIE_BASE_URL: 'http://127.0.0.1:4000',
      CODEMIE_TARGET_API_URL: 'https://codemie.example.com/code-assistant-api',
    });

    const opts = startSync.mock.calls[0][0];
    expect(opts.syncApiUrl).toBe('http://127.0.0.1:4000');
    expect(opts.buildContext().apiBaseUrl).toBe('http://127.0.0.1:4000');
  });

  it('hands processEvent the wrapper owner from the env, so the record stores it', async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent }));

    const { CodexPluginMetadata } = await import('../codex.plugin.js');
    await CodexPluginMetadata.lifecycle!.onSessionStart!('sid-owner', {
      CODEMIE_AGENT: 'codex',
      CODEMIE_PROVIDER: 'ai-run-sso',
      CODEMIE_BASE_URL: 'http://127.0.0.1:49152',
      CODEMIE_WRAPPER_PID: '4242',
      CODEMIE_WRAPPER_STARTED_AT: '1790000000000',
    });

    expect(processEvent).toHaveBeenCalledWith(
      expect.objectContaining({ hook_event_name: 'SessionStart' }),
      expect.objectContaining({ ownerPid: 4242, ownerStartedAt: 1_790_000_000_000 }),
    );
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

  it('records the matched rollout as correlation.agentSessionFile before SessionEnd renames the record', async () => {
    // Regression: codex never fed the rollout path back, so every codex session kept
    // correlation.agentSessionFile === '' and analytics priced it at hadLog=false, costUSD=0.
    const calls: string[] = [];
    const rolloutPath = '/tmp/codex-home/sessions/2026/09/26/rollout-2026-09-26T10-00-00-11111111-2222-3333-4444-555555555555.jsonl';
    const stored = {
      sessionId: 'sid-corr',
      agentName: 'codex',
      status: 'active',
      correlation: { status: 'matched', agentSessionId: 'sid-corr', agentSessionFile: '', retryCount: 0 },
    };
    const saveSession = vi.fn().mockImplementation(async (session: typeof stored) => {
      calls.push(`save:${session.correlation.agentSessionFile}`);
    });
    vi.doMock('../../../core/session/SessionStore.js', () => ({
      SessionStore: class {
        loadSession = vi.fn().mockResolvedValue(structuredClone(stored));
        saveSession = saveSession;
      },
    }));
    vi.doMock('../codex.session.js', () => ({
      CodexSessionAdapter: class {
        discoverSessions = vi.fn().mockResolvedValue([
          { sessionId: '11111111-2222-3333-4444-555555555555', filePath: rolloutPath, createdAt: Date.now(), agentName: 'codex' },
        ]);
        parseSessionFile = vi.fn().mockResolvedValue({ metadata: { projectPath: process.cwd() } });
        processSession = vi.fn().mockResolvedValue({ success: true, totalRecords: 1, failedProcessors: [] });
      },
      resolveParentRollout: async (p: string) => p,
    }));
    const processEvent = vi.fn().mockImplementation(async () => {
      calls.push('processEvent');
    });
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent }));

    const { CodexPluginMetadata } = await import('../codex.plugin.js');
    await CodexPluginMetadata.lifecycle!.onSessionEnd!(0, {
      CODEMIE_SESSION_ID: 'sid-corr',
      CODEMIE_CODEX_STARTED_AT: String(Date.now() - 1000),
    });

    expect(saveSession).toHaveBeenCalledTimes(1);
    expect(saveSession.mock.calls[0][0].correlation).toMatchObject({
      status: 'matched',
      agentSessionId: 'sid-corr',
      agentSessionFile: rolloutPath,
    });
    expect(calls).toEqual([`save:${rolloutPath}`, 'processEvent']);
  });

  describe('active duration', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'codex-lifecycle-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const turnLine = (ms: number, type: 'task_started' | 'task_complete'): string =>
      JSON.stringify({
        timestamp: new Date(ms).toISOString(),
        type: 'event_msg',
        payload: type === 'task_started' ? { type, turn_attribution: { turn_id: 't1' } } : { type, turn_id: 't1' },
      });

    async function runSessionEnd(lines: string[], calls: string[]): Promise<{ saves: Array<Record<string, unknown>> }> {
      const rolloutPath = join(dir, 'rollout-2026-11-10T10-00-00-11111111-2222-3333-4444-555555555555.jsonl');
      writeFileSync(rolloutPath, lines.join('\n') + '\n');
      const saves: Array<Record<string, unknown>> = [];
      const stored = { sessionId: 'sid-dur', agentName: 'codex', status: 'active', correlation: { status: 'matched', agentSessionId: 'sid-dur', agentSessionFile: '', retryCount: 0 } };
      vi.doMock('../../../core/session/SessionStore.js', () => ({
        SessionStore: class {
          loadSession = vi.fn().mockResolvedValue(structuredClone(stored));
          saveSession = vi.fn().mockImplementation(async (session: Record<string, unknown>) => {
            saves.push(structuredClone(session));
            if (session.activeDurationMs !== undefined) calls.push('save-duration');
          });
        },
      }));
      vi.doMock('../codex.session.js', () => ({
        CodexSessionAdapter: class {
          discoverSessions = vi.fn().mockResolvedValue([
            { sessionId: '11111111-2222-3333-4444-555555555555', filePath: rolloutPath, createdAt: Date.now(), agentName: 'codex' },
          ]);
          parseSessionFile = vi.fn().mockResolvedValue({ metadata: { projectPath: process.cwd() } });
          processSession = vi.fn().mockResolvedValue({ success: true, totalRecords: 1, failedProcessors: [] });
        },
        resolveParentRollout: async (p: string) => p,
      }));
      vi.doMock('../../../../cli/commands/hook.js', () => ({
        processEvent: vi.fn().mockImplementation(async () => {
          calls.push('processEvent');
        }),
      }));
      const { CodexPluginMetadata } = await import('../codex.plugin.js');
      await CodexPluginMetadata.lifecycle!.onSessionEnd!(0, {
        CODEMIE_SESSION_ID: 'sid-dur',
        CODEMIE_CODEX_STARTED_AT: String(Date.now() - 600_000),
      });
      return { saves };
    }

    it('stores the parent rollout turn time before SessionEnd runs', async () => {
      const calls: string[] = [];
      const t0 = Date.now() - 120_000;
      const { saves } = await runSessionEnd([turnLine(t0, 'task_started'), turnLine(t0 + 45_000, 'task_complete')], calls);

      expect(saves.find((s) => s.activeDurationMs !== undefined)).toMatchObject({ activeDurationMs: 45_000 });
      expect(calls).toEqual(['save-duration', 'processEvent']);
    });

    it('writes nothing when the rollout has no turns', async () => {
      const calls: string[] = [];
      const { saves } = await runSessionEnd([JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: {} })], calls);

      expect(saves.some((s) => s.activeDurationMs !== undefined)).toBe(false);
      expect(calls).toEqual(['processEvent']);
    });

    it('waits for the stopped tick before it writes, so a late tick save cannot revert the value', async () => {
      const calls: string[] = [];
      let releaseStop: () => void = () => undefined;
      stopSync.mockImplementation(() => new Promise<void>((resolve) => {
        releaseStop = () => {
          calls.push('stop-done');
          resolve();
        };
      }));
      const t0 = Date.now() - 120_000;
      const ending = runSessionEnd([turnLine(t0, 'task_started'), turnLine(t0 + 45_000, 'task_complete')], calls);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls).toEqual([]);

      releaseStop();
      await ending;
      expect(calls).toEqual(['stop-done', 'save-duration', 'processEvent']);
    });

    it('SessionStore.accumulateActiveDuration leaves a stored value unchanged when no activity period is open', async () => {
      const home = mkdtempSync(join(tmpdir(), 'codex-store-'));
      const previous = process.env.CODEMIE_HOME;
      process.env.CODEMIE_HOME = home;
      try {
        vi.resetModules();
        vi.doUnmock('../../../core/session/SessionStore.js');
        const { SessionStore } = await import('../../../core/session/SessionStore.js');
        const store = new SessionStore();
        await store.saveSession({ sessionId: 'sid-acc', agentName: 'codex', activeDurationMs: 45_000 } as never);
        expect(await store.accumulateActiveDuration('sid-acc')).toBe(0);
        expect((await store.loadSession('sid-acc'))?.activeDurationMs).toBe(45_000);
      } finally {
        if (previous === undefined) delete process.env.CODEMIE_HOME;
        else process.env.CODEMIE_HOME = previous;
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});
