/**
 * A machine of its own for the local mode's tests: a temporary home for every path the CLI reads and writes, and
 * stand-in daemon processes that write their state as the real daemon does. A test file mocks `spawnDetached` and
 * `isOwnerAlive` of `@/utils/processes.js` and hands them {@link standInSpawn} and {@link isPidAlive}.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

export const OWN_VERSION = '2.0.0';

/** Every stand-in process, across module graphs: a mock factory loads its own copy of this module. */
const children: ChildProcess[] = ((globalThis as { __localModeChildren?: ChildProcess[] }).__localModeChildren ??= []);

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A live process standing in for a daemon: it only waits, and exits on SIGTERM. */
export async function liveProcess(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  await new Promise<void>((resolve) => child.once('spawn', () => resolve()));
  return child.pid as number;
}

/** The arguments after the entry of every daemon spawned through the mocked `spawnDetached` of this module graph. */
export async function spawnedArgs(): Promise<string[][]> {
  const { spawnDetached } = await import('@/utils/processes.js');
  return vi.mocked(spawnDetached).mock.calls.map((call) => (call[1] as string[]).slice(1));
}

/** `spawnDetached` of a daemon: a stand-in process that writes its state file once it is up. */
export function standInSpawn(_command: string, args: string[]): number {
  const arg = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const port = Number(arg('--port') ?? 4001);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  child.once('spawn', () => {
    writeFileSync(arg('--state-file') as string, JSON.stringify({
      pid: child.pid,
      port,
      url: `http://127.0.0.1:${port}`,
      profile: '',
      gatewayKey: arg('--gateway-key'),
      ...(arg('--mode') !== undefined && { mode: arg('--mode') }),
      ...(arg('--target-url') !== undefined && { targetUrl: arg('--target-url') }),
      version: OWN_VERSION,
      startedAt: new Date().toISOString(),
    }));
  });
  return child.pid as number;
}

/** The daemon state file of the home. */
export const stateFile = (home: string): string => join(home, 'proxy-daemon.json');

/** A live stand-in daemon with `fields` in its state; answers its pid. */
export async function writeLiveState(home: string, fields: Record<string, unknown>): Promise<number> {
  const pid = await liveProcess();
  const port = (fields.port as number | undefined) ?? 4001;
  writeFileSync(stateFile(home), JSON.stringify({
    pid,
    port,
    url: `http://127.0.0.1:${port}`,
    profile: '',
    gatewayKey: 'codemie-proxy',
    version: OWN_VERSION,
    startedAt: new Date().toISOString(),
    ...fields,
  }));
  return pid;
}

/** A temporary home for the CLI, Claude Code, Copilot and VS Code; Copilot CLI is not installed. */
export function setUpHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'local-mode-'));
  for (const name of ['HOME', 'USERPROFILE', 'CODEMIE_HOME', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']) {
    vi.stubEnv(name, home);
  }
  vi.stubEnv('COPILOT_HOME', join(home, '.copilot'));
  vi.stubEnv('CODEMIE_COPILOT_BIN', join(home, 'no-copilot'));
  return home;
}

export async function tearDownHome(home: string): Promise<void> {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await (await import('@/utils/logger.js')).logger.close();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
