/**
 * Hook respawn of the proxy daemon on a different port: Claude Code's OTLP settings follow it.
 *
 * Runs the real `ensureOtlpProxy` and the real detached bin/proxy-daemon.js. Port 4001 (then the
 * first fallback port) is held by a throwaway listener so each respawn lands on a different port.
 * The profile has no SSO login, so the daemon holds its port with the placeholder listener, which
 * needs no network. Everything lives in temp CODEMIE_HOME / user-home directories; the developer's
 * real ~/.claude and ~/.codemie are never read or written.
 *
 * Requires dist/ built. Run: npx vitest run --project cli tests/integration/proxy-otlp-respawn-recovery.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DAEMON_DIST = join(REPO_ROOT, 'dist', 'bin', 'proxy-daemon.js');

const AGENT = 'claude-code-otlp';
const DEFAULT_PORT = 4001;
const OTLP_PATH = '/v1/analytics/otlp';
const PROFILE = 'respawn-recovery-test';

type DaemonManager = typeof import('../../src/cli/commands/proxy/daemon-manager.js');

/** Holds `port` on 127.0.0.1; resolves to null when something else already holds it (that also blocks the daemon). */
function holdPort(port: number): Promise<Server | null> {
  return new Promise((resolveHold) => {
    const server = createServer();
    server.once('error', () => resolveHold(null));
    server.listen(port, '127.0.0.1', () => resolveHold(server));
  });
}

function release(server: Server | null): Promise<void> {
  return new Promise((done) => (server ? server.close(() => done()) : done()));
}

describe.skipIf(!existsSync(DAEMON_DIST))('OTLP endpoint after a daemon respawn on another port', () => {
  let root: string;
  let userHome: string;
  let codemieHome: string;
  let settingsFile: string;
  let dm: DaemonManager;
  let ensureOtlpProxy: (agent: string) => Promise<void>;
  const blockers: Array<Server | null> = [];
  const savedEnv: Record<string, string | undefined> = {};
  const savedCwd = process.cwd();
  let daemonPid = -1;

  const readSettingsEnv = (): Record<string, string> =>
    (JSON.parse(readFileSync(settingsFile, 'utf-8')) as { env: Record<string, string> }).env;

  beforeAll(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'codemie-otlp-respawn-')));
    codemieHome = join(root, 'codemie-home');
    userHome = join(root, 'user-home');
    const workDir = join(root, 'work');
    for (const dir of [codemieHome, join(userHome, '.claude'), workDir]) mkdirSync(dir, { recursive: true });
    settingsFile = join(userHome, '.claude', 'settings.json');

    // Nothing from the developer's shell may steer the profile, proxy or settings location.
    for (const key of Object.keys(process.env)) {
      if (/^(CODEMIE_|CLAUDE_|ANTHROPIC_|OTEL_)/i.test(key)) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
    for (const key of ['HOME', 'USERPROFILE', 'CODEMIE_HOME']) {
      // CODEMIE_HOME was already saved (and deleted) by the sweep above; keep that original value.
      if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    }
    process.env.CODEMIE_HOME = codemieHome;
    process.env.HOME = userHome;
    process.env.USERPROFILE = userHome;
    process.chdir(workDir);

    writeFileSync(join(codemieHome, 'codemie-cli.config.json'), JSON.stringify({
      version: 2,
      activeProfile: PROFILE,
      profiles: {
        [PROFILE]: {
          name: PROFILE,
          provider: 'ai-run-sso',
          baseUrl: 'https://respawn-recovery.invalid/code-assistant-api',
          codeMieUrl: 'https://respawn-recovery.invalid',
        },
      },
    }, null, 2), 'utf-8');

    // A settings file as `connect --claude-code-otlp` leaves it: CodeMie's pair pointing at the
    // default port with an old key, next to settings that are not CodeMie's.
    writeFileSync(settingsFile, JSON.stringify({
      theme: 'dark',
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${DEFAULT_PORT}${OTLP_PATH}`,
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer stale-gateway-key',
        MY_OWN_SETTING: 'keep-me',
      },
    }, null, 2), 'utf-8');

    // Imported after CODEMIE_HOME is set: daemon-manager derives its state file path at load time.
    dm = await import('../../src/cli/commands/proxy/daemon-manager.js');
    ({ ensureOtlpProxy } = await import('../../src/cli/commands/proxy/otlp-cold-start.js'));
  }, 30_000);

  afterAll(async () => {
    try { if (dm) await dm.stopDaemon(); } catch { /* fall through to hard kill */ }
    if (daemonPid > 0) {
      try { process.kill(daemonPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    for (const blocker of blockers) await release(blocker);
    process.chdir(savedCwd);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (root) rmSync(root, { recursive: true, force: true });
  }, 30_000);

  // @case otlp-endpoint-respawn-recovery_TC_001
  it('rewrites the endpoint and key when the respawned daemon lands on a different port', async () => {
    // First start: the default port is busy, so the daemon falls back to another one.
    blockers.push(await holdPort(DEFAULT_PORT));
    await ensureOtlpProxy(AGENT);

    const first = await dm.readState();
    expect(first, 'first daemon state').not.toBeNull();
    daemonPid = first!.pid;
    const firstPort = first!.port;
    expect(firstPort).not.toBe(DEFAULT_PORT);

    const afterFirst = readSettingsEnv();
    expect(afterFirst.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(`http://127.0.0.1:${firstPort}${OTLP_PATH}`);
    expect(afterFirst.OTEL_EXPORTER_OTLP_HEADERS).toBe(`Authorization=Bearer ${first!.gatewayKey}`);

    // Daemon goes away and its port is taken meanwhile: the next hook respawns it elsewhere.
    await dm.stopDaemon();
    expect(await dm.readState()).toBeNull();
    blockers.push(await holdPort(firstPort));

    await ensureOtlpProxy(AGENT);

    const second = await dm.readState();
    expect(second, 'respawned daemon state').not.toBeNull();
    daemonPid = second!.pid;
    expect(second!.port).not.toBe(firstPort);
    expect(second!.port).not.toBe(DEFAULT_PORT);

    const settings = JSON.parse(readFileSync(settingsFile, 'utf-8')) as { theme: string; env: Record<string, string> };
    expect(settings.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(`${second!.url}${OTLP_PATH}`);
    expect(settings.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(`http://127.0.0.1:${second!.port}${OTLP_PATH}`);
    expect(settings.env.OTEL_EXPORTER_OTLP_HEADERS).toBe(`Authorization=Bearer ${second!.gatewayKey}`);
    // Only CodeMie's own pair is touched.
    expect(settings.env.MY_OWN_SETTING).toBe('keep-me');
    expect(settings.theme).toBe('dark');
  }, 60_000);
});
