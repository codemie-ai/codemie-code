/**
 * `codemie proxy status` against a real daemon: Claude Code OTLP endpoint/key mismatch reporting.
 *
 * The daemon is the real detached bin/proxy-daemon.js (JWT boot with a dummy token, so no SSO or
 * network is involved). `proxy status` runs in a child process against a private CODEMIE_HOME and
 * user home, so the settings file it reads is a temp one, never the developer's ~/.claude.
 *
 * Requires dist/ built. Run: npx vitest run --project cli tests/integration/proxy-status-otlp-mismatch.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProcessAlive, spawnDetached } from '../../src/utils/processes.js';
import { isolatedEnv, realDir, runIsolatedCli, expectExit, describeRun } from '../helpers/isolated-cli.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DAEMON_BIN = join(REPO_ROOT, 'bin', 'proxy-daemon.js');
const DAEMON_DIST = join(REPO_ROOT, 'dist', 'bin', 'proxy-daemon.js');

const GATEWAY_KEY = 'codemie-status-mismatch-test';
const OTLP_PATH = '/v1/analytics/otlp';

/** A currently free loopback port: listen on 0, read the assigned port, close. */
function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });
}

describe.skipIf(!existsSync(DAEMON_DIST))('proxy status OTLP endpoint mismatch (real daemon)', () => {
  let TEST_PORT = 0;
  let root: string;
  let homes: { codemieHome: string; userHome: string };
  let settingsFile: string;
  let daemonPid = -1;
  let daemonUrl = '';

  const writeSettings = (env: Record<string, string>): void => {
    writeFileSync(settingsFile, JSON.stringify({ env }, null, 2), 'utf-8');
  };
  const status = (...extra: string[]) =>
    runIsolatedCli(homes, ['proxy', 'status', ...extra], { cwd: root });
  const statusJson = (): Record<string, unknown> => {
    const result = status('--json');
    expectExit(result, 0);
    return JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))) as Record<string, unknown>;
  };

  beforeAll(async () => {
    TEST_PORT = await getFreePort();
    root = realDir(mkdtempSync(join(tmpdir(), 'codemie-status-otlp-')));
    homes = { codemieHome: realDir(join(root, 'codemie-home')), userHome: realDir(join(root, 'user-home')) };
    mkdirSync(join(homes.userHome, '.claude'), { recursive: true });
    settingsFile = join(homes.userHome, '.claude', 'settings.json');
    const stateFile = join(homes.codemieHome, 'proxy-daemon.json');

    spawnDetached(process.execPath, [
      DAEMON_BIN,
      '--target-url', 'https://status-mismatch.invalid/code-assistant-api',
      '--provider', 'jwt',
      '--auth-method', 'jwt',
      '--profile', 'status-otlp-mismatch-test',
      '--gateway-key', GATEWAY_KEY,
      '--state-file', stateFile,
      '--port', String(TEST_PORT),
    ], {
      env: {
        ...isolatedEnv(),
        CODEMIE_HOME: homes.codemieHome,
        HOME: homes.userHome,
        USERPROFILE: homes.userHome,
        CODEMIE_JWT_TOKEN: 'dummy-token-for-status-test',
      } as NodeJS.ProcessEnv,
    });

    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (existsSync(stateFile)) {
        try {
          const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as { pid: number; url: string };
          if (isProcessAlive(state.pid)) {
            daemonPid = state.pid;
            daemonUrl = state.url;
            break;
          }
        } catch {
          /* state file mid-write; poll again */
        }
      }
    }
  }, 30_000);

  afterAll(() => {
    if (daemonPid > 0) {
      try { process.kill(daemonPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    // Retries cover file handles a killed daemon releases a moment later on Windows.
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  // @case otlp-endpoint-respawn-recovery_TC_003
  it('starts a live daemon the status command can see', () => {
    expect(daemonPid, 'daemon did not become ready within 8s').toBeGreaterThan(0);
    expect(daemonUrl).toContain(String(TEST_PORT));
  });

  describe('stale endpoint (key matches)', () => {
    const staleEndpoint = `http://127.0.0.1:47999${OTLP_PATH}`;

    // @case otlp-endpoint-respawn-recovery_TC_003
    it('--json reports otlpEndpointMismatch with the configured and expected endpoints', () => {
      writeSettings({
        OTEL_EXPORTER_OTLP_ENDPOINT: staleEndpoint,
        OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${GATEWAY_KEY}`,
      });

      const payload = statusJson();

      expect(payload.otlpEndpointMismatch).toEqual({
        configured: staleEndpoint,
        expected: `${daemonUrl}${OTLP_PATH}`,
      });
    });

    // @case otlp-endpoint-respawn-recovery_TC_003
    it('text output warns about the endpoint and prints the repair hint', () => {
      writeSettings({
        OTEL_EXPORTER_OTLP_ENDPOINT: staleEndpoint,
        OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${GATEWAY_KEY}`,
      });

      const result = status();

      expectExit(result, 0);
      expect(result.stdout, describeRun(result)).toContain(
        `Claude Code OTLP endpoint ${staleEndpoint} does not match this daemon (${daemonUrl}${OTLP_PATH})`
      );
      expect(result.stdout).toContain('codemie proxy connect --claude-code-otlp');
    });
  });

  describe('stale gateway key (endpoint matches)', () => {
    const liveEndpoint = (): string => `${daemonUrl}${OTLP_PATH}`;

    // @case otlp-endpoint-respawn-recovery_TC_003
    it('--json reports a mismatch whose configured endpoint equals the expected one', () => {
      writeSettings({
        OTEL_EXPORTER_OTLP_ENDPOINT: liveEndpoint(),
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer some-old-key',
      });

      const payload = statusJson();

      expect(payload.otlpEndpointMismatch).toEqual({ configured: liveEndpoint(), expected: liveEndpoint() });
    });

    // @case otlp-endpoint-respawn-recovery_TC_003
    it('text output warns that the gateway key does not match', () => {
      writeSettings({
        OTEL_EXPORTER_OTLP_ENDPOINT: liveEndpoint(),
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer some-old-key',
      });

      const result = status();

      expectExit(result, 0);
      expect(result.stdout, describeRun(result)).toContain(
        'the gateway key in Claude Code OTEL_EXPORTER_OTLP_HEADERS does not match this daemon'
      );
    });
  });

  describe('no mismatch', () => {
    // @case otlp-endpoint-respawn-recovery_TC_003
    it('stays silent when endpoint and key match the live daemon', () => {
      writeSettings({
        OTEL_EXPORTER_OTLP_ENDPOINT: `${daemonUrl}${OTLP_PATH}`,
        OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${GATEWAY_KEY}`,
      });

      const text = status();
      const payload = statusJson();

      expectExit(text, 0);
      expect(text.stdout).not.toContain('does not match this daemon');
      expect(payload.port).toBe(TEST_PORT);
      expect(payload).not.toHaveProperty('otlpEndpointMismatch');
    });

    // @case otlp-endpoint-respawn-recovery_TC_003
    it('ignores a foreign OTLP endpoint that CodeMie does not own', () => {
      writeSettings({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com/v1/traces' });

      const text = status();
      const payload = statusJson();

      expectExit(text, 0);
      expect(text.stdout).not.toContain('does not match this daemon');
      expect(payload).not.toHaveProperty('otlpEndpointMismatch');
    });
  });
});
