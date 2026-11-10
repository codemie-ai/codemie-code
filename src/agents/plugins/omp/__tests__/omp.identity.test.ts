/**
 * omp reports under its own `codemie-omp` client and `omp` agent, not Pi's.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

const processEvent = vi.fn();
vi.mock('../../../../cli/commands/hook.js', () => ({ processEvent: (...args: unknown[]) => processEvent(...args) }));
const startPiIncrementalSync = vi.fn();
vi.mock('../../pi/pi.incremental-sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../pi/pi.incremental-sync.js')>()),
  startPiIncrementalSync: (...args: unknown[]) => startPiIncrementalSync(...args),
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  processEvent.mockReset();
  startPiIncrementalSync.mockReset();
});

describe('OmpPluginMetadata', () => {
  it('declares the omp agent, its client type and its data home', async () => {
    const { OmpPluginMetadata } = await import('../omp.plugin.js');

    expect(OmpPluginMetadata.name).toBe('omp');
    expect(OmpPluginMetadata.displayName).toBe('Oh My Pi');
    expect(OmpPluginMetadata.ssoConfig).toEqual({ enabled: true, clientType: 'codemie-omp' });
    expect(OmpPluginMetadata.dataPaths?.home).toBe('.omp');
    expect(OmpPluginMetadata.npmPackage).toBe('@oh-my-pi/pi-coding-agent');
  });

  it('is registered, so the metrics pipeline resolves it by name', async () => {
    const { AgentRegistry } = await import('../../../registry.js');
    expect(AgentRegistry.getAgent('omp')?.metadata.name).toBe('omp');
  });
});

describe('omp onSessionStart', () => {
  it('hands processEvent an omp hook config', async () => {
    vi.stubEnv('CODEMIE_PI_SYNC_ENABLED', 'false');
    const { OmpPluginMetadata } = await import('../omp.plugin.js');

    await OmpPluginMetadata.lifecycle!.onSessionStart!('sid-omp', { CODEMIE_PROVIDER: 'ai-run-sso' });

    expect(processEvent).toHaveBeenCalledWith(
      expect.objectContaining({ hook_event_name: 'SessionStart' }),
      expect.objectContaining({ agentName: 'omp', clientType: 'codemie-omp', sessionId: 'sid-omp' }),
    );
  });

  it('honours CODEMIE_AGENT over the default agent name, as Pi does', async () => {
    vi.stubEnv('CODEMIE_PI_SYNC_ENABLED', 'false');
    const { OmpPluginMetadata } = await import('../omp.plugin.js');

    await OmpPluginMetadata.lifecycle!.onSessionStart!('sid-omp', { CODEMIE_AGENT: 'omp-custom' });

    expect(processEvent.mock.calls[0][1]).toEqual(
      expect.objectContaining({ agentName: 'omp-custom', clientType: 'codemie-omp' }),
    );
  });

  it('uploads the mid-run flush as the codemie-omp client', async () => {
    const { OmpPluginMetadata } = await import('../omp.plugin.js');

    await OmpPluginMetadata.lifecycle!.onSessionStart!('sid-omp', {});

    const options = startPiIncrementalSync.mock.calls[0][0];
    expect(options.metadata).toBe(OmpPluginMetadata);
    expect(options.buildContext().clientType).toBe('codemie-omp');
  });
});

describe('Pi stays Pi', () => {
  it('keeps the codemie-pi client and pi agent in its hook config', async () => {
    vi.stubEnv('CODEMIE_PI_SYNC_ENABLED', 'false');
    const { PiPluginMetadata } = await import('../../pi/pi.plugin.js');

    await PiPluginMetadata.lifecycle!.onSessionStart!('sid-pi', {});

    expect(processEvent.mock.calls[0][1]).toEqual(
      expect.objectContaining({ agentName: 'pi', clientType: 'codemie-pi' }),
    );
  });
});

describe('omp session adapter', () => {
  it('files conversations under omp, authored by Oh My Pi', async () => {
    const { OmpPlugin } = await import('../omp.plugin.js');
    const adapter = OmpPlugin.prototype.getSessionAdapter.call(new OmpPlugin()) as unknown as {
      agentName: string;
      processors: { name: string; identity?: unknown }[];
    };

    expect(adapter.agentName).toBe('omp');
    expect(adapter.processors.find((p) => p.name === 'pi-conversations')?.identity).toEqual({
      folder: 'omp',
      authorName: 'Oh My Pi',
    });
  });
});
