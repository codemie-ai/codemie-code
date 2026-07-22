/**
 * DaemonManager state file utilities tests
 * @group unit
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';

// Override state file path before importing
const TEST_STATE_FILE = join(tmpdir(), `codemie-proxy-daemon-test-${Date.now()}.json`);
const DEFAULT_TEST_STATE_FILE = join(tmpdir(), 'proxy-daemon.json');
vi.mock('../../../../utils/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../utils/paths.js')>();
  return {
    ...actual,
    getCodemieHome: () => tmpdir(),
    getDirname: () => tmpdir(),
    resolveHomeDir: (p: string) => p,
  };
});

vi.mock('../../../../utils/processes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../utils/processes.js')>();
  return {
    ...actual,
    spawnDetached: vi.fn(),
  };
});

import { spawnDetached } from '../../../../utils/processes.js';

import {
  readState,
  writeState,
  clearState,
  isProcessAlive,
  checkStatus,
  spawnDaemon,
  type DaemonState,
} from '../daemon-manager.js';

const SAMPLE_STATE: DaemonState = {
  pid: process.pid,
  port: 4001,
  url: 'http://localhost:4001',
  profile: 'default',
  gatewayKey: 'codemie-proxy',
  startedAt: new Date().toISOString(),
};

describe('readState', () => {
  afterEach(async () => { try { await unlink(TEST_STATE_FILE); } catch { /* ignore */ } });

  it('returns null when state file does not exist', async () => {
    expect(await readState(TEST_STATE_FILE)).toBeNull();
  });

  it('returns parsed state when file exists', async () => {
    await writeFile(TEST_STATE_FILE, JSON.stringify(SAMPLE_STATE), 'utf-8');
    const state = await readState(TEST_STATE_FILE);
    expect(state?.pid).toBe(SAMPLE_STATE.pid);
    expect(state?.url).toBe(SAMPLE_STATE.url);
  });

  it('reads old daemon state files without new optional fields', async () => {
    await writeFile(TEST_STATE_FILE, JSON.stringify(SAMPLE_STATE), 'utf-8');

    const state = await readState(TEST_STATE_FILE);

    expect(state).toMatchObject(SAMPLE_STATE);
    expect(state?.model).toBeUndefined();
    expect(state?.enforceProfileModel).toBeUndefined();
    expect(state?.clientType).toBeUndefined();
  });
});

describe('writeState', () => {
  afterEach(async () => { try { await unlink(TEST_STATE_FILE); } catch { /* ignore */ } });

  it('writes state atomically (file is readable immediately after)', async () => {
    await writeState(SAMPLE_STATE, TEST_STATE_FILE);
    expect(existsSync(TEST_STATE_FILE)).toBe(true);
    const state = await readState(TEST_STATE_FILE);
    expect(state?.port).toBe(4001);
  });

  it('does not leave a .tmp file behind', async () => {
    await writeState(SAMPLE_STATE, TEST_STATE_FILE);
    expect(existsSync(TEST_STATE_FILE + '.tmp')).toBe(false);
  });
});

describe('clearState', () => {
  it('removes the state file if it exists', async () => {
    await writeFile(TEST_STATE_FILE, '{}', 'utf-8');
    await clearState(TEST_STATE_FILE);
    expect(existsSync(TEST_STATE_FILE)).toBe(false);
  });

  it('does not throw when file does not exist', async () => {
    await expect(clearState(TEST_STATE_FILE)).resolves.not.toThrow();
  });
});

describe('isProcessAlive', () => {
  it('returns true for current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('returns false for non-existent PID', () => {
    expect(isProcessAlive(9999999)).toBe(false);
  });
});

describe('checkStatus', () => {
  afterEach(async () => { try { await unlink(TEST_STATE_FILE); } catch { /* ignore */ } });

  it('returns running=false when no state file', async () => {
    const { running } = await checkStatus(TEST_STATE_FILE);
    expect(running).toBe(false);
  });

  it('returns running=true when state file has alive PID', async () => {
    await writeState({ ...SAMPLE_STATE, pid: process.pid }, TEST_STATE_FILE);
    const { running, state } = await checkStatus(TEST_STATE_FILE);
    expect(running).toBe(true);
    expect(state?.pid).toBe(process.pid);
  });

  it('returns running=false and cleans stale state when PID is dead', async () => {
    await writeState({ ...SAMPLE_STATE, pid: 9999999 }, TEST_STATE_FILE);
    const { running } = await checkStatus(TEST_STATE_FILE);
    expect(running).toBe(false);
    expect(existsSync(TEST_STATE_FILE)).toBe(false);
  });
});

describe('spawnDaemon', () => {
  afterEach(async () => {
    vi.clearAllMocks();
    try { await unlink(DEFAULT_TEST_STATE_FILE); } catch { /* ignore */ }
  });

  function arrangeReadyDaemon(): void {
    vi.mocked(spawnDetached).mockImplementation(() => {
      void writeFile(DEFAULT_TEST_STATE_FILE, JSON.stringify(SAMPLE_STATE), 'utf-8');
      return SAMPLE_STATE.pid;
    });
  }

  it('passes the pinned model, enforcement flag, and client type to the daemon', async () => {
    arrangeReadyDaemon();

    await spawnDaemon({
      targetUrl: 'https://upstream.example.com',
      provider: 'ai-run-sso',
      profile: 'work',
      port: 4001,
      model: 'profile-model-id',
      enforceProfileModel: true,
      clientType: 'vscode-byok',
    });

    const args = vi.mocked(spawnDetached).mock.calls[0][1];
    expect(args).toEqual(expect.arrayContaining([
      '--model', 'profile-model-id',
      '--enforce-profile-model',
      '--client-type', 'vscode-byok',
    ]));
  });

  it('keeps existing daemon arguments unchanged when profile-model mode is absent', async () => {
    arrangeReadyDaemon();

    await spawnDaemon({
      targetUrl: 'https://upstream.example.com',
      provider: 'ai-run-sso',
      profile: 'work',
      port: 4001,
    });

    const args = vi.mocked(spawnDetached).mock.calls[0][1];
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--enforce-profile-model');
    expect(args).not.toContain('--client-type');
  });
});
