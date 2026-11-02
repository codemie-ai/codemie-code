/**
 * Claude Code analytics opt-out: `codemie proxy analytics disable|enable|exclude|include|status`
 * and the previously installed hook honouring the saved preferences.
 *
 * Every command runs the real CLI in a child process with an isolated CODEMIE_HOME and HOME,
 * so each assertion crosses a process boundary and reads state back from disk.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative, resolve } from 'path';

const ROOT = resolve('.');
const BIN = resolve('./bin/codemie.js');
const DIST_ENTRY = resolve('./dist/utils/logger.js');
const SRC_DIR = resolve('./src');

// Each test spawns several CLI processes, so it can outlive the `cli` project's 30s default.
const TEST_TIMEOUT_MS = 120_000;
const SPAWN_TIMEOUT_MS = 25_000;
const BUILD_TIMEOUT_MS = 300_000;

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
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

/** Drops developer/CI settings that would change the profile, proxy or analytics path of the child. */
function isolatedEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(CODEMIE_|CLAUDE_|ANTHROPIC_|OTEL_)/i.test(key)) env[key] = value;
  }
  return env;
}

function runCli(args: string[], options: { cwd?: string; input?: string; env?: Record<string, string> } = {}): RunResult {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: options.cwd ?? sandbox,
    input: options.input ?? '',
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
    env: {
      ...isolatedEnv(),
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      CODEMIE_HOME: codemieHome,
      HOME: userHome,
      USERPROFILE: userHome,
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

/** Assertion message that keeps a timeout or spawn error from looking like an empty run. */
function describeRun(result: RunResult): string {
  return JSON.stringify({ ...result, stdout: result.stdout.slice(0, 500), stderr: result.stderr.slice(0, 500) });
}

function expectExit(result: RunResult, code: number): void {
  expect(result.error, describeRun(result)).toBeUndefined();
  expect(result.status, describeRun(result)).toBe(code);
}

function status(cwd: string): StatusJson {
  const result = runCli(['proxy', 'analytics', 'status', '--json'], { cwd });
  expectExit(result, 0);
  return JSON.parse(result.stdout) as StatusJson;
}

/** Every file and directory under `dir`, relative and sorted; `skip` prunes whole subtrees. */
function snapshot(dir: string, skip: (relPath: string) => boolean = () => false): string[] {
  const entries: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = relative(dir, full).split('\\').join('/');
      if (skip(rel)) continue;
      entries.push(rel);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return entries.sort();
}

/** Debug log text written by hook runs; the observable of the gate decision. */
function readDebugLog(): string {
  const logsDir = join(codemieHome, 'logs');
  if (!existsSync(logsDir)) return '';
  return readdirSync(logsDir)
    .filter((f) => f.startsWith('debug-'))
    .map((f) => readFileSync(join(logsDir, f), 'utf-8'))
    .join('\n');
}

/** The log entry that starts at `marker`, up to the next timestamped entry. */
function logEntryAfter(logText: string, marker: string): string {
  const markerAt = logText.indexOf(marker);
  if (markerAt < 0) return '';
  const afterMarker = logText.slice(markerAt);
  const entryEnd = afterMarker.search(/\n\[\d{4}-\d{2}-\d{2}T/);
  return entryEnd === -1 ? afterMarker : afterMarker.slice(0, entryEnd);
}

/** Newest modification time of any source file under `dir`. */
function newestSourceMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestSourceMtime(full));
    else if (entry.name.endsWith('.ts')) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

/** True when dist is missing or older than the newest source file, so tests would run stale code. */
function distIsStale(): boolean {
  return !existsSync(DIST_ENTRY) || statSync(DIST_ENTRY).mtimeMs < newestSourceMtime(SRC_DIR);
}

function prefsPath(): string {
  return join(codemieHome, 'claude-analytics.json');
}

function readPrefs(): { enabled: boolean; excludedProjects: string[] } {
  return JSON.parse(readFileSync(prefsPath(), 'utf-8'));
}

/**
 * Installs the codemie UserPromptSubmit hook in the isolated user settings. No `trackedProjects`
 * means Global scope; a list is the Project scope allowlist `connect --scope project` writes.
 */
function installHooks(trackedProjects?: string[]): void {
  mkdirSync(join(userHome, '.claude'), { recursive: true });
  writeFileSync(
    join(userHome, '.claude', 'settings.json'),
    JSON.stringify({
      ...(trackedProjects ? { env: { CODEMIE_ANALYTICS_PROJECT_FILTER: JSON.stringify(trackedProjects) } } : {}),
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'codemie hook --agent claude-code-otlp' }] }],
      },
    }),
    'utf-8'
  );
}

/** One prompt hook for `project`; returns the gate decision logged for that run only. */
function runPromptHook(project: string, sessionId: string): { run: RunResult; gate: string; ignored: boolean } {
  rmSync(join(codemieHome, 'logs'), { recursive: true, force: true });
  const run = runCli(['hook', '--agent', 'claude-code-otlp'], {
    cwd: project,
    input: JSON.stringify({ session_id: sessionId, cwd: project, hook_event_name: 'UserPromptSubmit', prompt: 'hello' }),
    env: { CODEMIE_DEBUG: 'true' },
  });
  const log = readDebugLog();
  return { run, gate: logEntryAfter(log, 'analytics gate decision'), ignored: log.includes('ignoring hook event') };
}

describe('Claude Code analytics opt-out', () => {
  beforeAll(() => {
    // bin/codemie.js imports ../dist, and the `cli` project has no build step of its own.
    if (distIsStale()) {
      const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf-8', shell: true });
      if (build.status !== 0) throw new Error(`npm run build failed:\n${build.stdout}\n${build.stderr}`);
    }
    sandbox = realDir(mkdtempSync(join(tmpdir(), 'codemie-analytics-')));
  }, BUILD_TIMEOUT_MS);

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  // Fresh home per test: no state leaks between scenarios.
  function freshHome(name: string): void {
    codemieHome = realDir(join(sandbox, name, 'codemie-home'));
    userHome = realDir(join(sandbox, name, 'user-home'));
    // Known product defect tracked in EPMCDME-16716, outside this story: the first CLI run in
    // an empty CODEMIE_HOME prints the one-time migration banner on stdout, ahead of any
    // `--json` payload. Prime the home once so the assertions below read clean output.
    expectExit(runCli(['proxy', 'analytics', 'status']), 0);
  }

  // @case allow-users-to-disable-analytics_TC_001
  it('should disable, report disabled in status, ignore a repeat disable, and resume on enable', () => {
    freshHome('tc001');
    installHooks();
    const project = realDir(join(sandbox, 'tc001', 'project'));

    const disable = runCli(['proxy', 'analytics', 'disable'], { cwd: project });
    expectExit(disable, 0);
    expect(disable.stdout).toContain('Saved to');
    expect(readPrefs().enabled).toBe(false);

    const disabled = status(project);
    expect(disabled.enabled).toBe(false);
    expect(disabled.current.tracked).toBe(false);
    expect(disabled.current.reason).toBe('disabled');

    const repeat = runCli(['proxy', 'analytics', 'disable'], { cwd: project });
    expectExit(repeat, 0);
    expect(repeat.stdout).toContain('Nothing to change.');
    expect(readPrefs().enabled).toBe(false);

    const enable = runCli(['proxy', 'analytics', 'enable'], { cwd: project });
    expectExit(enable, 0);
    expect(readPrefs().enabled).toBe(true);

    const enabled = status(project);
    expect(enabled.enabled).toBe(true);
    expect(enabled.current.tracked).toBe(true);
    expect(enabled.current.reason).toBe('tracked');
  }, TEST_TIMEOUT_MS);

  // @case allow-users-to-disable-analytics_TC_001
  it('should reject more than one connector flag with exit code 1', () => {
    freshHome('tc001-flags');

    const result = runCli(['proxy', 'analytics', 'disable', '--copilot-cli-otlp', '--copilot-chat-otlp']);

    expectExit(result, 1);
    expect(result.stderr).toContain('Choose one connector at a time');
    expect(existsSync(prefsPath())).toBe(false);
  }, TEST_TIMEOUT_MS);

  // @case allow-users-to-disable-analytics_TC_003
  it('should exclude one project under the Global scope while others stay tracked, and include reverses it', () => {
    freshHome('tc003');
    installHooks();
    const projectA = realDir(join(sandbox, 'tc003', 'project-a'));
    const projectB = realDir(join(sandbox, 'tc003', 'project-b'));

    expect(status(projectA).current.tracked).toBe(true);

    const exclude = runCli(['proxy', 'analytics', 'exclude', projectA], { cwd: projectB });
    expectExit(exclude, 0);
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
    expectExit(include, 0);
    expect(readPrefs().excludedProjects).toEqual([]);

    const restored = status(projectA);
    expect(restored.current.tracked).toBe(true);
    expect(restored.current.reason).toBe('tracked');
  }, TEST_TIMEOUT_MS);

  // @case allow-users-to-disable-analytics_TC_002
  it('should stop and resume all analytics under the Project scope allowlist', () => {
    freshHome('tc002-project');
    const tracked = realDir(join(sandbox, 'tc002-project', 'tracked'));
    const outside = realDir(join(sandbox, 'tc002-project', 'outside'));
    installHooks([tracked]);

    expect(status(tracked).current.reason).toBe('tracked');
    // A project outside the allowlist sends nothing, with or without the opt-out.
    expect(status(outside).current.tracked).toBe(false);
    expect(status(outside).current.reason).toBe('not-in-allowlist');

    expectExit(runCli(['proxy', 'analytics', 'disable'], { cwd: tracked }), 0);
    const disabled = status(tracked);
    expect(disabled.current.tracked).toBe(false);
    expect(disabled.current.reason).toBe('disabled');
    const silenced = runPromptHook(tracked, 'sess-project-disabled');
    expectExit(silenced.run, 0);
    expect(silenced.gate).toContain('disabled');
    expect(silenced.ignored).toBe(true);

    expectExit(runCli(['proxy', 'analytics', 'enable'], { cwd: tracked }), 0);
    expect(status(tracked).current.reason).toBe('tracked');
    const resumed = runPromptHook(tracked, 'sess-project-enabled');
    expect(resumed.gate).toContain('tracked');
    expect(resumed.ignored).toBe(false);
    // The allowlist stays untouched by disable and enable.
    expect(status(outside).current.reason).toBe('not-in-allowlist');
  }, TEST_TIMEOUT_MS);

  // @case allow-users-to-disable-analytics_TC_003
  it('should exclude one allowlisted project under the Project scope while the other keeps sending', () => {
    freshHome('tc003-project');
    const projectA = realDir(join(sandbox, 'tc003-project', 'project-a'));
    const projectB = realDir(join(sandbox, 'tc003-project', 'project-b'));
    const outside = realDir(join(sandbox, 'tc003-project', 'outside'));
    installHooks([projectA, projectB]);

    expectExit(runCli(['proxy', 'analytics', 'exclude', projectA], { cwd: projectB }), 0);
    expect(readPrefs().enabled).toBe(true);

    const excluded = runPromptHook(projectA, 'sess-project-a');
    expectExit(excluded.run, 0);
    expect(excluded.gate).toContain('project-excluded');
    expect(excluded.ignored).toBe(true);

    const sibling = runPromptHook(projectB, 'sess-project-b');
    expect(sibling.gate).toContain('tracked');
    expect(sibling.ignored).toBe(false);

    const unlisted = runPromptHook(outside, 'sess-project-outside');
    expect(unlisted.gate).toContain('not-in-allowlist');
    expect(unlisted.ignored).toBe(true);

    expectExit(runCli(['proxy', 'analytics', 'include', projectA], { cwd: projectB }), 0);
    expect(status(projectA).current.reason).toBe('tracked');
    const resumed = runPromptHook(projectA, 'sess-project-a-again');
    expect(resumed.gate).toContain('tracked');
    expect(resumed.ignored).toBe(false);
  }, TEST_TIMEOUT_MS);

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

    // Every command that writes preferences must refuse and leave the file untouched.
    const writers: string[][] = [['disable'], ['enable'], ['exclude', project], ['include', project]];
    for (const writer of writers) {
      const result = runCli(['proxy', 'analytics', ...writer], { cwd: project });
      const label = `${writer[0]}: ${describeRun(result)}`;
      expect(result.error, label).toBeUndefined();
      expect(result.status, label).not.toBe(0);
      expect(result.stderr, label).toContain('Claude analytics preferences are corrupt and were not changed');
      expect(readFileSync(prefsPath()).equals(before), `${writer[0]} rewrote the preferences file`).toBe(true);
    }
  }, TEST_TIMEOUT_MS);

  // @case allow-users-to-disable-analytics_TC_005
  it('should silence an already installed hook after disable without spooling or starting a proxy', () => {
    freshHome('tc005');
    installHooks();
    const project = realDir(join(sandbox, 'tc005', 'project'));
    const payload = JSON.stringify({
      session_id: 'sess-hook-001',
      cwd: project,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hello',
    });
    const runHook = (): RunResult =>
      runCli(['hook', '--agent', 'claude-code-otlp'], { cwd: project, input: payload, env: { CODEMIE_DEBUG: 'true' } });

    // Positive control: with analytics enabled the same payload passes the gate and is not
    // dropped, so the disabled run below cannot be a crash, a rejected payload or a no-op.
    const tracked = runHook();
    expect(tracked.error, describeRun(tracked)).toBeUndefined();
    const trackedLog = readDebugLog();
    expect(logEntryAfter(trackedLog, 'analytics gate decision'), describeRun(tracked)).toContain('tracked');
    expect(trackedLog).not.toContain('ignoring hook event');

    expectExit(runCli(['proxy', 'analytics', 'disable'], { cwd: project }), 0);
    rmSync(join(codemieHome, 'logs'), { recursive: true, force: true });

    // Logs are the one expected write of a silenced hook, so they are left out of the diff.
    const skipLogs = (rel: string): boolean => rel === 'logs' || rel.startsWith('logs/');
    const homeBefore = snapshot(codemieHome, skipLogs);
    const userBefore = snapshot(userHome);

    const hook = runHook();
    expectExit(hook, 0);
    // A tracked prompt hook may emit a decision on stdout; a silenced one prints nothing.
    expect(hook.stdout.trim()).toBe('');

    const logText = readDebugLog();
    expect(logEntryAfter(logText, 'analytics gate decision')).toContain('disabled');
    expect(logText).toContain('ignoring hook event');

    // No spool, session, daemon or proxy state anywhere under either home.
    expect(snapshot(codemieHome, skipLogs)).toEqual(homeBefore);
    expect(snapshot(userHome)).toEqual(userBefore);
  }, TEST_TIMEOUT_MS);
});
