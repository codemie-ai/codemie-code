/**
 * Codebase Memory UI daemon state tests
 * @group unit
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlink, writeFile } from 'fs/promises';

const TEST_STATE_FILE = join(tmpdir(), `codemie-codebase-ui-test-${Date.now()}.json`);

vi.mock('../../../../utils/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../utils/paths.js')>();
  return {
    ...actual,
    getCodemieHome: () => tmpdir(),
    getDirname: () => tmpdir(),
  };
});

vi.mock('../../../../utils/processes.js', () => ({
  spawnDetached: vi.fn(() => process.pid),
}));

import {
  checkCodebaseUiStatus,
  clearCodebaseUiState,
  isPortAvailable,
  readCodebaseUiState,
  spawnCodebaseUi,
  writeCodebaseUiState,
  type CodebaseUiState,
} from '../daemon-manager.js';

const SAMPLE_STATE: CodebaseUiState = {
  pid: process.pid,
  port: 9749,
  url: 'http://localhost:9749',
  startedAt: new Date().toISOString(),
};

describe('Codebase Memory UI daemon manager', () => {
  afterEach(async () => {
    try {
      await unlink(TEST_STATE_FILE);
    } catch {
      // ignore
    }
  });

  it('writes and reads UI state', async () => {
    await writeCodebaseUiState(SAMPLE_STATE, TEST_STATE_FILE);

    expect(existsSync(TEST_STATE_FILE)).toBe(true);
    await expect(readCodebaseUiState(TEST_STATE_FILE)).resolves.toMatchObject({
      port: 9749,
      url: 'http://localhost:9749',
    });
  });

  it('cleans stale state when the recorded process is not alive', async () => {
    await writeCodebaseUiState({ ...SAMPLE_STATE, pid: 9999999 }, TEST_STATE_FILE);

    const status = await checkCodebaseUiStatus(TEST_STATE_FILE);

    expect(status.running).toBe(false);
    expect(existsSync(TEST_STATE_FILE)).toBe(false);
  });

  it('spawns the Codebase Memory UI daemon and waits for its state file', async () => {
    const { spawnDetached } = await import('../../../../utils/processes.js');

    setTimeout(() => {
      void writeCodebaseUiState(
        {
          pid: process.pid,
          childPid: 12346,
          port: 9750,
          url: 'http://localhost:9750',
          startedAt: new Date().toISOString(),
        },
        TEST_STATE_FILE
      );
    }, 10);

    const state = await spawnCodebaseUi({
      port: 9750,
      stateFile: TEST_STATE_FILE,
      readinessTimeoutMs: 1000,
    });

    expect(spawnDetached).toHaveBeenCalledWith(
      process.execPath,
      [
        join(tmpdir(), '../../../../bin/codebase-memory-ui-daemon.js'),
        '--port',
        '9750',
        '--state-file',
        TEST_STATE_FILE,
      ],
      { stdio: 'ignore' }
    );
    expect(state).toMatchObject({
      pid: process.pid,
      port: 9750,
      url: 'http://localhost:9750',
    });
  });

  it('clears state without throwing', async () => {
    await writeFile(TEST_STATE_FILE, '{}', 'utf-8');

    await expect(clearCodebaseUiState(TEST_STATE_FILE)).resolves.not.toThrow();
    expect(existsSync(TEST_STATE_FILE)).toBe(false);
  });

  it('reports a port as unavailable when a local server is listening', async () => {
    const net = await import('node:net');
    const server = net.createServer();

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address');
    }

    await expect(isPortAvailable(address.port)).resolves.toBe(false);

    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
});
