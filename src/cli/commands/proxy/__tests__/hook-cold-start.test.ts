/**
 * Hook cold start through the real daemon-manager: the agent's protocol channel stays clean
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const AGENT = 'claude-code-otlp';

vi.mock('../../../../utils/config.js', () => ({
  ConfigLoader: { getActiveProfileName: vi.fn(), load: vi.fn() },
}));
vi.mock('../../../../providers/core/codemie-auth-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../providers/core/codemie-auth-helpers.js')>()),
  getStoredPlatformCredentials: vi.fn().mockResolvedValue({ token: 't' }),
}));
vi.mock('@/utils/processes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/processes.js')>()),
  spawnDetached: vi.fn(),
}));
vi.mock('../connectors/desktop.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/desktop.js')>()),
  readDesktopGateway: vi.fn(async () => null),
}));

describe('ensureOtlpProxy reaching spawnDaemon', () => {
  let home: string;
  let outputSpies: Array<ReturnType<typeof vi.spyOn>>;
  const realHome = process.env.HOME;
  const realUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codemie-hook-cold-start-'));
    process.env.CODEMIE_HOME = home;
    // Claude Code's settings (the OTLP endpoint port) are read from the home directory.
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    vi.resetModules();
    outputSpies = [
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    ];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CODEMIE_HOME;
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realUserProfile;
    rmSync(home, { recursive: true, force: true });
  });

  it('runs under the temporary home', () => {
    expect(homedir()).toBe(home);
  });

  it('writes nothing to stdout or stderr, logs the spawn and the profile, and records the profile and port with no identity', async () => {
    const { ensureOtlpProxy } = await import('../otlp-cold-start.js');
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { spawnDetached } = await import('@/utils/processes.js');
    const { logger } = await import('../../../../utils/logger.js');

    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const status = vi.spyOn(logger, 'status').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'success').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    vi.mocked(ConfigLoader.getActiveProfileName).mockResolvedValue('work');
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'work',
      provider: 'ai-run-sso',
      baseUrl: 'https://x.example.com/api',
      codeMieUrl: 'https://x.example.com',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    // The daemon process writes its state file once it is up; do the same for the stub.
    vi.mocked(spawnDetached).mockImplementation(((_command: string, args: string[]) => {
      const arg = (name: string): string => args[args.indexOf(name) + 1];
      writeFileSync(arg('--state-file'), JSON.stringify({
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: arg('--profile'),
        gatewayKey: arg('--gateway-key'),
        targetUrl: arg('--target-url'),
        provider: arg('--provider'),
        startedAt: new Date().toISOString(),
      }), 'utf-8');
      return process.pid;
    }) as unknown as typeof spawnDetached);

    await ensureOtlpProxy(AGENT);

    expect(spawnDetached).toHaveBeenCalledTimes(1);
    const args = vi.mocked(spawnDetached).mock.calls[0][1] as string[];
    expect(args).not.toContain('--client-type');
    expect(args).not.toContain('--telemetry-mode');
    for (const spy of outputSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(debug.mock.calls.some(call => call[0] === '[daemon-manager] Spawning daemon')).toBe(true);
    expect(status).toHaveBeenCalledWith('Starting proxy (profile: work)...');
    const record = JSON.parse(readFileSync(join(home, 'proxy-connection.json'), 'utf-8'));
    expect(record).toMatchObject({ version: 1, profile: 'work', port: 4001 });
    expect(record).not.toHaveProperty('clientType');
  });

  it('starts with no identity on Claude Desktop\'s gateway port when nothing else names one, writing nothing to stdout or stderr', async () => {
    const { ensureOtlpProxy } = await import('../otlp-cold-start.js');
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { spawnDetached } = await import('@/utils/processes.js');
    const { readDesktopGateway } = await import('../connectors/desktop.js');
    const { logger } = await import('../../../../utils/logger.js');
    for (const method of ['debug', 'status', 'warn', 'success', 'info'] as const) {
      vi.spyOn(logger, method).mockImplementation(() => undefined);
    }

    vi.mocked(readDesktopGateway).mockResolvedValueOnce({ port: 4005 });
    vi.mocked(ConfigLoader.getActiveProfileName).mockResolvedValue('work');
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'work',
      provider: 'ai-run-sso',
      baseUrl: 'https://x.example.com/api',
      codeMieUrl: 'https://x.example.com',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    let spawnArgs: string[] = [];
    vi.mocked(spawnDetached).mockImplementation(((_command: string, args: string[]) => {
      spawnArgs = args;
      const arg = (name: string): string => args[args.indexOf(name) + 1];
      writeFileSync(arg('--state-file'), JSON.stringify({
        pid: process.pid,
        port: Number(arg('--port')),
        url: `http://127.0.0.1:${arg('--port')}`,
        profile: arg('--profile'),
        gatewayKey: arg('--gateway-key'),
        startedAt: new Date().toISOString(),
      }), 'utf-8');
      return process.pid;
    }) as unknown as typeof spawnDetached);

    await ensureOtlpProxy(AGENT);

    const arg = (name: string): string => spawnArgs[spawnArgs.indexOf(name) + 1];
    expect(arg('--port')).toBe('4005');
    expect(spawnArgs).not.toContain('--client-type');
    expect(spawnArgs).not.toContain('--telemetry-mode');
    for (const spy of outputSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
    const record = JSON.parse(readFileSync(join(home, 'proxy-connection.json'), 'utf-8'));
    expect(record).toMatchObject({ profile: 'work', port: 4005 });
    expect(record).not.toHaveProperty('clientType');
    expect(record).not.toHaveProperty('telemetryMode');
  });

  it('looks up the credentials of the profile provider, not a hard-coded one', async () => {
    const { ensureOtlpProxy } = await import('../otlp-cold-start.js');
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { getStoredPlatformCredentials } = await import('../../../../providers/core/codemie-auth-helpers.js');
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'work',
      provider: 'custom-sso',
      baseUrl: 'https://x.example.com/api',
      codeMieUrl: 'https://x.example.com',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);

    await ensureOtlpProxy(AGENT);

    expect(getStoredPlatformCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'custom-sso' })
    );
  });
});
