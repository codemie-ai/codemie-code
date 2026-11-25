/**
 * `codemie completion <shell>` stdout purity - CLI contract tests
 *
 * The script is eval'ed / redirected into a file, so stdout must carry the script
 * and nothing else: no migration progress, update prompts, what's-new notice or
 * debug logging. Drives the built bin/codemie.js in an isolated temp home with a
 * pending migration, the update check enabled and CODEMIE_DEBUG=true.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BIN = join(REPO_ROOT, 'bin', 'codemie.js');
const RUN_TIMEOUT_MS = 20_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

describe('completion stdout purity', () => {
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

  afterEach(() => {
    registryHits = 0;
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  /** A home right after an upgrade: no migrations.json (pending migrations), older what's-new marker. */
  function freshHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'codemie-completion-stdout-'));
    homes.push(home);
    writeFileSync(join(home, '.last-seen-version'), '0.0.1', 'utf-8');
    return home;
  }

  function cliEnv(home: string, extraEnv: Record<string, string>): NodeJS.ProcessEnv {
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
    env.npm_config_registry = registryUrl;
    env.npm_config_update_notifier = 'false';
    env.CODEMIE_HOME = home;
    Object.assign(env, extraEnv);
    return env;
  }

  function run(home: string, args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
    const env = cliEnv(home, extraEnv);
    return new Promise((done, fail) => {
      const child = spawn(process.execPath, [BIN, ...args], { cwd: home, env, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => (stdout += chunk));
      child.stderr.on('data', chunk => (stderr += chunk));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        fail(new Error(`codemie ${args.join(' ')} timed out\nstderr: ${stderr}`));
      }, RUN_TIMEOUT_MS);
      child.on('error', fail);
      child.on('close', code => {
        clearTimeout(timer);
        done({ code, stdout, stderr });
      });
      child.stdin.end('');
    });
  }

  /** The script the command prints when nothing at start-up can interfere (migrations already done, no debug). */
  async function quietScript(shell: string): Promise<string> {
    const home = freshHome();
    await run(home, ['version']); // completes start-up work (migrations, update check)
    const res = await run(home, ['completion', shell]);
    expect(res.code).toBe(0);
    return res.stdout;
  }

  for (const shell of ['bash', 'zsh', 'fish'] as const) {
    it(`completion ${shell} prints the script only, with pending migrations, update check and CODEMIE_DEBUG=true`, async () => {
      const expected = await quietScript(shell);
      expect(expected.length).toBeGreaterThan(0);
      registryHits = 0;
      const home = freshHome();

      const res = await run(home, ['completion', shell], { CODEMIE_DEBUG: 'true' });

      expect(res.code).toBe(0);
      expect(res.stdout).toBe(expected);
      expect(res.stdout).not.toContain('migration(s)');
      expect(res.stdout).not.toContain('Updated to');
      expect(registryHits).toBe(0);
      expect(existsSync(join(home, 'migrations.json'))).toBe(false);
      expect(existsSync(join(home, '.last-update-check'))).toBe(false);
      expect(readFileSync(join(home, '.last-seen-version'), 'utf-8').trim()).toBe('0.0.1');
    });
  }

  it('an error path still surfaces on stderr, with stdout empty and a non-zero exit', async () => {
    const home = freshHome();
    const res = await run(home, ['completion', 'powershell'], { CODEMIE_DEBUG: 'true' });
    expect(res.code).not.toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/bash/);
  });

  // Windows runners have no supported bash target; the script syntax is covered by the POSIX jobs.
  const bashAvailable = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0;
  it.skipIf(!bashAvailable)('the bash output passes bash -n under the same conditions', async () => {
    const home = freshHome();
    const res = await run(home, ['completion', 'bash'], { CODEMIE_DEBUG: 'true' });
    const syntax = spawnSync('bash', ['-n'], { input: res.stdout, encoding: 'utf-8' });
    expect(syntax.status).toBe(0);
    expect(syntax.stderr).toBe('');
  });
});
