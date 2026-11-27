/**
 * codemie-claude with the user's own --plugin-dir — CLI contract tests (EPMCDME-17667)
 *
 * codemie-claude passes Claude Code its extension (the codemie plugin) as a --plugin-dir. Until
 * #867 any --plugin-dir of the user's own dropped it: the session got no CodeMie record, no sync,
 * none of the extension hooks, and `codemie-claude --resume` refused it as "not created through
 * CodeMie". Claude Code accepts several --plugin-dir flags, so the extension must be passed next to
 * the user's directories, and once only.
 *
 * Drives the built `bin/codemie-claude.js` on an anthropic-subscription profile in an isolated temp
 * home. `claude` on PATH is a stub that stands in for Claude Code: it records the arguments it was
 * given and runs the SessionStart and SessionEnd command hooks of every plugin directory it was
 * passed, as Claude Code runs a loaded plugin's hooks. No network, no LLM.
 *
 * Requires dist/ built. Run: npx vitest run --project cli tests/integration/claude-user-plugin-dir.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { REPO_ROOT, createCliHome, disposeCliHome, hookEnv, type CliRun } from '../helpers/otlp-hook-session.js';

const CLAUDE_BIN = join(REPO_ROOT, 'bin', 'codemie-claude.js');
const RUN_TIMEOUT_MS = 60_000;
// Two wrapper runs, each running the extension's session hooks through the built CLI.
const TEST_TIMEOUT_MS = RUN_TIMEOUT_MS * 2 + 15_000;
const PROFILE = 'subscription';

// Stands in for Claude Code. `--version` answers the supported version check; any other run records
// its arguments and runs the first command hook of SessionStart and SessionEnd in every
// --plugin-dir's hooks/hooks.json (until `--`), with Claude Code's hook payload on stdin. Each hook run keeps its
// command and the end of its stderr, so a failing hook says why.
const STUB_CLAUDE = `
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { randomUUID } = require('crypto');

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('2.1.330 (Claude Code)');
  process.exit(0);
}
const end = args.indexOf('--');
const scoped = end === -1 ? args : args.slice(0, end);
const pluginDirs = [];
scoped.forEach((arg, i) => {
  if (arg === '--plugin-dir') pluginDirs.push(scoped[i + 1]);
  else if (arg.startsWith('--plugin-dir=')) pluginDirs.push(arg.slice('--plugin-dir='.length));
});
const resumeAt = scoped.findIndex((arg) => arg === '--resume' || arg === '-r');
const sessionId = resumeAt === -1 ? randomUUID() : scoped[resumeAt + 1];
const transcript = path.join(process.env.HOME, '.claude', 'projects', 'stub', sessionId + '.jsonl');
fs.mkdirSync(path.dirname(transcript), { recursive: true });
fs.appendFileSync(transcript, JSON.stringify({
  type: 'user', sessionId, cwd: process.cwd(), timestamp: new Date().toISOString(),
  message: { role: 'user', content: 'Reply with OK.' },
}) + '\\n');

const hookRuns = [];
const events = [
  ['SessionStart', { source: resumeAt === -1 ? 'startup' : 'resume' }],
  ['SessionEnd', { reason: 'other' }],
];
for (const [event, fields] of events) {
  for (const dir of pluginDirs) {
    const file = path.join(dir, 'hooks', 'hooks.json');
    if (!fs.existsSync(file)) continue;
    for (const group of JSON.parse(fs.readFileSync(file, 'utf8')).hooks?.[event] ?? []) {
      const hook = group.hooks?.[0];
      if (!hook || hook.type !== 'command') continue;
      const input = JSON.stringify({
        session_id: sessionId, transcript_path: transcript, cwd: process.cwd(), hook_event_name: event, ...fields,
      });
      let code = 0;
      let stderr = '';
      try {
        execSync(hook.command, { input, stdio: ['pipe', 'ignore', 'pipe'], timeout: (hook.timeout ?? 60) * 1000 });
      } catch (error) {
        code = error.status ?? -1;
        stderr = String(error.stderr ?? error.message).slice(-2000);
      }
      hookRuns.push({ event, dir, code, command: hook.command, stderr });
    }
  }
}
fs.appendFileSync(process.env.STUB_CLAUDE_LOG, JSON.stringify({ args, pluginDirs, sessionId, hookRuns }) + '\\n');
`;

interface ClaudeRun {
  args: string[];
  pluginDirs: string[];
  sessionId: string;
  hookRuns: Array<{ event: string; dir: string; code: number; command: string; stderr: string }>;
}

interface SessionRecord {
  sessionId: string;
  correlation?: { status?: string; agentSessionId?: string };
}

interface Workspace {
  home: string;
  extensionDir: string;
  userPluginDir: (name: string) => string;
  runClaude: (args: string[]) => Promise<CliRun>;
  claudeRuns: () => ClaudeRun[];
  sessionRecords: () => SessionRecord[];
}

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) disposeCliHome(home);
});

function setUp(): Workspace {
  const home = createCliHome(homes);
  writeFileSync(
    join(home, 'codemie-cli.config.json'),
    JSON.stringify(
      {
        version: 2,
        activeProfile: PROFILE,
        profiles: {
          [PROFILE]: {
            name: PROFILE,
            provider: 'anthropic-subscription',
            baseUrl: 'https://api.anthropic.com',
            apiKey: '',
            model: 'claude-sonnet-4-6',
            authMethod: 'manual',
          },
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  const stubDir = join(home, 'stub-bin');
  mkdirSync(stubDir);
  const stub = join(stubDir, 'claude');
  writeFileSync(stub, `#!${process.execPath}\n${STUB_CLAUDE}`, 'utf-8');
  chmodSync(stub, 0o755);
  const claudeLog = join(home, 'claude-runs.jsonl');

  const env: NodeJS.ProcessEnv = {
    ...hookEnv(home),
    // The stub first, then node for the extension's `#!/usr/bin/env node` hook command; no real claude.
    PATH: [stubDir, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
    STUB_CLAUDE_LOG: claudeLog,
  };
  // hookEnv stands in for a hook inside a running session; the wrapper starts its own.
  delete env.CODEMIE_AGENT;
  delete env.CODEMIE_SESSION_ID;

  const runClaude = (args: string[]): Promise<CliRun> =>
    new Promise((done, fail) => {
      const child = spawn(process.execPath, [CLAUDE_BIN, ...args], { cwd: home, env, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        fail(new Error(`codemie-claude ${args.join(' ')} did not exit within ${RUN_TIMEOUT_MS}ms\nstderr: ${stderr}`));
      }, RUN_TIMEOUT_MS);
      child.on('error', fail);
      child.on('close', (code) => {
        clearTimeout(timer);
        done({ code, stdout, stderr });
      });
      child.stdin.end();
    });

  const userPluginDir = (name: string): string => {
    const dir = join(home, 'user-plugins', name);
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '0.0.1' }), 'utf-8');
    return dir;
  };

  const sessionsDir = join(home, 'sessions');
  return {
    home,
    // Where the wrapper installs the extension: the claude-plugin directory under ~/.codemie.
    extensionDir: join(home, '.codemie', 'claude-plugin'),
    userPluginDir,
    runClaude,
    claudeRuns: () =>
      existsSync(claudeLog)
        ? readFileSync(claudeLog, 'utf-8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as ClaudeRun)
        : [],
    sessionRecords: () =>
      existsSync(sessionsDir)
        ? readdirSync(sessionsDir)
            .filter((name) => name.startsWith('completed_') && name.endsWith('.json'))
            .map((name) => JSON.parse(readFileSync(join(sessionsDir, name), 'utf-8')) as SessionRecord)
        : [],
  };
}

// The end of the CLI's debug logs in the temp home: the wrapper logs there how it installed the extension's hooks.
function debugLogTail(home: string): string {
  const logs = join(home, 'logs');
  if (!existsSync(logs)) return '(no debug log)';
  return readdirSync(logs)
    .filter((name) => name.startsWith('debug-'))
    .map((name) => `${name}:\n${readFileSync(join(logs, name), 'utf-8').slice(-4000)}`)
    .join('\n');
}

function report(run: CliRun, workspace: Workspace): string {
  return `exit ${run.code}\nstdout: ${run.stdout}\nstderr: ${run.stderr}\nclaude runs: ${JSON.stringify(workspace.claudeRuns(), null, 2)}`;
}

// POSIX only: the stub `claude` is an extensionless script with a shebang, which the wrapper cannot start through
// cmd.exe on Windows. The argument handling under test has no platform branch.
describe.skipIf(process.platform === 'win32')('codemie-claude with a --plugin-dir of the user (EPMCDME-17667)', () => {
  it(
    'passes the extension next to one user plugin directory, so the session is tracked and resumable',
    async () => {
      const workspace = setUp();
      const userPlugin = workspace.userPluginDir('qa-user-plugin');

      const first = await workspace.runClaude(['--plugin-dir', userPlugin, '-p', 'Reply with OK.']);
      expect(first.code, report(first, workspace)).toBe(0);
      const [started] = workspace.claudeRuns();
      expect(started.pluginDirs, 'plugin directories Claude Code was given').toEqual([workspace.extensionDir, userPlugin]);
      const extensionHooks = started.hookRuns.filter((run) => run.dir === workspace.extensionDir);
      expect(
        extensionHooks.map(({ event, dir, code }) => ({ event, dir, code })),
        `session hooks of the extension: ${JSON.stringify(extensionHooks, null, 2)}\n${debugLogTail(workspace.home)}`
      ).toEqual([
        { event: 'SessionStart', dir: workspace.extensionDir, code: 0 },
        { event: 'SessionEnd', dir: workspace.extensionDir, code: 0 },
      ]);
      const record = workspace.sessionRecords().find((r) => r.correlation?.agentSessionId === started.sessionId);
      expect(record, `CodeMie record of Claude session ${started.sessionId}: ${JSON.stringify(workspace.sessionRecords())}`).toBeDefined();
      expect(record!.correlation!.status).toBe('matched');

      const resumed = await workspace.runClaude(['--resume', started.sessionId, '--plugin-dir', userPlugin, '-p', 'Reply with OK.']);
      const output = `${resumed.stdout}\n${resumed.stderr}`;
      expect(output).not.toContain('was not created through CodeMie');
      expect(output).not.toContain('resume blocked');
      expect(resumed.code, report(resumed, workspace)).toBe(0);
      const second = workspace.claudeRuns()[1];
      expect(second.sessionId, 'the Claude session the resumed run continued').toBe(started.sessionId);
      expect(second.pluginDirs).toEqual([workspace.extensionDir, userPlugin]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'passes the extension once next to several user plugin directories in either flag form',
    async () => {
      const workspace = setUp();
      const first = workspace.userPluginDir('qa-user-plugin');
      const second = workspace.userPluginDir('qa-user-plugin-two');

      const run = await workspace.runClaude(['--plugin-dir', first, `--plugin-dir=${second}`, '-p', 'Reply with OK.']);

      expect(run.code, report(run, workspace)).toBe(0);
      expect(workspace.claudeRuns()[0].pluginDirs).toEqual([workspace.extensionDir, first, second]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'does not pass the extension twice when the user passes its directory too',
    async () => {
      const workspace = setUp();
      const userPlugin = workspace.userPluginDir('qa-user-plugin');
      // The ticket's workaround: the extension directory next to the user's own.
      await workspace.runClaude(['-p', 'Install the extension.']);

      const run = await workspace.runClaude([
        '--plugin-dir', userPlugin,
        '--plugin-dir', workspace.extensionDir,
        '-p', 'Reply with OK.',
      ]);

      expect(run.code, report(run, workspace)).toBe(0);
      expect(workspace.claudeRuns()[1].pluginDirs).toEqual([userPlugin, workspace.extensionDir]);
    },
    TEST_TIMEOUT_MS
  );
});
