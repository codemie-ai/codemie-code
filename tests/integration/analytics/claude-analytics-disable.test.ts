/**
 * Claude Code analytics opt-out: `codemie proxy analytics disable|enable|exclude|include|status`
 * and the previously installed hook honouring the saved preferences.
 *
 * Every command runs the real CLI in a child process with an isolated CODEMIE_HOME and HOME,
 * so each assertion crosses a process boundary and reads state back from disk.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const BIN = resolve('./bin/codemie.js');

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

interface StatusJson {
  hooksInstalled: boolean;
  enabled: boolean;
  excludedProjects: string[];
  preferencesCorrupt: boolean;
  current: { path: string; tracked: boolean; reason: string };
}

let sandbox: string;
let codemieHome: string;
let userHome: string;

function realDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return realpathSync.native(path);
}

function norm(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function runCli(args: string[], options: { cwd?: string; input?: string; env?: Record<string, string> } = {}): RunResult {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: options.cwd ?? sandbox,
    input: options.input ?? '',
    encoding: 'utf-8',
    timeout: 25_000,
    env: {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      CODEMIE_HOME: codemieHome,
      HOME: userHome,
      USERPROFILE: userHome,
      ...options.env,
    },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

function status(cwd: string): StatusJson {
  const result = runCli(['proxy', 'analytics', 'status', '--json'], { cwd });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as StatusJson;
}

function prefsPath(): string {
  return join(codemieHome, 'claude-analytics.json');
}

function readPrefs(): { enabled: boolean; excludedProjects: string[] } {
  return JSON.parse(readFileSync(prefsPath(), 'utf-8'));
}

function installHooks(): void {
  mkdirSync(join(userHome, '.claude'), { recursive: true });
  writeFileSync(
    join(userHome, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'codemie hook --agent claude-code-otlp' }] }],
      },
    }),
    'utf-8'
  );
}

describe('Claude Code analytics opt-out', () => {
  beforeAll(() => {
    sandbox = realDir(mkdtempSync(join(tmpdir(), 'codemie-analytics-')));
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  // Fresh home per test: no state leaks between scenarios.
  function freshHome(name: string): void {
    codemieHome = realDir(join(sandbox, name, 'codemie-home'));
    userHome = realDir(join(sandbox, name, 'user-home'));
    // The first CLI run in an empty CODEMIE_HOME prints a one-time migration banner on stdout,
    // which would precede any `--json` payload. Run once so later runs are clean.
    expect(runCli(['proxy', 'analytics', 'status']).status).toBe(0);
  }

  // @case allow-users-to-disable-analytics_TC_001
  it('should disable, report disabled in status, ignore a repeat disable, and resume on enable', () => {
    freshHome('tc001');
    installHooks();
    const project = realDir(join(sandbox, 'tc001', 'project'));

    const disable = runCli(['proxy', 'analytics', 'disable'], { cwd: project });
    expect(disable.status).toBe(0);
    expect(disable.stdout).toContain('Saved to');
    expect(readPrefs().enabled).toBe(false);

    const disabled = status(project);
    expect(disabled.enabled).toBe(false);
    expect(disabled.current.tracked).toBe(false);
    expect(disabled.current.reason).toBe('disabled');

    const repeat = runCli(['proxy', 'analytics', 'disable'], { cwd: project });
    expect(repeat.status).toBe(0);
    expect(repeat.stdout).toContain('Nothing to change.');
    expect(readPrefs().enabled).toBe(false);

    const enable = runCli(['proxy', 'analytics', 'enable'], { cwd: project });
    expect(enable.status).toBe(0);
    expect(readPrefs().enabled).toBe(true);

    const enabled = status(project);
    expect(enabled.enabled).toBe(true);
    expect(enabled.current.tracked).toBe(true);
    expect(enabled.current.reason).toBe('tracked');
  });

  // @case allow-users-to-disable-analytics_TC_001
  it('should reject more than one connector flag with exit code 1', () => {
    freshHome('tc001-flags');

    const result = runCli(['proxy', 'analytics', 'disable', '--copilot-cli-otlp', '--copilot-chat-otlp']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Choose one connector at a time');
    expect(existsSync(prefsPath())).toBe(false);
  });

  // @case allow-users-to-disable-analytics_TC_003
  it('should exclude one project under the Global scope while others stay tracked, and include reverses it', () => {
    freshHome('tc003');
    installHooks();
    const projectA = realDir(join(sandbox, 'tc003', 'project-a'));
    const projectB = realDir(join(sandbox, 'tc003', 'project-b'));

    expect(status(projectA).current.tracked).toBe(true);

    const exclude = runCli(['proxy', 'analytics', 'exclude', projectA], { cwd: projectB });
    expect(exclude.status).toBe(0);
    const stored = readPrefs();
    expect(stored.enabled).toBe(true);
    expect(stored.excludedProjects.map(norm)).toEqual([norm(projectA)]);

    const inA = status(projectA);
    expect(inA.current.tracked).toBe(false);
    expect(inA.current.reason).toBe('project-excluded');
    const inB = status(projectB);
    expect(inB.current.tracked).toBe(true);
    expect(inB.current.reason).toBe('tracked');

    const include = runCli(['proxy', 'analytics', 'include', projectA], { cwd: projectB });
    expect(include.status).toBe(0);
    expect(readPrefs().excludedProjects).toEqual([]);

    const restored = status(projectA);
    expect(restored.current.tracked).toBe(true);
    expect(restored.current.reason).toBe('tracked');
  });

  // @case allow-users-to-disable-analytics_TC_004
  it('should fail closed on corrupt preferences and never overwrite the file', () => {
    freshHome('tc004');
    installHooks();
    const project = realDir(join(sandbox, 'tc004', 'project'));
    writeFileSync(prefsPath(), '{ "enabled": tru', 'utf-8');
    const before = readFileSync(prefsPath());

    const report = status(project);
    expect(report.preferencesCorrupt).toBe(true);
    expect(report.current.tracked).toBe(false);
    expect(report.current.reason).toBe('preferences-corrupt');

    const disable = runCli(['proxy', 'analytics', 'disable'], { cwd: project });
    expect(disable.status).not.toBe(0);
    expect(disable.stderr).toContain('Claude analytics preferences are corrupt and were not changed');

    expect(readFileSync(prefsPath()).equals(before)).toBe(true);
  });

  // @case allow-users-to-disable-analytics_TC_005
  it('should silence an already installed hook after disable without spooling or starting a proxy', () => {
    freshHome('tc005');
    installHooks();
    const project = realDir(join(sandbox, 'tc005', 'project'));

    expect(runCli(['proxy', 'analytics', 'disable'], { cwd: project }).status).toBe(0);

    const payload = JSON.stringify({
      session_id: 'sess-disabled-001',
      cwd: project,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hello',
    });
    const hook = runCli(['hook', '--agent', 'claude-code-otlp'], {
      cwd: project,
      input: payload,
      env: { CODEMIE_DEBUG: 'true' },
    });

    expect(hook.status).toBe(0);
    // A tracked prompt hook would emit a decision on stdout; a silenced one prints nothing.
    expect(hook.stdout.trim()).toBe('');

    const logsDir = join(codemieHome, 'logs');
    const logText = readdirSync(logsDir)
      .filter((f) => f.startsWith('debug-'))
      .map((f) => readFileSync(join(logsDir, f), 'utf-8'))
      .join('\n');
    const markerAt = logText.indexOf('analytics gate decision');
    expect(markerAt).toBeGreaterThanOrEqual(0);
    // The decision payload follows the marker on the next lines of the same log entry.
    const afterMarker = logText.slice(markerAt);
    const entryEnd = afterMarker.search(/\n\[\d{4}-\d{2}-\d{2}T/);
    const gateEntry = entryEnd === -1 ? afterMarker : afterMarker.slice(0, entryEnd);
    expect(gateEntry).toContain('disabled');
    expect(logText).toContain('ignoring hook event');

    const leftovers = readdirSync(codemieHome).filter((name) => /spool|proxy|daemon/i.test(name));
    expect(leftovers).toEqual([]);
  });
});
