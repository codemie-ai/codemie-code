/**
 * The rule of the two resolvers, on a home of its own: the sync settings decide `resolveCollection`; the settings
 * installed, the global CLI config and a live daemon with an upstream decide `resolveInstallCollection`.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SyncSettings } from '../../../analytics/sync/types.js';
import { isPidAlive, setUpHome, stateFile, tearDownHome, writeLiveState } from './stand.js';

vi.mock('@/utils/processes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/processes.js')>()),
  // The start-time comparison runs `ps`: a live pid is the daemon.
  isOwnerAlive: vi.fn(async ({ pid }: { pid: number }) => isPidAlive(pid)),
}));

const LOCAL_SETTINGS: SyncSettings = {
  webhookUrl: 'https://example.invalid/hook?sig=FAKE',
  format: 'json',
  includeExternal: 'never',
  at: '03:00',
  local: true,
  localJob: { node: '/usr/bin/node', entry: '/opt/codemie/bin/codemie.js' },
};

let home: string;
beforeEach(() => {
  home = setUpHome();
  vi.resetModules();
});
afterEach(async () => {
  await tearDownHome(home);
});

const settingsPath = (): string => join(home, 'analytics-sync.json');
const writeSettings = (settings: unknown): void =>
  writeFileSync(settingsPath(), typeof settings === 'string' ? settings : JSON.stringify(settings));
const writeConfig = (config: unknown): void =>
  writeFileSync(join(home, 'codemie-cli.config.json'), typeof config === 'string' ? config : JSON.stringify(config));

async function sources(): Promise<{ ReportSource: unknown; OtlpFolderSource: unknown }> {
  const { ReportSource } = await import('../../../analytics/sync/report-builder.js');
  const { OtlpFolderSource } = await import('../../../analytics/sync/otlp-file-builder.js');
  return { ReportSource, OtlpFolderSource };
}

describe('resolveCollection', () => {
  it.each([
    ['no settings file', undefined, 'ReportSource'],
    ['settings with no local', { ...LOCAL_SETTINGS, local: undefined, localJob: undefined }, 'ReportSource'],
    ['settings with local: true', LOCAL_SETTINGS, 'OtlpFolderSource'],
    ['settings that are not JSON', '{not json', 'ReportSource'],
    ['settings with local: "yes"', { ...LOCAL_SETTINGS, local: 'yes' }, 'ReportSource'],
  ] as const)('%s → %s', async (_name, settings, expected) => {
    if (settings !== undefined) writeSettings(settings);
    const { resolveCollection } = await import('../resolve.js');
    const classes = await sources();

    expect((await resolveCollection()).exportSource()).toBeInstanceOf(classes[expected]);
  });

  it('a hook after the settings are removed gets the backend collection', async () => {
    writeSettings(LOCAL_SETTINGS);
    const { resolveCollection } = await import('../resolve.js');
    const { OtlpFolderSource, ReportSource } = await sources();
    expect((await resolveCollection()).exportSource()).toBeInstanceOf(OtlpFolderSource);

    unlinkSync(settingsPath());

    expect((await resolveCollection()).exportSource()).toBeInstanceOf(ReportSource);
  });
});

describe('resolveInstallCollection', () => {
  async function resolved(previous: SyncSettings | null): Promise<{ kind: string; note?: string }> {
    const { resolveInstallCollection } = await import('../resolve.js');
    const { OtlpFolderSource } = await sources();
    const { collection, note } = await resolveInstallCollection(previous);
    return { kind: collection.exportSource() instanceof (OtlpFolderSource as never) ? 'local' : 'backend', ...(note !== undefined && { note }) };
  }

  it('no CLI config → local', async () => {
    expect(await resolved(null)).toEqual({ kind: 'local' });
  });

  it('a config with no profile and an email → local', async () => {
    const { ConfigLoader } = await import('@/utils/config.js');
    await ConfigLoader.saveUserEmail('dev@example.com');

    expect(await resolved(null)).toEqual({ kind: 'local' });
  });

  it('a legacy single-provider config → backend, the note names its profile', async () => {
    writeConfig({ provider: 'openai', baseUrl: 'https://api.example.invalid', model: 'gpt' });

    expect(await resolved(null)).toEqual({
      kind: 'backend',
      note: 'Local analytics mode not turned on: this machine has a CodeMie CLI profile (default).',
    });
  });

  it('one profile → backend, the note names it', async () => {
    writeConfig({ version: 2, activeProfile: 'work', profiles: { work: { name: 'work', provider: 'ai-run-sso' } } });

    expect(await resolved(null)).toEqual({
      kind: 'backend',
      note: 'Local analytics mode not turned on: this machine has a CodeMie CLI profile (work).',
    });
  });

  it('a config file that does not parse → throws', async () => {
    writeConfig('{"version": 2,');
    const { resolveInstallCollection } = await import('../resolve.js');
    const { SyncConfigError } = await import('@/utils/errors.js');

    await expect(resolveInstallCollection(null)).rejects.toBeInstanceOf(SyncConfigError);
  });

  it('settings installed local, and a profile added since → local', async () => {
    writeConfig({ version: 2, activeProfile: 'work', profiles: { work: { name: 'work', provider: 'ai-run-sso' } } });

    expect(await resolved(LOCAL_SETTINGS)).toEqual({ kind: 'local' });
  });

  it('a connection record, a dead daemon\'s state with an upstream and an active connector, with no profile → local', async () => {
    writeFileSync(join(home, 'proxy-connection.json'), JSON.stringify({ version: 1, profile: 'work', updatedAt: '' }));
    writeFileSync(stateFile(home), JSON.stringify({
      pid: 999_999_999, port: 4001, url: 'http://127.0.0.1:4001', profile: 'work', gatewayKey: 'k',
      targetUrl: 'https://codemie.example.invalid', provider: 'ai-run-sso', startedAt: new Date().toISOString(),
    }));
    const { writeCopilotConnectorScope } = await import('@/agents/core/copilot-connector-scope.js');
    await writeCopilotConnectorScope('copilot-cli-otlp', { enabled: true, scope: 'user' });

    expect(await resolved(null)).toEqual({ kind: 'local' });
  });

  it('no profile and a live daemon with an upstream → backend, the note names the proxy', async () => {
    await writeLiveState(home, { port: 4321, targetUrl: 'https://codemie.example.invalid', provider: 'ai-run-sso', profile: 'p' });

    expect(await resolved(null)).toEqual({
      kind: 'backend',
      note: 'Local analytics mode not turned on: a CodeMie proxy is running on this machine (http://127.0.0.1:4321).',
    });
  });

  it('no profile and a live local daemon → local', async () => {
    await writeLiveState(home, { mode: 'local' });

    expect(await resolved(null)).toEqual({ kind: 'local' });
  });
});
