/**
 * Isolated CLI Runner - runs the real CLI in a child process against a private CODEMIE_HOME and
 * user home, so tests cross a process boundary and read state back from disk.
 *
 * Unlike CLIRunner (execSync on a command string) it controls cwd, stdin and environment, and
 * reports spawn errors and signals, which keeps a timeout from looking like an empty run.
 */

import { spawnSync } from 'child_process';
import { mkdirSync, readdirSync, realpathSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { expect } from 'vitest';

export interface IsolatedRunResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export interface IsolatedRunOptions {
  cwd?: string;
  input?: string;
  env?: Record<string, string>;
}

export interface IsolatedHomes {
  codemieHome: string;
  userHome: string;
}

const DEFAULT_SPAWN_TIMEOUT_MS = 25_000;

/** Creates `path` and returns its real path (macOS /var symlinks, Windows 8.3 names). */
export function realDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return realpathSync.native(path);
}

/** Drops developer/CI settings that would change the profile, proxy or analytics path of the child. */
export function isolatedEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(CODEMIE_|CLAUDE_|ANTHROPIC_|OTEL_)/i.test(key)) env[key] = value;
  }
  return env;
}

export function runIsolatedCli(
  homes: IsolatedHomes,
  args: string[],
  options: IsolatedRunOptions & { cwd: string; timeoutMs?: number }
): IsolatedRunResult {
  const result = spawnSync(process.execPath, [resolve('./bin/codemie.js'), ...args], {
    cwd: options.cwd,
    input: options.input ?? '',
    encoding: 'utf-8',
    timeout: options.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS,
    env: {
      ...isolatedEnv(),
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      CODEMIE_HOME: homes.codemieHome,
      HOME: homes.userHome,
      USERPROFILE: homes.userHome,
      ...options.env,
    },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
  };
}

/** Assertion message that surfaces a timeout or spawn error instead of an empty run. */
export function describeRun(result: IsolatedRunResult): string {
  return JSON.stringify({ ...result, stdout: result.stdout.slice(0, 500), stderr: result.stderr.slice(0, 500) });
}

export function expectExit(result: IsolatedRunResult, code: number): void {
  expect(result.error, describeRun(result)).toBeUndefined();
  expect(result.status, describeRun(result)).toBe(code);
}

/**
 * Every file and directory under `dir`, relative and sorted, files with their size so an
 * append to an existing file shows up; `skip` prunes whole subtrees.
 */
export function snapshotDir(dir: string, skip: (relPath: string) => boolean = () => false): string[] {
  const entries: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = relative(dir, full).split('\\').join('/');
      if (skip(rel)) continue;
      if (entry.isDirectory()) {
        entries.push(rel);
        walk(full);
      } else {
        entries.push(`${rel}:${statSync(full).size}`);
      }
    }
  };
  walk(dir);
  return entries.sort();
}
