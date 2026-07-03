/**
 * MCP Auth Proxy — daemon state file helpers.
 *
 * Atomic tmp+rename writes and defensive reads, mirroring the SSO proxy's
 * daemon-manager pattern for the auth-proxy state schema {pid, port, routes, startedAt}.
 */
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { getDefaultStatePath } from './config.js';
import type { AuthProxyDaemonState } from './types.js';

export async function readAuthProxyState(
  stateFile: string = getDefaultStatePath()
): Promise<AuthProxyDaemonState | null> {
  try {
    const raw = await readFile(stateFile, 'utf-8');
    const parsed = JSON.parse(raw) as AuthProxyDaemonState;
    if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeAuthProxyState(
  state: AuthProxyDaemonState,
  stateFile: string = getDefaultStatePath()
): Promise<void> {
  const tmp = `${stateFile}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
  await rename(tmp, stateFile);
}

export async function clearAuthProxyState(
  stateFile: string = getDefaultStatePath()
): Promise<void> {
  try {
    await unlink(stateFile);
  } catch {
    // Already gone — no-op
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
