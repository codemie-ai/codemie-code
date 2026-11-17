/**
 * `proxy inspect desktop` reasons, over Desktop sessions laid out in a temporary home
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getClaudeDesktopLocalSessionsRoot } from '@/telemetry/clients/claude-desktop/claude-desktop.paths.js';
import type { DaemonState } from '../daemon-manager.js';
import { inspectDesktopProxy, printDesktopInspection } from '../inspect-desktop.js';

const CONNECTED_AT = '2026-11-16T10:00:00.000Z';
const BEFORE = Date.parse('2026-11-16T09:00:00.000Z');
const AFTER = Date.parse('2026-11-16T11:00:00.000Z');

describe('proxy inspect desktop', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'inspect-desktop-home-'));
    for (const name of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']) vi.stubEnv(name, home);
    vi.stubEnv('CODEMIE_HOME', join(home, '.codemie'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  /** A never-synced Desktop session created at `createdAt`, with its audit transcript. */
  async function desktopSession(id: string, createdAt: number): Promise<void> {
    const dir = join(getClaudeDesktopLocalSessionsRoot(), 'account', 'org');
    await mkdir(join(dir, `local_${id}`), { recursive: true });
    await writeFile(join(dir, `local_${id}`, 'audit.jsonl'), '');
    await writeFile(join(dir, `local_${id}.json`), JSON.stringify({
      sessionId: `local_${id}`,
      cliSessionId: `cli-${id}`,
      createdAt,
      lastActivityAt: createdAt,
      cwd: home,
    }));
  }

  function state(fields: Partial<DaemonState>): DaemonState {
    return {
      pid: process.pid,
      port: 4001,
      url: 'http://127.0.0.1:4001',
      profile: 'work',
      gatewayKey: 'codemie-proxy',
      startedAt: '2026-11-16T08:00:00.000Z',
      ...fields,
    };
  }

  async function reasonsBySession(daemonState: DaemonState): Promise<Record<string, string[]>> {
    const result = await inspectDesktopProxy(true, daemonState);
    return Object.fromEntries(result.sessions.map((session) => [session.discovered.externalSessionId, session.reasons]));
  }

  it('names a never-synced session created before Desktop connected, and none created after', async () => {
    await desktopSession('before', BEFORE);
    await desktopSession('after', AFTER);

    expect(await reasonsBySession(state({ version: '0.17.0', desktopConnectedSince: CONNECTED_AT }))).toEqual({
      local_before: ['session-created-before-desktop-connected'],
      local_after: [],
    });
  });

  it('says desktop-not-connected for a daemon with a version that has not noticed Desktop', async () => {
    await desktopSession('after', AFTER);

    expect(await reasonsBySession(state({ version: '0.17.0' }))).toEqual({ local_after: ['desktop-not-connected'] });
  });

  it('says daemon-of-older-cli alone for a daemon whose state has no version', async () => {
    await desktopSession('before', BEFORE);
    const older = { ...state({}), telemetryMode: 'claude-desktop', clientType: 'claude-desktop' } as DaemonState;

    expect(await reasonsBySession(older)).toEqual({ local_before: ['daemon-of-older-cli'] });
  });

  it('prints neither a telemetry mode nor a daemon client type', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => { lines.push(String(line)); });

    await printDesktopInspection(true, state({ version: '0.17.0', clientType: 'claude-desktop' } as Partial<DaemonState>));

    expect(lines.some((line) => line.startsWith('Telemetry mode:'))).toBe(false);
    expect(lines.some((line) => line.startsWith('Daemon clientType:'))).toBe(false);
    expect(lines.some((line) => line.startsWith('Daemon running:'))).toBe(true);
  });
});
