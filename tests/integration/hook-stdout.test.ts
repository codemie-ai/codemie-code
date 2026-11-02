/**
 * Hook process stdout — CLI contract tests
 *
 * An agent adds a hook's stdout to the model's context (Claude Code on
 * SessionStart / UserPromptSubmit), so `codemie hook` and `codemie sound`
 * must write nothing there but their protocol answer. Drives the built
 * `bin/codemie.js` in an isolated temp home that looks like a fresh upgrade:
 * pending migrations, an older what's-new marker, no update-check timestamp.
 *
 * NODE_ENV / VITEST are stripped so the start-up update check and what's-new
 * notice run as in a real install; the npm registry is a local server that
 * records every request, so no network is touched and a hook's registry call
 * is observable.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(REPO_ROOT, 'bin', 'codemie.js');
const VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')).version as string;
const OLD_MARKER = '0.0.1';
const RUN_TIMEOUT_MS = 20_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

describe('hook process stdout (codemie hook / codemie sound)', () => {
  let registry: Server;
  let registryUrl: string;
  let registryHits = 0;
  const homes: string[] = [];

  beforeAll(async () => {
    registry = createServer((_req, res) => {
      registryHits++;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
    });
    await new Promise<void>(done => registry.listen(0, '127.0.0.1', done));
    registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await new Promise<void>(done => registry.close(() => done()));
  });

  beforeEach(() => {
    registryHits = 0;
  });

  afterEach(() => {
    for (const home of homes.splice(0)) {
      try {
        rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* ignore cleanup errors */
      }
    }
  });

  /** A home right after an upgrade: no migrations.json, an older what's-new marker, no .last-update-check. */
  function freshHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'codemie-hook-stdout-'));
    homes.push(home);
    writeFileSync(join(home, '.last-seen-version'), OLD_MARKER, 'utf-8');
    writeFileSync(join(home, 'transcript.jsonl'), '', 'utf-8');
    return home;
  }

  function sessionStart(home: string): string {
    return JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'agent-session-under-test',
      transcript_path: join(home, 'transcript.jsonl'),
      cwd: home,
    });
  }

  function fileLog(home: string): string {
    const dir = join(home, 'logs');
    if (!existsSync(dir)) return '';
    return readdirSync(dir).map(name => readFileSync(join(dir, name), 'utf-8')).join('\n');
  }

  /** The hook's own completion line for this test's session, as the file log records it. */
  const PROCESSED = '[codemie-session-under-test] [hook] Completed SessionStart event successfully';

  function cliEnv(home: string, extraEnv: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // lint-staged sets NO_COLOR; with vitest's FORCE_COLOR Node would warn on the child's stderr
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
    env.npm_config_registry = registryUrl;
    env.npm_config_update_notifier = 'false';
    env.CODEMIE_HOME = home;
    env.CODEMIE_AGENT = 'claude';
    env.CODEMIE_SESSION_ID = 'codemie-session-under-test';
    Object.assign(env, extraEnv);
    return env;
  }

  function run(
    home: string,
    args: string[],
    input: string,
    extraEnv: Record<string, string> = {},
    bin: string = BIN,
    nodeArgs: string[] = []
  ): Promise<RunResult> {
    const env = cliEnv(home, extraEnv);
    return new Promise((done, fail) => {
      const child = spawn(process.execPath, [...nodeArgs, bin, ...args], { cwd: home, env, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => (stdout += chunk));
      child.stderr.on('data', chunk => (stderr += chunk));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        fail(new Error(`codemie ${args.join(' ')} did not exit within ${RUN_TIMEOUT_MS}ms\nstderr: ${stderr}`));
      }, RUN_TIMEOUT_MS);
      child.on('error', fail);
      child.on('close', code => {
        clearTimeout(timer);
        done({ code, stdout, stderr });
      });
      child.stdin.end(input);
    });
  }

  /** A home where start-up work is done: the same command's exit code without migrations, update check or notice. */
  async function warmHome(): Promise<string> {
    const home = freshHome();
    await run(home, ['version'], '');
    return home;
  }

  it('control: a piped non-hook command still prints the migrations block and checks for updates, but prints no what\'s-new notice', async () => {
    const home = freshHome();
    const res = await run(home, ['version'], '');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('migration(s)...');
    expect(res.stdout).not.toContain('Updated to');
    expect(readFileSync(join(home, '.last-seen-version'), 'utf-8').trim()).toBe(OLD_MARKER);
    expect(registryHits).toBeGreaterThan(0);
  });

  it('control: --version still prints the migrations block and skips the notice', async () => {
    const home = freshHome();
    const res = await run(home, ['--version'], '');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('migration(s)...');
    expect(res.stdout).not.toContain('Updated to');
    expect(readFileSync(join(home, '.last-seen-version'), 'utf-8').trim()).toBe(OLD_MARKER);
  });

  it('codemie hook writes 0 bytes to stdout, runs migrations to the file log, skips the update check and the notice', async () => {
    const warm = await warmHome();
    const control = await run(warm, ['hook'], sessionStart(warm));
    registryHits = 0;
    const home = freshHome();

    const res = await run(home, ['hook'], sessionStart(home));

    expect(res.stdout).toBe('');
    expect(res.code).toBe(control.code);
    expect(registryHits).toBe(0);
    expect(existsSync(join(home, 'migrations.json'))).toBe(true);
    expect(fileLog(home)).toContain('[MigrationRunner] Found');
    expect(fileLog(warm)).toContain(PROCESSED);
    expect(fileLog(home)).toContain(PROCESSED);
    expect(readFileSync(join(home, '.last-seen-version'), 'utf-8').trim()).toBe(OLD_MARKER);
    expect(existsSync(join(home, '.last-update-check'))).toBe(false);
  });

  it('codemie sound SessionStart writes 0 bytes to stdout and skips the update check', async () => {
    const warm = await warmHome();
    const control = await run(warm, ['sound', 'SessionStart'], sessionStart(warm));
    registryHits = 0;
    const home = freshHome();

    const res = await run(home, ['sound', 'SessionStart'], sessionStart(home));

    expect(res.stdout).toBe('');
    expect(res.code).toBe(control.code);
    expect(registryHits).toBe(0);
    expect(fileLog(home)).toContain('[MigrationRunner] Found');
    expect(readFileSync(join(home, '.last-seen-version'), 'utf-8').trim()).toBe(OLD_MARKER);
  });

  describe('OTLP hook on a cold proxy daemon', () => {
    const DAEMON_PORT = 4001;
    const daemonHomes: string[] = [];

    /** True when something accepts connections on the daemon's fixed port. */
    function portHeld(port: number): Promise<boolean> {
      return new Promise(done => {
        const socket = connect(port, '127.0.0.1');
        socket.once('connect', () => {
          socket.destroy();
          done(true);
        });
        socket.once('error', () => done(false));
      });
    }

    // A daemon that came up wrote its pid to the temp state file; stop it so the case leaves nothing running.
    afterEach(() => {
      for (const home of daemonHomes.splice(0)) {
        const stateFile = join(home, 'proxy-daemon.json');
        if (!existsSync(stateFile)) continue;
        const { pid } = JSON.parse(readFileSync(stateFile, 'utf-8')) as { pid: number };
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already exited */
        }
      }
    });

    // Notification is forwarded as is: the SSO gate (and its browser sign-in) runs only on UserPromptSubmit.
    // The profile's baseUrl is a test-only URL with no stored SSO credentials, so the spawned daemon cannot start.
    async function runColdOtlpHook(extraEnv: Record<string, string>): Promise<{ home: string; res: RunResult; portHeldBefore: boolean }> {
      const home = freshHome();
      daemonHomes.push(home);
      writeFileSync(
        join(home, 'codemie-cli.config.json'),
        JSON.stringify({
          version: 2,
          activeProfile: 'hook-stdout-test',
          profiles: {
            'hook-stdout-test': {
              name: 'hook-stdout-test',
              provider: 'ai-run-sso',
              baseUrl: 'http://127.0.0.1:9/codemie-hook-stdout-test',
            },
          },
        }),
        'utf-8'
      );
      const portHeldBefore = await portHeld(DAEMON_PORT);
      const notification = JSON.stringify({
        hook_event_name: 'Notification',
        session_id: 'agent-session-under-test',
        transcript_path: join(home, 'transcript.jsonl'),
        cwd: home,
        message: 'Claude is waiting for your input',
        notification_type: 'idle_prompt',
      });

      const res = await run(home, ['hook', '--agent', 'claude-code-otlp'], notification, extraEnv);
      return { home, res, portHeldBefore };
    }

    it('starting the proxy writes nothing to stdout or stderr; the cold start is in the file log', async () => {
      const { home, res, portHeldBefore } = await runColdOtlpHook({ CODEMIE_DEBUG: '1' });

      expect(res.stdout).toBe('');
      expect(res.stderr).toBe('');
      expect(fileLog(home)).toContain('[daemon-manager] Spawning daemon');
      expect(existsSync(join(home, 'sso-login.lock'))).toBe(false);
      expect(await portHeld(DAEMON_PORT)).toBe(portHeldBefore);
    });

    it('without CODEMIE_DEBUG the proxy status line still reaches the file log, and nothing reaches stdout or stderr', async () => {
      const { home, res } = await runColdOtlpHook({});

      expect(res.stdout).toBe('');
      expect(res.stderr).toBe('');
      expect(fileLog(home)).toMatch(/\[INFO\][^\n]* Starting proxy\.\.\.\n/);
      expect(fileLog(home)).not.toContain('[DEBUG]');
    });
  });

  // Spawned, not a processEvent unit call: the failure line is printed by the command's action, so the whole
  // stderr of a missing CODEMIE_AGENT is observable only on the CLI process.
  it('a missing CODEMIE_AGENT leaves only the failure line on stderr; the variable names go to the file log under CODEMIE_DEBUG', async () => {
    const home = freshHome();
    const res = await run(home, ['hook'], sessionStart(home), { CODEMIE_AGENT: '', CODEMIE_DEBUG: '1' });

    expect(res.code).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).not.toContain('[hook:debug]');
    const lines = res.stderr.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('codemie hook: SessionStart failed: CODEMIE_AGENT environment variable is required');
    expect(fileLog(home)).toContain('[hook:debug] CODEMIE_AGENT missing. Available CODEMIE_* vars: ');
  });

  it('with CODEMIE_DEBUG=1 the hook keeps stdout and stderr empty and writes its debug lines to the file log', async () => {
    const home = freshHome();
    const res = await run(home, ['hook'], sessionStart(home), { CODEMIE_DEBUG: '1' });
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
    expect(fileLog(home)).toContain('[hook] Received input');
  });

  it('with CODEMIE_DEBUG=1 invalid JSON exits 2 with only the hook\'s own message on stderr', async () => {
    const home = freshHome();
    const res = await run(home, ['hook'], '{not json', { CODEMIE_DEBUG: '1' });
    expect(res.code).toBe(2);
    expect(res.stdout).toBe('');
    const lines = res.stderr.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('codemie hook: failed to parse hook input JSON')).toBe(true);
  });

  it('a failing migration inside a hook stays off stdout and stderr, is logged to the file, and the event is still processed', async () => {
    const warm = await warmHome();
    const control = await run(warm, ['hook'], sessionStart(warm));
    const home = freshHome();
    // An unparseable legacy config makes migration 001 fail.
    writeFileSync(join(home, 'config.json'), '{ not json', 'utf-8');

    // CODEMIE_DEBUG: the failure's logger.error then has a console copy that must stay off stderr too.
    const res = await run(home, ['hook'], sessionStart(home), { CODEMIE_DEBUG: '1' });

    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
    expect(res.code).toBe(control.code);
    expect(fileLog(home)).toContain('Migration 001-config-rename failed');
    expect(fileLog(warm)).toContain(PROCESSED);
    expect(fileLog(home)).toContain(PROCESSED);
  });

  it('a hook with stdin closed at EOF exits as the control does (no prompt reads its stdin)', async () => {
    const control = await run(await warmHome(), ['hook'], '');
    const home = freshHome();

    const res = await run(home, ['hook'], '');

    expect(res.stdout).toBe('');
    expect(res.code).toBe(control.code);
  });

  describe('what\'s-new notice', () => {
    let pkg: string;

    // A copy of the package with its own CHANGELOG.md: the notice reads the
    // changelog next to dist/, and ESM resolves a symlinked dist to the repo.
    beforeAll(() => {
      pkg = mkdtempSync(join(tmpdir(), 'codemie-whatsnew-pkg-'));
      for (const entry of ['bin', 'dist', 'package.json']) {
        cpSync(join(REPO_ROOT, entry), join(pkg, entry), { recursive: true });
      }
      mkdirSync(join(pkg, 'src', 'utils'), { recursive: true });
      cpSync(join(REPO_ROOT, 'src', 'utils', 'tips.json'), join(pkg, 'src', 'utils', 'tips.json'));
      symlinkSync(join(REPO_ROOT, 'node_modules'), join(pkg, 'node_modules'), 'junction');
    }, 60_000);

    afterAll(() => {
      rmSync(pkg, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    // Above the installed version, so it is outside the notice's last-seen..installed range.
    const OTHER_VERSION = '99.0.0';
    const WITH_ENTRY = [
      '# Changelog',
      '',
      `## [${OTHER_VERSION}] - 2026-01-02`,
      '',
      '### Added',
      '',
      '- Newer entry bullet',
      '',
      `## [${VERSION}] - 2026-01-01`,
      '',
      '### Fixed',
      '',
      '- Installed version bullet',
      '',
    ].join('\n');
    const WITHOUT_ENTRY = [
      '# Changelog',
      '',
      `## [${OTHER_VERSION}] - 2026-01-02`,
      '',
      '### Added',
      '',
      '- Newer entry bullet',
      '',
    ].join('\n');

    function writeChangelog(text: string): void {
      writeFileSync(join(pkg, 'CHANGELOG.md'), text, 'utf-8');
    }

    // The terminal gate reads only process.stdout.isTTY, so a preload stubs it on a piped child instead of a
    // real pty: the cli project runs in CI on Linux and Windows, where a native pty module may not load or
    // behaves differently under ConPTY. --require, not --import: the engines floor (Node 20.0) predates --import.
    async function runInTerminal(home: string, args: string[]): Promise<string> {
      const preload = join(home, 'stdout-is-tty.cjs');
      writeFileSync(preload, 'process.stdout.isTTY = true;\n', 'utf-8');
      const res = await run(home, args, '', {}, join(pkg, 'bin', 'codemie.js'), ['--require', preload]);
      return res.stdout;
    }

    const marker = (home: string): string => readFileSync(join(home, '.last-seen-version'), 'utf-8').trim();

    it('a piped command prints no notice and keeps the marker', async () => {
      writeChangelog(WITH_ENTRY);
      const home = await warmHome();
      writeFileSync(join(home, '.last-seen-version'), OLD_MARKER, 'utf-8');

      const res = await run(home, ['list'], '', {}, join(pkg, 'bin', 'codemie.js'));

      expect(res.stdout).not.toContain('Updated to');
      expect(marker(home)).toBe(OLD_MARKER);
    });

    it('in a terminal the notice shows the installed version\'s own entry and writes the marker', async () => {
      writeChangelog(WITH_ENTRY);
      const home = await warmHome();
      writeFileSync(join(home, '.last-seen-version'), OLD_MARKER, 'utf-8');

      const out = await runInTerminal(home, ['list']);

      expect(out).toContain(`Updated to ${VERSION}`);
      expect(out).toContain(`What's new in ${VERSION}`);
      expect(out).toContain('Installed version bullet');
      expect(out).not.toContain('Newer entry bullet');
      expect(marker(home)).toBe(VERSION);
    });

    it('in a terminal, no entry for the installed version prints no notes and still writes the marker', async () => {
      writeChangelog(WITHOUT_ENTRY);
      const home = await warmHome();
      writeFileSync(join(home, '.last-seen-version'), OLD_MARKER, 'utf-8');

      const out = await runInTerminal(home, ['list']);

      expect(out).toContain(`Updated to ${VERSION}`);
      expect(out).toContain('codemie whatsnew --all');
      expect(out).not.toContain("What's new in");
      expect(out).not.toContain('Newer entry bullet');
      expect(marker(home)).toBe(VERSION);
    });

    it('codemie whatsnew for a version without an entry says so and shows no other version', async () => {
      writeChangelog(WITHOUT_ENTRY);
      const home = await warmHome();

      const res = await run(home, ['whatsnew', VERSION], '', {}, join(pkg, 'bin', 'codemie.js'));

      expect(res.code).toBe(0);
      expect(res.stdout).toContain(`No release notes for ${VERSION}`);
      expect(res.stdout).not.toContain('Newer entry bullet');
    });
  });
});
