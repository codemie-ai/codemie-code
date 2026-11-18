import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
    expect(composeProxyDoctor).toHaveBeenCalledWith({ authProbe: true, verbose: true });
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

  it('prints an info line when nothing is connected', async () => {
    composeProxyDoctor.mockResolvedValue(report([{ id: 'clients', status: 'info', message: 'nothing', hint: 'h' }], { nothingConnected: true }));
    await run([]);
    expect(process.exitCode ?? 0).toBe(0);
  });
});
