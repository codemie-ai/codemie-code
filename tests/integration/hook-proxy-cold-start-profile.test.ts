/**
 * Hook proxy cold start on the recorded profile — CLI contract tests
 *
 * Drives the built `bin/codemie.js` (`codemie hook --agent claude-code-otlp`) in an isolated temp
 * home. The hook restarts the proxy daemon on the profile recorded in proxy-connection.json:
 * an unusable recorded profile must not start any daemon (and must not fall back to another
 * profile), and a daemon that is already alive is adopted rather than restarted.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(REPO_ROOT, 'bin', 'codemie.js');
const RUN_TIMEOUT_MS = 30_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface DaemonState {
  pid: number;
  port: number;
  profile: string;
}

describe('hook proxy cold start on the recorded profile', () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) {
      const stateFile = join(home, 'proxy-daemon.json');
      if (existsSync(stateFile)) {
        try {
          process.kill((JSON.parse(readFileSync(stateFile, 'utf-8')) as DaemonState).pid, 'SIGKILL');
        } catch {
          /* already exited */
        }
      }
      try {
        rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* ignore cleanup errors */
      }
    }
  });

  function cliEnv(home: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NO_COLOR;
    for (const key of Object.keys(env)) {
      if (key.startsWith('CODEMIE_') || key.startsWith('VITEST') || key.toLowerCase().startsWith('npm_config_')) {
        delete env[key];
      }
    }
    delete env.NODE_ENV;
    env.HOME = home;
    env.USERPROFILE = home;
    env.APPDATA = join(home, 'AppData', 'Roaming');
    env.LOCALAPPDATA = join(home, 'AppData', 'Local');
    env.DO_NOT_TRACK = '1';
    env.npm_config_update_notifier = 'false';
    env.CODEMIE_HOME = home;
    env.CODEMIE_AGENT = 'claude';
    env.CODEMIE_SESSION_ID = 'codemie-session-under-test';
    return env;
  }

  // A fresh SessionStart: a mid-session event with no session record is stopped before the proxy is ensured.
  function runHook(home: string): Promise<RunResult> {
    const input = JSON.stringify({
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 'agent-session-under-test',
      transcript_path: join(home, 'transcript.jsonl'),
      cwd: home,
    });
    return new Promise((done, fail) => {
      const child = spawn(process.execPath, [BIN, 'hook', '--agent', 'claude-code-otlp'], {
        cwd: home,
        env: cliEnv(home),
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => (stdout += chunk));
      child.stderr.on('data', chunk => (stderr += chunk));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        fail(new Error(`codemie hook did not exit within ${RUN_TIMEOUT_MS}ms\nstderr: ${stderr}`));
      }, RUN_TIMEOUT_MS);
      child.on('error', fail);
      child.on('close', code => {
        clearTimeout(timer);
        done({ code, stdout, stderr });
      });
      child.stdin.end(input);
    });
  }

  function fileLog(home: string): string {
    const dir = join(home, 'logs');
    if (!existsSync(dir)) return '';
    return readdirSync(dir).map(name => readFileSync(join(dir, name), 'utf-8')).join('\n');
  }

  function readJson<T>(home: string, name: string): T {
    return JSON.parse(readFileSync(join(home, name), 'utf-8')) as T;
  }

  /** A home with two global profiles; `recordedProfile` seeds the proxy-connection.json `proxy connect` writes. */
  function homeWith(
    profiles: Record<string, { baseUrl?: string }>,
    activeProfile: string,
    recordedProfile?: string
  ): string {
    const home = mkdtempSync(join(tmpdir(), 'codemie-hook-cold-start-'));
    homes.push(home);
    writeFileSync(join(home, 'transcript.jsonl'), '', 'utf-8');
    const entries = Object.fromEntries(
      Object.entries(profiles).map(([name, profile]) => [name, { name, provider: 'ai-run-sso', ...profile }])
    );
    writeFileSync(
      join(home, 'codemie-cli.config.json'),
      JSON.stringify({ version: 2, activeProfile, profiles: entries }),
      'utf-8'
    );
    if (recordedProfile) {
      writeFileSync(
        join(home, 'proxy-connection.json'),
        JSON.stringify({
          version: 1,
          profile: recordedProfile,
          clientType: 'claude-code-otlp',
          updatedAt: new Date().toISOString(),
        }),
        'utf-8'
      );
    }
    return home;
  }

  const USABLE = { baseUrl: 'http://127.0.0.1:9/codemie-cold-start-usable' };

  // @case proxy-hook-restart-profile_TC_002
  it('does not start a daemon when the recorded profile does not exist, even though the working directory profile is usable', async () => {
    const home = homeWith({ 'cold-start-usable': USABLE }, 'cold-start-usable', 'cold-start-missing');

    const res = await runHook(home);

    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
    expect(fileLog(home)).toContain('[ensureOtlpProxy] proxy not started (profile: cold-start-missing): profile not found');
    expect(existsSync(join(home, 'proxy-daemon.json'))).toBe(false);
    expect(fileLog(home)).not.toContain('Spawning daemon');
  });

  // @case proxy-hook-restart-profile_TC_002
  it('does not start a daemon when the recorded profile has no baseUrl, and does not fall back to the working directory profile', async () => {
    const home = homeWith(
      { 'cold-start-usable': USABLE, 'cold-start-blank': {} },
      'cold-start-usable',
      'cold-start-blank'
    );

    const res = await runHook(home);

    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
    expect(fileLog(home)).toContain(
      '[ensureOtlpProxy] proxy not started (profile: cold-start-blank, global): no baseUrl configured'
    );
    expect(existsSync(join(home, 'proxy-daemon.json'))).toBe(false);
    expect(fileLog(home)).not.toContain('Spawning daemon');
  });

  // @case proxy-hook-restart-profile_TC_005
  it('adopts a live daemon instead of restarting it and seeds the connection record from it', async () => {
    const home = homeWith({ 'cold-start-usable': USABLE }, 'cold-start-usable', 'cold-start-usable');
    const first = await runHook(home);
    expect(first.stderr).toBe('');
    const started = readJson<DaemonState>(home, 'proxy-daemon.json');
    // The record is gone (deleted or never written by an older CLI) while the daemon is still alive.
    rmSync(join(home, 'proxy-connection.json'));

    const second = await runHook(home);

    expect(second.stdout).toBe('');
    expect(second.stderr).toBe('');
    const adopted = readJson<DaemonState>(home, 'proxy-daemon.json');
    expect(adopted.pid).toBe(started.pid);
    expect(adopted.port).toBe(started.port);
    expect(() => process.kill(started.pid, 0)).not.toThrow();
    expect(readJson<{ profile: string }>(home, 'proxy-connection.json')).toMatchObject({
      version: 1,
      profile: 'cold-start-usable',
    });
    expect(fileLog(home)).toContain('Seeding proxy-connection.json from the running daemon (profile: cold-start-usable)');
  }, 60_000);
});
