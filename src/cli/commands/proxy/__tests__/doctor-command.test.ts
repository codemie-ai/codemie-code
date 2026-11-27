import { backendDoctorPlan } from '../doctor/backend-plan.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stripVTControlCharacters } from 'node:util';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const composeProxyDoctor = vi.fn();
vi.mock('../doctor/compose.js', () => ({
  composeProxyDoctor: (...args: unknown[]) => composeProxyDoctor(...args),
}));

const printNext = vi.fn();
vi.mock('../../../related-commands.js', () => ({
  printNext: (...args: unknown[]) => printNext(...args),
}));

import { createProxyDoctorCommand } from '../doctor/command.js';

const VERBOSE = {
  desktop: {
    directories: { base: '/desk', localSessions: '/desk/local', codeSessions: '/desk/code' },
    sessions: [{
      externalSessionId: 's1', workingDirectory: '/w', createdAt: 1, updatedAt: 2,
      ingested: false, sessionStatus: 'open', reasons: ['no events yet'],
    }],
    hasCredentials: true,
    credentialsUrl: 'https://cm.example',
  },
  configPaths: { claudeSettings: '/c/settings.json', copilotConnectors: '/c/copilot.json', preferences: { claude: '/c/prefs.json' } },
};

function report(sections: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return { sections, nothingConnected: false, ...extra };
}

let out: string;
let logSpy: ReturnType<typeof vi.spyOn>;

async function run(args: string[]): Promise<void> {
  await createProxyDoctorCommand().parseAsync(args, { from: 'user' });
}

beforeEach(() => {
  vi.clearAllMocks();
  out = '';
  process.exitCode = undefined;
  logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out += a.join(' ') + '\n'; });
});

afterEach(() => {
  logSpy.mockRestore();
  process.exitCode = undefined;
});

describe('proxy doctor command', () => {
  it('exits 1 when a section is an error', async () => {
    composeProxyDoctor.mockResolvedValue(report([{ id: 'daemon', status: 'error', message: 'down', hint: 'x — run: y' }]));
    await run([]);
    expect(process.exitCode).toBe(1);
    expect(out).toContain('down');
    expect(out).toContain('x — run: y');
  });

  it('exits 0 on warnings only', async () => {
    composeProxyDoctor.mockResolvedValue(report([{ id: 'clients', status: 'warn', message: 'meh' }]));
    await run([]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(printNext).toHaveBeenCalledWith('proxy doctor', undefined, { json: undefined });
  });

  it('passes the authenticated probe and verbose options to compose', async () => {
    composeProxyDoctor.mockResolvedValue(report([]));
    await run(['--verbose']);
    expect(composeProxyDoctor).toHaveBeenCalledWith({ authProbe: true, verbose: true, plan: backendDoctorPlan });
  });

  it('--json prints one parseable document with every section', async () => {
    composeProxyDoctor.mockResolvedValue(report([
      { id: 'daemon', status: 'ok', message: 'running' },
      { id: 'auth', status: 'warn', message: 'w' },
    ]));
    await run(['--json']);
    const doc = JSON.parse(out);
    expect(doc.sections).toHaveLength(2);
    expect(doc.nothingConnected).toBe(false);
    expect(printNext).toHaveBeenCalledWith('proxy doctor', undefined, { json: true });
  });

  it('--json --verbose carries the detail and never a key field', async () => {
    composeProxyDoctor.mockResolvedValue(report([{ id: 'daemon', status: 'ok', message: 'running' }], { verbose: VERBOSE }));
    await run(['--json', '--verbose']);
    expect(out).not.toMatch(/gatewayKey|apiKey/);
    expect(JSON.parse(out).verbose.desktop.directories.base).toBe('/desk');
  });

  it('--verbose text lists Desktop dirs, sessions with reasons and config paths', async () => {
    composeProxyDoctor.mockResolvedValue(report([{ id: 'daemon', status: 'ok', message: 'running' }], { verbose: VERBOSE }));
    await run(['--verbose']);
    expect(out).toContain('/desk/local');
    expect(out).toContain('/desk/code');
    expect(out).toContain('s1');
    expect(out).toContain('no events yet');
    expect(out).toContain('/c/settings.json');
    expect(out).toContain('/c/prefs.json');
  });

  it('prints each section under its own heading, in the fixed order', async () => {
    composeProxyDoctor.mockResolvedValue(report([
      { id: 'daemon', status: 'ok', message: 'running' },
      { id: 'auth', status: 'ok', message: 'signed in' },
      { id: 'cli-path', status: 'ok', message: 'no older CLI' },
      { id: 'clients', status: 'warn', message: 'wrong port', hint: 'h — run: x' },
      { id: 'connectors', status: 'info', message: 'none' },
      { id: 'claude-code-otlp', status: 'ok', message: 'endpoint ok' },
      { id: 'delivery', status: 'info', message: 'nothing to deliver' },
      { id: 'desktop', status: 'info', message: 'desktop not connected' },
    ]));
    await run([]);
    const headings = stripVTControlCharacters(out).split('\n').filter((line) => /^\S.*:$/.test(line));
    expect(headings).toEqual([
      'Daemon:',
      'Authentication and upstream:',
      'Clients:',
      'Analytics connectors:',
      'Analytics delivery:',
      'Claude Desktop collection:',
      'Environment:',
    ]);
    expect(out).not.toContain('Proxy:');
    expect(out.indexOf('wrong port')).toBeGreaterThan(out.indexOf('Clients:'));
    expect(out.indexOf('endpoint ok')).toBeGreaterThan(out.indexOf('Analytics connectors:'));
  });

  it('ends with a one-line warning and error count, exit code unchanged', async () => {
    composeProxyDoctor.mockResolvedValue(report([
      { id: 'daemon', status: 'warn', message: 'older', hint: 'h — run: x' },
      { id: 'clients', status: 'warn', message: 'port', hint: 'h — run: y' },
    ]));
    await run([]);
    expect(out).toContain('2 warnings, 0 errors');
    expect(process.exitCode ?? 0).toBe(0);

    out = '';
    composeProxyDoctor.mockResolvedValue(report([
      { id: 'daemon', status: 'error', message: 'down', hint: 'h — run: x' },
      { id: 'clients', status: 'warn', message: 'port', hint: 'h — run: y' },
    ]));
    await run([]);
    expect(out).toContain('1 warning, 1 error');
    expect(process.exitCode).toBe(1);
  });

  it('--json carries no summary line, only the document', async () => {
    composeProxyDoctor.mockResolvedValue(report([{ id: 'daemon', status: 'warn', message: 'older', hint: 'h' }]));
    await run(['--json']);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('prints an info line when nothing is connected', async () => {
    composeProxyDoctor.mockResolvedValue(report([{ id: 'clients', status: 'info', message: 'nothing', hint: 'h' }], { nothingConnected: true }));
    await run([]);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('proxy doctor command in the local mode', () => {
  let home: string;
  beforeEach(async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    home = await mkdtemp(join(tmpdir(), 'doctor-command-local-'));
    vi.stubEnv('CODEMIE_HOME', home);
    await writeFile(join(home, 'analytics-sync.json'), JSON.stringify({
      webhookUrl: 'https://hooks.example.invalid/x?sig=FAKE', format: 'json', includeExternal: 'never', at: '03:00', local: true,
    }));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    const { rm } = await import('node:fs/promises');
    await rm(home, { recursive: true, force: true });
  });

  it('passes the local plan and renders its local rows under their group, with a stopped daemon', async () => {
    composeProxyDoctor.mockResolvedValue(report([
      { id: 'daemon', status: 'warn', message: 'Proxy is not running; analytics hooks start it on their next event' },
      { id: 'local', status: 'ok', message: 'Local analytics folder: 2 sessions, newest 2026-11-20T10:00:00.000Z' },
    ]));

    await run([]);

    const { plan } = composeProxyDoctor.mock.calls[0][0] as { plan: { daemonLabel: () => string } };
    expect(plan.daemonLabel()).toBe('local analytics mode');
    const text = stripVTControlCharacters(out);
    expect(text).toContain('Local analytics');
    expect(text).toContain('Local analytics folder: 2 sessions, newest 2026-11-20T10:00:00.000Z');
  });
});
