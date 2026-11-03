/**
 * Claude Code analytics opt-out: `codemie proxy analytics disable|enable|exclude|include|status`
 * and the previously installed hook honouring the saved preferences.
 *
 * Every command runs the real CLI in a child process with an isolated CODEMIE_HOME and HOME,
 * so each assertion crosses a process boundary and reads state back from disk.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, copyFileSync, cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  describeRun,
  expectExit,
  realDir,
  runIsolatedCli,
  snapshotDir,
  type IsolatedRunOptions,
  type IsolatedRunResult,
} from '../../helpers/isolated-cli.js';

// bin/codemie.js imports ../dist. Like the other `cli` integration tests this suite runs against
// a prebuilt dist (CI downloads the build artifact; locally run `npm run build` first) and never
// builds it itself: a build here would rewrite dist under other test files running in parallel.
const DIST_ENTRY = resolve('./dist/cli/index.js');

// Each test chains several CLI processes, so it can outlive the `cli` project's 30s default.
const TEST_TIMEOUT_MS = 120_000;

interface StatusJson {
  hooksInstalled: boolean;
  enabled: boolean;
  excludedProjects: string[];
  preferencesCorrupt: boolean;
  current: { path: string; tracked: boolean; reason: string };
}

let sandbox: string;
let templateHome: string;
let claudeShimDir: string;
let codemieHome: string;
let userHome: string;

/** Mirrors `comparable()` in src/agents/core/project-allowlist.ts: case-insensitive on win32 and darwin. */
function norm(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' || process.platform === 'darwin' ? normalized.toLowerCase() : normalized;
}

function runCli(args: string[], options: IsolatedRunOptions = {}): IsolatedRunResult {
  return runIsolatedCli({ codemieHome, userHome }, args, { ...options, cwd: options.cwd ?? sandbox });
}

function status(cwd: string): StatusJson {
  const result = runCli(['proxy', 'analytics', 'status', '--json'], { cwd });
  expectExit(result, 0);
  return JSON.parse(result.stdout) as StatusJson;
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

/** Logs are written by every run, tracked or not, so they say nothing about forwarding. */
const skipLogs = (rel: string): boolean => rel === 'logs' || rel.startsWith('logs/');

/**
 * Written by the hook only after the analytics gate let the event through: it resolves the
 * installed `claude` version for the event it is about to forward and caches it. A silenced
 * hook never reaches it. The cache is only written when `claude --version` succeeds, which
 * CI runners cannot be relied on for, so every hook run gets a stand-in `claude` on PATH.
 */
function forwardingMarker(): string {
  return join(codemieHome, 'cache', 'claude-code-client-version.json');
}

/**
 * The fixture has no SSO login, so a tracked event stops at the evidence stage (fail closed,
 * nothing enqueued) before the marker above is written. That stage runs only after the
 * analytics gate let the event through, so its warning is the second proof of passing the gate.
 * Full forwarding is covered in claude-code-otlp.disable-matrix.test.ts.
 */
function reachedEvidenceStage(): boolean {
  const logs = join(codemieHome, 'logs');
  return (
    existsSync(logs) &&
    readdirSync(logs).some((name) => readFileSync(join(logs, name), 'utf-8').includes('evidence record unavailable (no_credentials)'))
  );
}

/**
 * Runs one prompt hook. `forwarded`: the event got past the gate. `wroteState`: the run left
 * anything behind in either home (spool, session, daemon or proxy files). A silenced hook must
 * do neither; a tracked one must forward.
 */
function runPromptHook(
  project: string,
  sessionId: string
): { run: IsolatedRunResult; forwarded: boolean; wroteState: boolean } {
  rmSync(forwardingMarker(), { force: true });
  rmSync(join(codemieHome, 'logs'), { recursive: true, force: true });
  const homeBefore = snapshotDir(codemieHome, skipLogs);
  const userBefore = snapshotDir(userHome);
  const run = runCli(['hook', '--agent', 'claude-code-otlp'], {
    cwd: project,
    pathPrefix: claudeShimDir,
    env: { CODEMIE_DEBUG: 'true' },
    input: JSON.stringify({ session_id: sessionId, cwd: project, hook_event_name: 'UserPromptSubmit', prompt: `prompt for ${sessionId}` }),
  });
  const wroteState =
    JSON.stringify(snapshotDir(codemieHome, skipLogs)) !== JSON.stringify(homeBefore) ||
    JSON.stringify(snapshotDir(userHome)) !== JSON.stringify(userBefore);
  return { run, forwarded: existsSync(forwardingMarker()) || reachedEvidenceStage(), wroteState };
}

/**
 * A `claude` executable that answers `--version`, for hosts without the real CLI. Node spawns
 * it without a shell, so Windows needs a real .exe (node itself, which prints its version) and
 * POSIX a script with a shebang.
 */
function createClaudeShim(dir: string): string {
  const shimDir = realDir(dir);
  if (process.platform === 'win32') {
    // A copy, not a link: a hard link to the running node.exe cannot be unlinked on Windows.
    copyFileSync(process.execPath, join(shimDir, 'claude.exe'));
  } else {
    const script = join(shimDir, 'claude');
    writeFileSync(script, '#!/bin/sh\necho 9.9.9\n', 'utf-8');
    chmodSync(script, 0o755);
  }
  return shimDir;
}

describe('Claude Code analytics opt-out', () => {
  beforeAll(() => {
    if (!existsSync(DIST_ENTRY)) {
      throw new Error(`${DIST_ENTRY} not found: run \`npm run build\` before the cli integration tests.`);
    }
    sandbox = realDir(mkdtempSync(join(tmpdir(), 'codemie-analytics-')));
    claudeShimDir = createClaudeShim(join(sandbox, 'claude-shim'));

    // Known product defect tracked in EPMCDME-16716, outside this story: the first CLI run in
    // an empty CODEMIE_HOME prints the one-time migration banner on stdout, ahead of any
    // `--json` payload. Prime one home here and copy it per test, so assertions read clean
    // output without paying the migration run in every test.
    templateHome = realDir(join(sandbox, 'template-home'));
    const primed = runIsolatedCli(
      { codemieHome: templateHome, userHome: realDir(join(sandbox, 'template-user')) },
      ['proxy', 'analytics', 'status'],
      { cwd: sandbox }
    );
    expectExit(primed, 0);
  }, TEST_TIMEOUT_MS);

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  // Fresh home per test: no state leaks between scenarios.
  function freshHome(name: string): void {
    codemieHome = join(sandbox, name, 'codemie-home');
    cpSync(templateHome, codemieHome, { recursive: true });
    userHome = realDir(join(sandbox, name, 'user-home'));
  }

  // @case allow-users-to-disable-analytics_TC_001
  it('should disable and report disabled in status', () => {
    freshHome('tc001-disable');
    installHooks();
    const project = realDir(join(sandbox, 'tc001-disable', 'project'));

    const disable = runCli(['proxy', 'analytics', 'disable'], { cwd: project });
    expectExit(disable, 0);
    expect(disable.stdout).toContain('Saved to');
    expect(readPrefs().enabled).toBe(false);

    const disabled = status(project);
    expect(disabled.enabled).toBe(false);
    expect(disabled.current.tracked).toBe(false);
    expect(disabled.current.reason).toBe('disabled');
  }, TEST_TIMEOUT_MS);

  // @case allow-users-to-disable-analytics_TC_001
  it('should ignore a repeat disable and resume on enable', () => {
    freshHome('tc001-enable');
    installHooks();
    const project = realDir(join(sandbox, 'tc001-enable', 'project'));

    expectExit(runCli(['proxy', 'analytics', 'disable'], { cwd: project }), 0);

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
    expect(silenced.forwarded).toBe(false);
    expect(silenced.wroteState).toBe(false);

    expectExit(runCli(['proxy', 'analytics', 'enable'], { cwd: tracked }), 0);
    expect(status(tracked).current.reason).toBe('tracked');
    const resumed = runPromptHook(tracked, 'sess-project-enabled');
    expect(resumed.run.error, describeRun(resumed.run)).toBeUndefined();
    expect(resumed.forwarded).toBe(true);
    // The allowlist stays untouched by disable and enable.
    expect(status(outside).current.reason).toBe('not-in-allowlist');
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

  // @case allow-users-to-disable-analytics_TC_003
  it('should exclude one allowlisted project under the Project scope while the other keeps sending', () => {
    freshHome('tc003-project');
    const projectA = realDir(join(sandbox, 'tc003-project', 'project-a'));
    const projectB = realDir(join(sandbox, 'tc003-project', 'project-b'));
    const outside = realDir(join(sandbox, 'tc003-project', 'outside'));
    installHooks([projectA, projectB]);

    expectExit(runCli(['proxy', 'analytics', 'exclude', projectA], { cwd: projectB }), 0);
    expect(readPrefs().enabled).toBe(true);

    expect(status(projectA).current.reason).toBe('project-excluded');
    expect(status(projectB).current.reason).toBe('tracked');
    expect(status(outside).current.reason).toBe('not-in-allowlist');

    const excluded = runPromptHook(projectA, 'sess-project-a');
    expectExit(excluded.run, 0);
    expect(excluded.forwarded).toBe(false);
    expect(excluded.wroteState).toBe(false);

    const sibling = runPromptHook(projectB, 'sess-project-b');
    expect(sibling.run.error, describeRun(sibling.run)).toBeUndefined();
    expect(sibling.forwarded).toBe(true);

    const unlisted = runPromptHook(outside, 'sess-project-outside');
    expectExit(unlisted.run, 0);
    expect(unlisted.forwarded).toBe(false);
    expect(unlisted.wroteState).toBe(false);

    expectExit(runCli(['proxy', 'analytics', 'include', projectA], { cwd: projectB }), 0);
    expect(status(projectA).current.reason).toBe('tracked');
    const resumed = runPromptHook(projectA, 'sess-project-a-again');
    expect(resumed.forwarded).toBe(true);
  }, TEST_TIMEOUT_MS);

  // @case allow-users-to-disable-analytics_TC_004
  it('should fail closed on corrupt preferences and never overwrite the file', () => {
    freshHome('tc004');
    installHooks();
    const project = realDir(join(sandbox, 'tc004', 'project'));

    // Positive control: the same hook forwards while the preferences are readable.
    const tracked = runPromptHook(project, 'sess-corrupt-control');
    expect(tracked.run.error, describeRun(tracked.run)).toBeUndefined();
    expect(tracked.forwarded).toBe(true);

    writeFileSync(prefsPath(), '{ "enabled": tru', 'utf-8');
    const before = readFileSync(prefsPath());

    const report = status(project);
    expect(report.preferencesCorrupt).toBe(true);
    expect(report.current.tracked).toBe(false);
    expect(report.current.reason).toBe('preferences-corrupt');

    // The installed hook fails closed too: nothing forwarded, nothing written, file untouched.
    const hook = runPromptHook(project, 'sess-corrupt');
    expectExit(hook.run, 0);
    expect(hook.run.stdout.trim()).toBe('');
    expect(hook.forwarded).toBe(false);
    expect(hook.wroteState).toBe(false);
    expect(readFileSync(prefsPath()).equals(before), 'the hook rewrote the preferences file').toBe(true);

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

    // Positive control: with analytics enabled the same payload leaves state behind, so the
    // disabled run below cannot be a crash, a rejected payload or a no-op.
    const tracked = runPromptHook(project, 'sess-hook-001');
    expect(tracked.run.error, describeRun(tracked.run)).toBeUndefined();
    expect(tracked.forwarded).toBe(true);

    expectExit(runCli(['proxy', 'analytics', 'disable'], { cwd: project }), 0);
    expect(status(project).current.reason).toBe('disabled');

    const hook = runPromptHook(project, 'sess-hook-001');
    expectExit(hook.run, 0);
    // A tracked prompt hook may emit a decision on stdout; a silenced one prints nothing.
    expect(hook.run.stdout.trim()).toBe('');
    // No spool, session, daemon or proxy state anywhere under either home.
    expect(hook.forwarded).toBe(false);
    expect(hook.wroteState).toBe(false);
  }, TEST_TIMEOUT_MS);
});
