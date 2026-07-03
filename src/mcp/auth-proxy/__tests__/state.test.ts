/**
 * mcp-auth-proxy daemon state file tests
 * @group unit
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import {
  clearAuthProxyState,
  isProcessAlive,
  readAuthProxyState,
  writeAuthProxyState,
} from '../state.js';
import type { AuthProxyDaemonState } from '../types.js';

const stateFile = join(tmpdir(), `mcp-auth-proxy-state-test-${process.pid}-${Date.now()}.json`);
const state: AuthProxyDaemonState = {
  pid: process.pid,
  port: 42800,
  routes: ['radar', 'other'],
  startedAt: '2026-07-03T00:00:00Z',
};

afterEach(async () => {
  try {
    await unlink(stateFile);
  } catch {
    // already gone
  }
});

describe('auth proxy state file', () => {
  it('round-trips state atomically (no .tmp file left behind)', async () => {
    await writeAuthProxyState(state, stateFile);
    expect(existsSync(`${stateFile}.tmp`)).toBe(false);
    expect(await readAuthProxyState(stateFile)).toEqual(state);
  });

  it('returns null for a missing, malformed, or wrong-shaped state file', async () => {
    expect(await readAuthProxyState(stateFile)).toBeNull();
    await writeFile(stateFile, 'not-json', 'utf-8');
    expect(await readAuthProxyState(stateFile)).toBeNull();
    await writeFile(stateFile, '{"pid":"x"}', 'utf-8');
    expect(await readAuthProxyState(stateFile)).toBeNull();
  });

  it('clearAuthProxyState removes the file and tolerates absence', async () => {
    await writeAuthProxyState(state, stateFile);
    await clearAuthProxyState(stateFile);
    expect(existsSync(stateFile)).toBe(false);
    await expect(clearAuthProxyState(stateFile)).resolves.toBeUndefined();
  });

  it('isProcessAlive: true for this process, false for a dead pid', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 30)).toBe(false);
  });
});
