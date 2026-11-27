/**
 * The local collection's own parts on a home of its own, with stand-in daemon processes: the hooks' policy, the
 * exported file, the guard of the proxy commands, `proxy start` / `restart`, the status line and the teardown.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawSessionData } from '../../../analytics/data-loader.js';
import type { CostSummary, SessionCostIndex } from '../../../analytics/cost/types.js';
import type { AnalyticsSource } from '../../../analytics/sources/types.js';
import type { SyncSettings } from '../../../analytics/sync/types.js';
import { dailyWindow } from '../../../analytics/sync/window.js';
import { isPidAlive, setUpHome, spawnedArgs, stateFile, tearDownHome, writeLiveState } from './stand.js';

vi.mock('@/utils/processes.js', async (importOriginal) => {
  const { isPidAlive: alive, standInSpawn: spawnStandIn } = await import('./stand.js');
  return {
    ...(await importOriginal<typeof import('@/utils/processes.js')>()),
    spawnDetached: vi.fn(spawnStandIn),
    // The start-time comparison runs `ps`: a live pid is the daemon.
    isOwnerAlive: vi.fn(async ({ pid }: { pid: number }) => alive(pid)),
    // No `codemie` on PATH: the hook commands name this build.
    getCommandPath: vi.fn(async () => null),
  };
});
/** A path whose removal fails, as a folder another process holds open would. */
const rmFailure = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (args[0] === rmFailure.path) throw Object.assign(new Error(`EBUSY: resource busy or locked, rm '${String(args[0])}'`), { code: 'EBUSY' });
      return actual.rm(...args);
    },
  };
});
vi.mock('@/utils/cli-updater.js', async (importOriginal) => {
  const { OWN_VERSION } = await import('./stand.js');
  return {
    ...(await importOriginal<typeof import('@/utils/cli-updater.js')>()),
    getCurrentCliVersion: vi.fn(async () => OWN_VERSION),
  };
});

const SETTINGS: SyncSettings = {
  webhookUrl: 'https://example.invalid/hook?sig=FAKE',
  format: 'json',
  includeExternal: 'never',
  at: '03:00',
  local: true,
  localJob: { node: '/usr/bin/node', entry: '/opt/codemie/bin/codemie.js' },
};
const REFUSAL =
  'This machine runs the local analytics mode of `codemie analytics sync`. Run `codemie analytics sync uninstall` first.';

let home: string;
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  home = setUpHome();
  vi.resetModules();
  vi.clearAllMocks();
  rmFailure.path = undefined;
  writeFileSync(join(home, 'analytics-sync.json'), JSON.stringify(SETTINGS));
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(async () => {
  log.mockRestore();
  await tearDownHome(home);
});

async function collection(settings: SyncSettings = SETTINGS) {
  return (await import('../local.js')).localCollection(settings);
}

const NOW = new Date('2026-10-29T12:00:00.000Z');
const EMAIL = 'Jane.Doe@x.com';
const OTLP_NAME = 'codemie-analytics-jane-doe-x-com-2026-10-29.otlp.jsonl.gz';
const REPORT_NAME = 'codemie-analytics-jane-doe-x-com-2026-10-29.report.json';

/** A session in the analytics folder, its file written a day before NOW. */
function folderSession(home: string, sessionId: string): void {
  const folder = join(home, 'analytics', 'sessions');
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${sessionId}.hooks.jsonl`);
  writeFileSync(file, `${JSON.stringify({ resourceLogs: [] })}\n`);
  const written = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
  utimesSync(file, written, written);
}

/** An analytics source holding `sessionIds` with their cost, so the report needs no client logs. */
function reportSessions(...sessionIds: string[]): AnalyticsSource {
  const rawSessions = sessionIds.map((sessionId) => ({
    sessionId,
    startEvent: { recordId: sessionId, type: 'session_start', timestamp: 1000, codeMieSessionId: sessionId, agentName: 'claude', syncStatus: 'synced', data: { provider: 'native', workingDirectory: '/repo', startTime: 1000 } },
    endEvent: { recordId: `${sessionId}-end`, type: 'session_end', timestamp: 2000, codeMieSessionId: sessionId, agentName: 'claude', syncStatus: 'synced', data: { endTime: 2000, duration: 1000, totalTurns: 1 } },
    deltas: [],
  })) as unknown as RawSessionData[];
  const index: SessionCostIndex = new Map(sessionIds.map((sessionId) => [sessionId, {
    sessionId,
    tokens: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0, total: 150 },
    costUSD: 0.01,
    perModel: [],
    priced: true,
    hadLog: true,
  }]));
  const summary: CostSummary = { totalCostUSD: 0.01 * sessionIds.length, pricedSessions: sessionIds.length, totalSessions: sessionIds.length, unpricedModels: [], estimatedModels: [], localModels: [] };
  return { load: async () => ({ rawSessions, ...(sessionIds.length > 0 && { cost: { index, summary } }) }) };
}

describe('LocalExportSource', () => {
  const input = () => ({ window: dailyWindow(NOW, null, 7), email: EMAIL, includeExternal: false, now: NOW });

  async function build(source: AnalyticsSource) {
    const { LocalExportSource } = await import('../local.js');
    const { OtlpFolderSource } = await import('../../../analytics/sync/otlp-file-builder.js');
    const { ReportSource } = await import('../../../analytics/sync/report-builder.js');
    return new LocalExportSource(new OtlpFolderSource(), new ReportSource(source)).build(input());
  }

  it('is the export source of the local collection', async () => {
    const { LocalExportSource } = await import('../local.js');
    expect((await collection()).exportSource()).toBeInstanceOf(LocalExportSource);
  });

  it('a folder session and a report session: the OTLP file, then the report ReportSource alone builds', async () => {
    folderSession(home, 's1');
    const { ReportSource } = await import('../../../analytics/sync/report-builder.js');
    const alone = await new ReportSource(reportSessions('r1')).build(input());

    const files = await build(reportSessions('r1'));

    expect(files?.map((file) => file.fileName)).toEqual([OTLP_NAME, REPORT_NAME]);
    expect(files?.[1].bytes.equals(alone![0].bytes)).toBe(true);
  });

  it('a report session alone: that one report', async () => {
    expect((await build(reportSessions('r1')))?.map((file) => file.fileName)).toEqual([REPORT_NAME]);
  });

  it('a folder session alone: the OTLP file alone', async () => {
    folderSession(home, 's1');
    expect((await build(reportSessions()))?.map((file) => file.fileName)).toEqual([OTLP_NAME]);
  });

  it('neither: null', async () => {
    expect(await build(reportSessions())).toBeNull();
  });

  it('the folder failing and a report session: the report alone, with a warning that names the failure', async () => {
    const { LocalExportSource } = await import('../local.js');
    const { ReportSource } = await import('../../../analytics/sync/report-builder.js');
    const failing = { build: async () => { throw new Error('cannot read s1.hooks.jsonl'); } };

    const files = await new LocalExportSource(failing, new ReportSource(reportSessions('r1'))).build(input());

    expect(files?.map((file) => file.fileName)).toEqual([REPORT_NAME]);
    expect(files?.warning).toBe('OTLP files not built, the marker stays and the next run tries them again: cannot read s1.hooks.jsonl');
  });

  it('the folder failing and no report session: the folder\'s error', async () => {
    const { LocalExportSource } = await import('../local.js');
    const { ReportSource } = await import('../../../analytics/sync/report-builder.js');
    const failing = { build: async () => { throw new Error('cannot read s1.hooks.jsonl'); } };

    await expect(new LocalExportSource(failing, new ReportSource(reportSessions())).build(input())).rejects.toThrow('cannot read s1.hooks.jsonl');
  });

  const failingReport = { build: async () => { throw new Error('cannot load the sessions'); } };

  it('the report failing and a folder session: the OTLP file alone, with a warning that names the failure', async () => {
    folderSession(home, 's1');
    const { LocalExportSource } = await import('../local.js');
    const { OtlpFolderSource } = await import('../../../analytics/sync/otlp-file-builder.js');

    const files = await new LocalExportSource(new OtlpFolderSource(), failingReport).build(input());

    expect(files?.map((file) => file.fileName)).toEqual([OTLP_NAME]);
    expect(files?.warning).toBe('JSON report not built, the marker stays and the next run tries it again: cannot load the sessions');
  });

  it('the report failing and no folder session: the report\'s error', async () => {
    const { LocalExportSource } = await import('../local.js');
    const { OtlpFolderSource } = await import('../../../analytics/sync/otlp-file-builder.js');

    await expect(new LocalExportSource(new OtlpFolderSource(), failingReport).build(input())).rejects.toThrow('cannot load the sessions');
  });

  it('both failing: the report\'s error', async () => {
    const { LocalExportSource } = await import('../local.js');
    const failingFolder = { build: async () => { throw new Error('cannot read s1.hooks.jsonl'); } };

    await expect(new LocalExportSource(failingFolder, failingReport).build(input())).rejects.toThrow('cannot load the sessions');
  });

  /** A folder source answering `files` with `fields` (`leftOut`, `warning`). */
  const answering = (files: string[], fields: { leftOut?: string; warning?: string }) => ({
    build: async () =>
      Object.assign(
        files.map((fileName) => ({ fileName, bytes: Buffer.from(fileName), contentType: 'application/gzip' })),
        fields
      ),
  });
  const leavingOut = (files: string[], leftOut: string) => answering(files, { leftOut });

  it('the folder leaving sessions out and a report session: both files, leftOut carried, no warning', async () => {
    const { LocalExportSource } = await import('../local.js');
    const { ReportSource } = await import('../../../analytics/sync/report-builder.js');

    const files = await new LocalExportSource(leavingOut([OTLP_NAME], 'X'), new ReportSource(reportSessions('r1'))).build(input());

    expect(files?.map((file) => file.fileName)).toEqual([OTLP_NAME, REPORT_NAME]);
    expect(files?.leftOut).toBe('X');
    expect(files?.warning).toBeUndefined();
  });

  it('the folder leaving sessions out with no file and no report session: an empty list with leftOut', async () => {
    const { LocalExportSource } = await import('../local.js');
    const { ReportSource } = await import('../../../analytics/sync/report-builder.js');

    const files = await new LocalExportSource(leavingOut([], 'X'), new ReportSource(reportSessions())).build(input());

    expect(files).toHaveLength(0);
    expect(files?.leftOut).toBe('X');
  });

  it('the folder leaving sessions out and the report failing: the folder\'s files with the warning and leftOut', async () => {
    const { LocalExportSource } = await import('../local.js');

    const files = await new LocalExportSource(leavingOut([OTLP_NAME], 'X'), failingReport).build(input());

    expect(files?.map((file) => file.fileName)).toEqual([OTLP_NAME]);
    expect(files?.warning).toBe('JSON report not built, the marker stays and the next run tries it again: cannot load the sessions');
    expect(files?.leftOut).toBe('X');
  });

  it('the folder with a warning and a report session: both files, the folder\'s warning carried', async () => {
    const { LocalExportSource } = await import('../local.js');
    const { ReportSource } = await import('../../../analytics/sync/report-builder.js');

    const files = await new LocalExportSource(answering([OTLP_NAME], { warning: 'W' }), new ReportSource(reportSessions('r1'))).build(input());

    expect(files?.map((file) => file.fileName)).toEqual([OTLP_NAME, REPORT_NAME]);
    expect(files?.warning).toBe('W');
    expect(files?.leftOut).toBeUndefined();
  });

  it('the folder with a warning and leftOut and the report failing: the folder\'s file, both warnings joined, leftOut carried', async () => {
    const { LocalExportSource } = await import('../local.js');
    const boom = { build: async () => { throw new Error('boom'); } };

    const files = await new LocalExportSource(answering([OTLP_NAME], { warning: 'W', leftOut: 'X' }), boom).build(input());

    expect(files?.map((file) => file.fileName)).toEqual([OTLP_NAME]);
    expect(files?.warning).toBe('W; JSON report not built, the marker stays and the next run tries it again: boom');
    expect(files?.leftOut).toBe('X');
  });

  it('the folder with a warning and no file, no report session: an empty list with the warning', async () => {
    const { LocalExportSource } = await import('../local.js');
    const { ReportSource } = await import('../../../analytics/sync/report-builder.js');

    const files = await new LocalExportSource(answering([], { warning: 'W' }), new ReportSource(reportSessions())).build(input());

    expect(files).toHaveLength(0);
    expect(files?.warning).toBe('W');
  });
});

describe('localCollection', () => {
  it('collects under LocalPolicy built from the --include-external answer of this platform', async () => {
    const { LocalPolicy } = await import('../local-policy.js');
    const gate = async (): Promise<'continue' | 'stop'> => 'continue';
    const always = (await collection({ ...SETTINGS, includeExternal: 'always' })).hookPolicy();
    const never = (await collection({ ...SETTINGS, includeExternal: 'never' })).hookPolicy();

    expect(always).toBeInstanceOf(LocalPolicy);
    expect(await always.admit('s-1', gate)).toBe('continue');
    expect(await never.admit('s-1', gate)).toBe('stop');
  });

  it('prints the mode as the status line of sync status, naming the analytics folder under CODEMIE_HOME', async () => {
    expect((await collection()).statusLines()).toEqual([
      `Mode: local — delivers the OTLP files of ${join(home, 'analytics', 'sessions')} beside the JSON report`,
    ]);
  });

  it('its doctor plan names the local next steps, no status lines, no keyed probe and the mode as the daemon label', async () => {
    const { doctor } = await collection();
    const state = { pid: 1, port: 4001, url: 'http://127.0.0.1:4001', profile: '', gatewayKey: 'codemie-proxy', mode: 'local' as const, startedAt: '2026-11-22T00:00:00.000Z' };
    const steps = ['codemie proxy start', 'codemie analytics sync status', 'codemie proxy doctor'];

    expect(doctor.nextSteps('stop')).toEqual(steps);
    expect(doctor.nextSteps('status')).toEqual(steps);
    expect(doctor.statusLines(state)).toEqual([]);
    expect(doctor.authProbe(true)).toBe(false);
    expect(doctor.daemonLabel(state)).toBe('local analytics mode');
  });

  it.each(['connect', 'disconnect'] as const)('refuses proxy %s, naming sync uninstall', async (name) => {
    const { ConfigurationError } = await import('@/utils/errors.js');
    const local = await collection();

    expect(() => local.guardProxyCommand(name)).toThrow(ConfigurationError);
    expect(() => local.guardProxyCommand(name)).toThrow(REFUSAL);
  });
});

describe('localCollection.daemon', () => {
  it('start with no daemon spawns the local one on the port given and prints its URL', async () => {
    await (await collection()).daemon.start({ port: '4555' });

    expect(await spawnedArgs()).toEqual([['--mode', 'local', '--gateway-key', 'codemie-proxy', '--state-file', stateFile(home), '--port', '4555']]);
    expect(log).toHaveBeenCalledWith('The local analytics proxy is running on http://127.0.0.1:4555.');
  });

  it('start with a live local daemon spawns nothing and prints its URL', async () => {
    await writeLiveState(home, { mode: 'local', port: 4002 });

    await (await collection()).daemon.start({});

    expect(await spawnedArgs()).toEqual([]);
    expect(log).toHaveBeenCalledWith('The local analytics proxy is running on http://127.0.0.1:4002.');
  });

  it('restart stops the live daemon and starts the local one on its port', async () => {
    const old = await writeLiveState(home, { mode: 'local', port: 4777 });

    await (await collection()).daemon.restart({});

    expect(isPidAlive(old)).toBe(false);
    expect(await spawnedArgs()).toEqual([['--mode', 'local', '--gateway-key', 'codemie-proxy', '--state-file', stateFile(home), '--port', '4777']]);
    expect(log).toHaveBeenCalledWith('The local analytics proxy is running on http://127.0.0.1:4777.');
  });

  it.each([
    ['start', (local: Awaited<ReturnType<typeof collection>>) => local.daemon.start({ profile: 'work' })],
    ['restart', (local: Awaited<ReturnType<typeof collection>>) => local.daemon.restart({ profile: 'work' })],
  ] as const)('%s with a --profile is refused and starts or stops nothing', async (_name, run) => {
    const running = await writeLiveState(home, { mode: 'local' });

    await expect(run(await collection())).rejects.toThrow(REFUSAL);
    expect(await spawnedArgs()).toEqual([]);
    expect(isPidAlive(running)).toBe(true);
  });
});

describe('localCollection.teardown', () => {
  async function wireClients(): Promise<void> {
    const { writeClaudeCodeOtlpConfig } = await import('../../../proxy/connectors/claude-code-otlp.js');
    const { writeCopilotCliOtlpConfig } = await import('../../../proxy/connectors/copilot-cli-otlp.js');
    await writeClaudeCodeOtlpConfig({ promptStatus: null, keepProjectList: true });
    await writeCopilotCliOtlpConfig({ keepProjectList: true });
  }

  it('removes the hooks, then under the daemon lock stops the local daemon, resolves the moves, removes the spool, the install and the marks last', async () => {
    const daemon = await writeLiveState(home, { mode: 'local' });
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));
    await wireClients();
    const folder = join(home, 'analytics', 'sessions');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 's1.hooks.jsonl'), 'abc\ndef\n');
    writeFileSync(join(folder, 's1.moving'), JSON.stringify({
      lengths: { 's1.hooks.jsonl': 4 },
      from: { hooks: 0, logsJson: 0, metricsJson: 0, tracesJson: 0 },
      upto: { hooks: 0, logsJson: 0, metricsJson: 0, tracesJson: 0 },
      nowMs: 0,
    }));
    mkdirSync(join(home, 'analytics', 'spool'), { recursive: true });
    writeFileSync(join(home, 'analytics', 'spool', 's1.hooks.ndjson'), 'x\n');
    mkdirSync(join(home, 'analytics', 'excluded'), { recursive: true });
    writeFileSync(join(home, 'analytics', 'excluded', 's2'), '');
    const { hasClaudeCodeOtlpHooks } = await import('../../../proxy/connectors/claude-code-otlp.js');
    const { readCopilotConnectorScope } = await import('@/agents/core/copilot-connector-scope.js');
    const local = await collection();
    const atRemoval: Record<string, unknown> = {};
    let launched: Promise<void> | undefined;
    const { isOwnerAlive } = await import('@/utils/processes.js');
    let parked!: () => void;
    const hookParked = new Promise<void>((resolve) => {
      parked = resolve;
    });
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    await local.teardown(async () => {
      Object.assign(atRemoval, {
        lockHeld: existsSync(join(home, 'proxy-daemon.lock')),
        daemonAlive: isPidAlive(daemon),
        claudeHooks: await hasClaudeCodeOtlpHooks(),
        copilotCliScope: await readCopilotConnectorScope('copilot-cli-otlp'),
        marker: existsSync(join(folder, 's1.moving')),
        folderFile: readFileSync(join(folder, 's1.hooks.jsonl'), 'utf-8'),
        spool: existsSync(join(home, 'analytics', 'spool')),
        excluded: existsSync(join(home, 'analytics', 'excluded')),
      });
      // A hook between the stop and the removal waits for the lock, then finds no settings. Its wait is held in the
      // judgement of the lock's holder, after its read of the lock file has closed, until the lock is released: no
      // handle of this process is open on the lock file when the release removes it.
      vi.mocked(isOwnerAlive).mockImplementation(async ({ pid }) => {
        if (pid !== process.pid) return isPidAlive(pid);
        parked();
        await gate;
        return true;
      });
      launched = local.launcher('claude-code-otlp', 'Stop');
      await hookParked;
      const { unlinkSync } = await import('node:fs');
      unlinkSync(join(home, 'analytics-sync.json'));
    });
    openGate();
    await launched;

    expect(atRemoval).toEqual({
      lockHeld: true,
      daemonAlive: false,
      claudeHooks: false,
      copilotCliScope: { kind: 'ok', value: { enabled: false } },
      marker: false,
      folderFile: 'abc\n',
      spool: false,
      excluded: true,
    });
    expect(existsSync(join(home, 'analytics', 'excluded'))).toBe(false);
    expect(await spawnedArgs()).toEqual([]);
    expect(existsSync(join(folder, 's1.hooks.jsonl'))).toBe(true);
    const claude = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
    expect(claude.model).toBe('opus');
    expect(claude.env ?? {}).not.toHaveProperty('CLAUDE_CODE_ENABLE_TELEMETRY');
    expect(claude.env ?? {}).not.toHaveProperty('OTEL_LOGS_EXPORTER');
    expect(claude.env ?? {}).not.toHaveProperty('OTEL_EXPORTER_OTLP_ENDPOINT');
  });

  it("removes CodeMie's own telemetry env left after Claude Code's hooks were removed by hand", async () => {
    const claudeDir = join(home, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      model: 'opus',
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4001/v1/analytics/otlp',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer codemie-proxy',
        OTEL_LOGS_EXPORTER: 'otlp',
      },
    }, null, 2));

    await (await collection()).teardown(async () => undefined);

    const claude = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));
    expect(claude.model).toBe('opus');
    expect(claude).not.toHaveProperty('env');
  });

  it('leaves Claude Code settings with no CodeMie hook byte for byte, and their backup in place', async () => {
    const claudeDir = join(home, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const own = JSON.stringify({
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.invalid',
      },
    }, null, 2);
    writeFileSync(join(claudeDir, 'settings.json'), own);
    writeFileSync(join(claudeDir, 'settings.json.codemie-backup'), '{}');

    await (await collection()).teardown(async () => undefined);

    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf-8')).toBe(own);
    expect(existsSync(join(claudeDir, 'settings.json.codemie-backup'))).toBe(true);
  });

  it("leaves byte for byte Claude Code settings with a pair of CodeMie's shape on another host and no CodeMie hook", async () => {
    const claudeDir = join(home, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const own = JSON.stringify({
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://analytics.example.invalid/v1/analytics/otlp',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer user-own-token',
        USER_OWN_KEY: 'kept',
      },
    }, null, 2);
    writeFileSync(join(claudeDir, 'settings.json'), own);

    await (await collection()).teardown(async () => undefined);

    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf-8')).toBe(own);
  });

  it('writes no Copilot scope record on a home that has none', async () => {
    await (await collection()).teardown(async () => undefined);

    expect(existsSync(join(home, 'copilot-connectors.json'))).toBe(false);
  });

  it('removes the Copilot CLI hook file when its scope record is gone', async () => {
    const { getCopilotCliHookFilePath, writeCopilotCliOtlpConfig } = await import('../../../proxy/connectors/copilot-cli-otlp.js');
    const { getCopilotConnectorsConfigPath } = await import('@/agents/core/copilot-connector-scope.js');
    await writeCopilotCliOtlpConfig({ keepProjectList: true });
    rmSync(getCopilotConnectorsConfigPath());

    await (await collection()).teardown(async () => undefined);

    expect(existsSync(getCopilotCliHookFilePath())).toBe(false);
  });

  it('removes the Copilot CLI hook file over a scope record that is not JSON, fails on that record, and a second run goes through', async () => {
    const { getCopilotCliHookFilePath, writeCopilotCliOtlpConfig } = await import('../../../proxy/connectors/copilot-cli-otlp.js');
    const { getCopilotConnectorsConfigPath } = await import('@/agents/core/copilot-connector-scope.js');
    await writeCopilotCliOtlpConfig({ keepProjectList: true });
    writeFileSync(getCopilotConnectorsConfigPath(), '{ not json');
    let removedInstall = false;
    const removeInstall = async (): Promise<void> => {
      removedInstall = true;
    };
    const local = await collection();

    await expect(local.teardown(removeInstall)).rejects.toThrow(
      `Copilot connector config is corrupt and was not changed: ${getCopilotConnectorsConfigPath()}`
    );
    expect(existsSync(getCopilotCliHookFilePath())).toBe(false);
    expect(removedInstall).toBe(false);

    await local.teardown(removeInstall);
    expect(removedInstall).toBe(true);
  });

  it('removes the CodeMie key of chat.hookFilesLocations when the Copilot Chat scope record is gone', async () => {
    const { getCopilotChatHookFilePath, getVsCodeChatSettingsPath, writeCopilotChatOtlpConfig } = await import(
      '../../../proxy/connectors/copilot-chat-otlp.js'
    );
    const { getCopilotConnectorsConfigPath } = await import('@/agents/core/copilot-connector-scope.js');
    await writeCopilotChatOtlpConfig({ keepProjectList: true });
    rmSync(getCopilotConnectorsConfigPath());
    rmSync(getCopilotChatHookFilePath());

    await (await collection()).teardown(async () => undefined);

    const settings = JSON.parse(readFileSync(getVsCodeChatSettingsPath(), 'utf-8')) as Record<string, unknown>;
    expect(settings['chat.hookFilesLocations']).toBeUndefined();
  });

  it('removes the Copilot Chat hook file an install that skipped Copilot Chat left, and a second run takes nothing', async () => {
    const { getCopilotChatHookFilePath, getVsCodeChatSettingsPath } = await import(
      '../../../proxy/connectors/copilot-chat-otlp.js'
    );
    const { writeCopilotConnectorScope } = await import('@/agents/core/copilot-connector-scope.js');
    const hookFile = getCopilotChatHookFilePath();
    mkdirSync(join(hookFile, '..'), { recursive: true });
    writeFileSync(hookFile, JSON.stringify({ hooks: { SessionStart: [{ type: 'command', command: 'codemie hook' }] } }));
    await writeCopilotConnectorScope('copilot-chat-otlp', { enabled: false });
    mkdirSync(join(getVsCodeChatSettingsPath(), '..'), { recursive: true });
    writeFileSync(getVsCodeChatSettingsPath(), '{}');
    const local = await collection();

    expect(await local.teardown(async () => undefined)).toBe(true);
    expect(existsSync(hookFile)).toBe(false);

    expect(await local.teardown(async () => undefined)).toBe(false);
  });

  /** A live local daemon, a session in the local spool and an exclusion mark. */
  async function localLeftovers(): Promise<number> {
    const daemon = await writeLiveState(home, { mode: 'local' });
    mkdirSync(join(home, 'analytics', 'spool'), { recursive: true });
    writeFileSync(join(home, 'analytics', 'spool', 's1.hooks.ndjson'), 'x\n');
    mkdirSync(join(home, 'analytics', 'excluded'), { recursive: true });
    writeFileSync(join(home, 'analytics', 'excluded', 's2'), '');
    return daemon;
  }

  it('rejects on Claude Code settings that do not parse, before the daemon lock: the daemon, the spool, the marks and the settings stay', async () => {
    const daemon = await localLeftovers();
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '{ not json');
    const { ConfigurationError } = await import('@/utils/errors.js');
    const removeInstall = vi.fn(async () => undefined);

    await expect((await collection()).teardown(removeInstall)).rejects.toThrow(ConfigurationError);

    expect(isPidAlive(daemon)).toBe(true);
    expect(existsSync(join(home, 'analytics', 'spool', 's1.hooks.ndjson'))).toBe(true);
    expect(existsSync(join(home, 'analytics', 'excluded', 's2'))).toBe(true);
    expect(existsSync(join(home, 'analytics-sync.json'))).toBe(true);
    expect(removeInstall).not.toHaveBeenCalled();
  });

  it('keeps the marks when the removal throws, the spool gone, and a second run removes them', async () => {
    await localLeftovers();
    const local = await collection();

    await expect(local.teardown(async () => {
      throw new Error('job not removed');
    })).rejects.toThrow('job not removed');

    expect(existsSync(join(home, 'analytics', 'excluded', 's2'))).toBe(true);
    expect(existsSync(join(home, 'analytics', 'spool'))).toBe(false);

    await local.teardown(async () => undefined);
    expect(existsSync(join(home, 'analytics', 'excluded'))).toBe(false);
  });

  it('resolves when the marks cannot be removed after the removal ran', async () => {
    await localLeftovers();
    rmFailure.path = join(home, 'analytics', 'excluded');
    const removeInstall = vi.fn(async () => undefined);

    await expect((await collection()).teardown(removeInstall)).resolves.toBe(true);

    expect(removeInstall).toHaveBeenCalledOnce();
    expect(existsSync(join(home, 'analytics', 'excluded', 's2'))).toBe(true);
  });

  it.each([
    [
      "Claude Code's entries",
      async () => {
        // The entries name a running daemon's port; that daemon's state is gone before the teardown.
        await writeLiveState(home, { mode: 'local' });
        mkdirSync(join(home, '.claude'), { recursive: true });
        const { writeClaudeCodeOtlpConfig } = await import('../../../proxy/connectors/claude-code-otlp.js');
        await writeClaudeCodeOtlpConfig({ promptStatus: null, keepProjectList: true });
        rmSync(stateFile(home));
      },
    ],
    ['a live local daemon', async () => void (await writeLiveState(home, { mode: 'local' }))],
    ['the local spool', async () => mkdirSync(join(home, 'analytics', 'spool'), { recursive: true })],
    ['the exclusion marks', async () => mkdirSync(join(home, 'analytics', 'excluded'), { recursive: true })],
  ])('says it took something away when it removed %s', async (_name, stage) => {
    await stage();

    expect(await (await collection()).teardown(async () => undefined)).toBe(true);
  });

  it('says it took nothing away on a home with no entries, no local daemon, no spool and no marks', async () => {
    expect(await (await collection()).teardown(async () => undefined)).toBe(false);
  });

  it('leaves a live daemon that is not the local one running', async () => {
    const backend = await writeLiveState(home, { profile: 'work', targetUrl: 'https://codemie.example.invalid', provider: 'ai-run-sso' });
    const removeInstall = vi.fn(async () => undefined);

    await (await collection()).teardown(removeInstall);

    expect(isPidAlive(backend)).toBe(true);
    expect(removeInstall).toHaveBeenCalledOnce();
  });
});
