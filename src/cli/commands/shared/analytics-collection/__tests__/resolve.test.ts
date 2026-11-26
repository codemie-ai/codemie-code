/**
 * The rule of the three resolvers, on a home of its own: the sync settings decide `resolveCollection`; the settings
 * installed, the global CLI config and a live daemon with an upstream decide `resolveInstallCollection` and
 * `resolveUninstallCollection`, which takes the local collection past the border only on a trace of the local mode.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
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

async function sources(): Promise<{ ReportSource: unknown; LocalExportSource: unknown }> {
  const { ReportSource } = await import('../../../analytics/sync/report-builder.js');
  const { LocalExportSource } = await import('../local.js');
  return { ReportSource, LocalExportSource };
}

describe('resolveCollection', () => {
  it.each([
    ['no settings file', undefined, 'ReportSource'],
    ['settings with no local', { ...LOCAL_SETTINGS, local: undefined, localJob: undefined }, 'ReportSource'],
    ['settings with local: true', LOCAL_SETTINGS, 'LocalExportSource'],
    ['settings that are not JSON', '{not json', 'ReportSource'],
    ['settings with local: "yes"', { ...LOCAL_SETTINGS, local: 'yes' }, 'ReportSource'],
  ] as const)('$0 → $2', async (_name, settings, expected) => {
    if (settings !== undefined) writeSettings(settings);
    const { resolveCollection } = await import('../resolve.js');
    const classes = await sources();

    expect((await resolveCollection()).exportSource()).toBeInstanceOf(classes[expected]);
  });

  it('a hook after the settings are removed gets the backend collection', async () => {
    writeSettings(LOCAL_SETTINGS);
    const { resolveCollection } = await import('../resolve.js');
    const { LocalExportSource, ReportSource } = await sources();
    expect((await resolveCollection()).exportSource()).toBeInstanceOf(LocalExportSource);

    unlinkSync(settingsPath());

    expect((await resolveCollection()).exportSource()).toBeInstanceOf(ReportSource);
  });
});

describe('resolveInstallCollection', () => {
  async function resolved(previous: SyncSettings | null): Promise<{ kind: string; note?: string }> {
    const { resolveInstallCollection } = await import('../resolve.js');
    const { LocalExportSource } = await sources();
    const { collection, note } = await resolveInstallCollection(previous);
    return { kind: collection.exportSource() instanceof (LocalExportSource as never) ? 'local' : 'backend', ...(note !== undefined && { note }) };
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
      note:
        'Local analytics mode not turned on: this machine has a CodeMie CLI profile (default). To turn it on, delete the ' +
        'profile and run this command again.',
    });
  });

  it('one profile → backend, the note names it', async () => {
    writeConfig({ version: 2, activeProfile: 'work', profiles: { work: { name: 'work', provider: 'ai-run-sso' } } });

    expect(await resolved(null)).toEqual({
      kind: 'backend',
      note:
        'Local analytics mode not turned on: this machine has a CodeMie CLI profile (work). To turn it on, delete the ' +
        'profile and run this command again.',
    });
  });

  it('a config file that does not parse → throws, naming the file alone and nothing of its text', async () => {
    writeConfig('{"apiKey": "sk-SECRET1",');
    const { resolveInstallCollection } = await import('../resolve.js');
    const { SyncConfigError } = await import('@/utils/errors.js');

    const error = await resolveInstallCollection(null).then(() => undefined, (rejected: unknown) => rejected);

    expect(error).toBeInstanceOf(SyncConfigError);
    expect((error as Error).message).toBe(`The CodeMie CLI config at ${join(home, 'codemie-cli.config.json')} is not valid JSON.`);
    expect((error as Error).message).not.toContain('SECRET1');
  });

  /** The `SyncConfigError` `resolveInstallCollection` rejects with for `previous`. */
  async function refusal(previous: SyncSettings | null): Promise<Error> {
    const { resolveInstallCollection } = await import('../resolve.js');
    const { SyncConfigError } = await import('@/utils/errors.js');
    const error = await resolveInstallCollection(previous).then(() => undefined, (rejected: unknown) => rejected);
    expect(error).toBeInstanceOf(SyncConfigError);
    return error as Error;
  }

  it('settings installed local, and a profile added since → rejects, naming the profile and the uninstall', async () => {
    writeConfig({ version: 2, activeProfile: 'work', profiles: { work: { name: 'work', provider: 'ai-run-sso' } } });

    const { message } = await refusal(LOCAL_SETTINGS);

    expect(message).toBe(
      'This machine runs the local analytics mode and has a CodeMie CLI profile (work). Delete the profile, ' +
        'or run `codemie analytics sync uninstall` to leave the local mode.'
    );
    expect(message).not.toContain('proxy disconnect');
  });

  it('settings installed local and a live daemon with an upstream → rejects, naming the proxy and the uninstall', async () => {
    await writeLiveState(home, { port: 4321, targetUrl: 'https://codemie.example.invalid', provider: 'ai-run-sso', profile: 'p' });

    const { message } = await refusal(LOCAL_SETTINGS);

    expect(message).toBe(
      'This machine runs the local analytics mode and a CodeMie proxy is running on it (http://127.0.0.1:4321), started ' +
        "from a project's own CodeMie config. Delete that project's profile (run `codemie profile delete` in the project) " +
        'and stop the proxy (`codemie proxy stop`), or run `codemie analytics sync uninstall` to leave the local mode.'
    );
    expect(message).not.toContain('proxy disconnect');
  });

  it('settings installed local, no profile and a live local daemon → local', async () => {
    await writeLiveState(home, { mode: 'local' });

    expect(await resolved(LOCAL_SETTINGS)).toEqual({ kind: 'local' });
  });

  it('settings installed local and a CLI config that does not parse → rejects, naming the file', async () => {
    writeConfig('{ not json');

    expect((await refusal(LOCAL_SETTINGS)).message).toBe(
      `The CodeMie CLI config at ${join(home, 'codemie-cli.config.json')} is not valid JSON.`
    );
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
      note:
        'Local analytics mode not turned on: a CodeMie proxy is running on this machine (http://127.0.0.1:4321), started ' +
        "from a project's own CodeMie config. To turn it on, delete that project's profile (run `codemie profile delete` " +
        'in the project), stop the proxy (`codemie proxy stop`) and run this command again.',
    });
  });

  it('no profile and a live local daemon → local', async () => {
    await writeLiveState(home, { mode: 'local' });

    expect(await resolved(null)).toEqual({ kind: 'local' });
  });
});

describe('resolveUninstallCollection', () => {
  const BACKEND_SETTINGS = { ...LOCAL_SETTINGS, local: undefined, localJob: undefined };
  const PROFILE = { version: 2, activeProfile: 'work', profiles: { work: { name: 'work', provider: 'ai-run-sso' } } };
  const LEGACY = { provider: 'openai', baseUrl: 'https://api.example.invalid', model: 'gpt' };
  const UPSTREAM = { port: 4321, targetUrl: 'https://codemie.example.invalid', provider: 'ai-run-sso', profile: 'p' };

  type Trace = 'dead local state' | 'spool' | 'marks' | 'sessions';
  /** Stages a trace of the local mode, or the analytics folder (`sessions`), which is none. */
  function stageTrace(trace: Trace): void {
    if (trace === 'dead local state') {
      writeFileSync(stateFile(home), JSON.stringify({
        pid: 999_999_999, port: 4001, url: 'http://127.0.0.1:4001', profile: '', gatewayKey: 'k', mode: 'local',
        startedAt: new Date().toISOString(),
      }));
      return;
    }
    const dir = join(home, 'analytics', { spool: 'spool', marks: 'excluded', sessions: 'sessions' }[trace]);
    mkdirSync(dir, { recursive: true });
    if (trace === 'sessions') writeFileSync(join(dir, 's1.jsonl'), '{}\n');
  }

  it.each([
    ['no settings, no trace', undefined, undefined, undefined, undefined, 'backend'],
    ['settings {}, no trace', {}, undefined, undefined, undefined, 'backend'],
    ["a backend install's settings, no trace", BACKEND_SETTINGS, undefined, undefined, undefined, 'backend'],
    ['settings {} and a dead daemon\'s local state', {}, undefined, undefined, 'dead local state', 'local'],
    ['settings {} and the local spool', {}, undefined, undefined, 'spool', 'local'],
    ['settings {} and the exclusion marks', {}, undefined, undefined, 'marks', 'local'],
    ['no settings and the local spool', undefined, undefined, undefined, 'spool', 'local'],
    ['settings {} and a live local daemon', {}, undefined, { mode: 'local' }, undefined, 'local'],
    ['settings {}, the local spool and a profile', {}, PROFILE, undefined, 'spool', 'backend'],
    ["settings {}, the local spool and a legacy single-provider config", {}, LEGACY, undefined, 'spool', 'backend'],
    ['settings {}, the local spool and a live daemon with an upstream', {}, undefined, UPSTREAM, 'spool', 'backend'],
    ['settings {}, the local spool and a config that is not JSON', {}, '{ not json', undefined, 'spool', 'backend'],
    ['settings with local: true and a profile, no trace', LOCAL_SETTINGS, PROFILE, undefined, undefined, 'local'],
    ['settings that are not JSON', '{not json', undefined, undefined, undefined, 'backend'],
    ['settings {} and the analytics folder alone', {}, undefined, undefined, 'sessions', 'backend'],
  ] as const)('$0 → $5', async (_name, settings, config, daemon, trace, expected) => {
    if (settings !== undefined) writeSettings(settings);
    if (config !== undefined) writeConfig(config);
    if (daemon !== undefined) await writeLiveState(home, daemon);
    if (trace !== undefined) stageTrace(trace);
    const { resolveUninstallCollection } = await import('../resolve.js');
    const { LocalExportSource } = await sources();

    const collection = await resolveUninstallCollection();

    expect(collection.exportSource() instanceof (LocalExportSource as never) ? 'local' : 'backend').toBe(expected);
  });
});
