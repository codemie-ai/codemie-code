/**
 * `codemie proxy status` and `codemie proxy doctor` against a real daemon: Claude Code OTLP endpoint/key mismatch
 * reporting. The status prints facts only and one `Issues found` line; the doctor names the mismatch. It also covers
 * the latest drop of a session whose project changed (EPMCDME-17386), which `proxy doctor` and
 * `proxy analytics status --json` report.
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
import { delimiter, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProcessAlive, spawnDetached } from '../../src/utils/processes.js';
import { appendSpool, snapshotPendingBytes } from '../../src/providers/plugins/sso/proxy/plugins/otlp-spool/spool-io.js';
import { isolatedEnv, realDir, runIsolatedCli, expectExit, describeRun } from '../helpers/isolated-cli.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DAEMON_BIN = join(REPO_ROOT, 'bin', 'proxy-daemon.js');
const DAEMON_DIST = join(REPO_ROOT, 'dist', 'bin', 'proxy-daemon.js');

const GATEWAY_KEY = 'codemie-status-mismatch-test';
const CLI_VERSION = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string }).version;
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
  // Every client config the status reads lives under the temporary home, and no `codemie` is on PATH.
  const statusEnv = (): Record<string, string> => ({
    CODEX_HOME: join(homes.userHome, '.codex'),
    XDG_CONFIG_HOME: homes.userHome,
    APPDATA: homes.userHome,
    PATH: ['/usr/bin', '/bin'].join(delimiter),
  });
  const status = (...extra: string[]) =>
    runIsolatedCli(homes, ['proxy', 'status', ...extra], { cwd: root, env: statusEnv() });
  const statusJson = (): Record<string, unknown> => {
    const result = status('--json');
    expectExit(result, 0);
    return JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))) as Record<string, unknown>;
  };
  const ISSUES_LINE = 'Issues found — run: codemie proxy doctor';
  /** The `claude-code-otlp` section of `proxy doctor --json` (its exit code follows its other sections). */
  const doctorOtlp = (): { status: string; message: string; hint?: string } | undefined => {
    const result = runIsolatedCli(homes, ['proxy', 'doctor', '--json'], { cwd: root, env: statusEnv() });
    const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))) as {
      sections: Array<{ id: string; status: string; message: string; hint?: string }>;
    };
    return report.sections.find((section) => section.id === 'claude-code-otlp');
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

  it('prints the daemon\'s Version, the masked key and no Client line', () => {
    const result = status();

    expectExit(result, 0);
    expect(result.stdout, describeRun(result)).toContain(`  Version: ${CLI_VERSION}`);
    expect(result.stdout).toContain('  API Key: ****');
    expect(result.stdout).not.toContain(GATEWAY_KEY);
    expect(result.stdout).not.toMatch(/^ {2}Client: /m);
    expect(statusJson().apiKey).toBe('****');
    expect(status('--show-key').stdout).toContain(`  API Key: ${GATEWAY_KEY}`);
  });

  it('points a Codex config in the temporary home set up for another port to proxy doctor', () => {
    const codexHome = join(homes.userHome, '.codex');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'config.toml'), [
      '# >>> codemie proxy connect (codex-desktop) provider - managed block, do not edit',
      '[model_providers.codemie]',
      'base_url = "http://127.0.0.1:52311/v1"',
      '[model_providers.codemie.http_headers]',
      `Authorization = "Bearer ${GATEWAY_KEY}.codex-desktop"`,
      '# <<< codemie proxy connect (codex-desktop) provider',
      '',
    ].join('\n'));
    try {
      const result = status();

      expectExit(result, 0);
      expect(result.stdout, describeRun(result)).toContain(ISSUES_LINE);
      expect(result.stdout).not.toContain('Codex desktop');
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  describe('stale endpoint (key matches)', () => {
    const staleEndpoint = `http://127.0.0.1:47999${OTLP_PATH}`;

    // @case otlp-endpoint-respawn-recovery_TC_003
    it('status --json carries no mismatch field; proxy doctor reports the configured and expected endpoints', () => {
      writeSettings({
        OTEL_EXPORTER_OTLP_ENDPOINT: staleEndpoint,
        OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${GATEWAY_KEY}`,
      });

      expect(statusJson()).not.toHaveProperty('otlpEndpointMismatch');
      const section = doctorOtlp();
      expect(section?.status).toBe('error');
      expect(section?.message).toContain(
        `Claude Code OTLP endpoint ${staleEndpoint} does not match this proxy (${daemonUrl}${OTLP_PATH})`
      );
    });

    // @case otlp-endpoint-respawn-recovery_TC_003
    it('status text prints the Issues line and no warning; proxy doctor gives the repair hint', () => {
      writeSettings({
        OTEL_EXPORTER_OTLP_ENDPOINT: staleEndpoint,
        OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${GATEWAY_KEY}`,
      });

      const result = status();

      expectExit(result, 0);
      expect(result.stdout, describeRun(result)).toContain(ISSUES_LINE);
      expect(result.stdout).not.toContain('does not match');
      expect(doctorOtlp()?.hint).toContain('codemie proxy connect --claude-otlp');
    });
  });

  describe('stale gateway key (endpoint matches)', () => {
    const liveEndpoint = (): string => `${daemonUrl}${OTLP_PATH}`;

    // @case otlp-endpoint-respawn-recovery_TC_003
    it('status --json carries no mismatch field; proxy doctor reports the key mismatch', () => {
      writeSettings({
        OTEL_EXPORTER_OTLP_ENDPOINT: liveEndpoint(),
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer some-old-key',
      });

      expect(statusJson()).not.toHaveProperty('otlpEndpointMismatch');
      const section = doctorOtlp();
      expect(section?.status).toBe('error');
      expect(section?.message).toContain('The gateway key in Claude Code OTEL_EXPORTER_OTLP_HEADERS does not match this proxy');
    });

    // @case otlp-endpoint-respawn-recovery_TC_003
    it('status text prints the Issues line and not the key warning', () => {
      writeSettings({
        OTEL_EXPORTER_OTLP_ENDPOINT: liveEndpoint(),
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer some-old-key',
      });

      const result = status();

      expectExit(result, 0);
      expect(result.stdout, describeRun(result)).toContain(ISSUES_LINE);
      expect(result.stdout).not.toContain('OTEL_EXPORTER_OTLP_HEADERS');
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
      expect(text.stdout).not.toContain('does not match');
      expect(payload.port).toBe(TEST_PORT);
      expect(payload).not.toHaveProperty('otlpEndpointMismatch');
      expect(doctorOtlp()?.status).toBe('ok');
    });

    // @case otlp-endpoint-respawn-recovery_TC_003
    it('ignores a foreign OTLP endpoint that CodeMie does not own', () => {
      writeSettings({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com/v1/traces' });

      const text = status();
      const payload = statusJson();

      expectExit(text, 0);
      expect(text.stdout).not.toContain('does not match');
      expect(payload).not.toHaveProperty('otlpEndpointMismatch');
      expect(doctorOtlp()).toBeUndefined();
    });
  });

  describe('a session whose project changed (EPMCDME-17386)', () => {
    const SESSION = 'c0ffee00-17386-4a11-9b3d-conflict-discard';
    const HINT = 'the session used folders that belong to different CodeMie projects; part of its data was not sent';
    let previousHome: string | undefined;
    let discardedAfter = 0;
    let discardedBefore = 0;

    const hookLine = (project: string): string =>
      JSON.stringify({
        agentName: 'claude-code-otlp',
        hookEvent: JSON.stringify({ type: 'agent.tool.end', session_id: SESSION, codemie_project_name: project }),
      }) + '\n';

    const jsonOf = (stdout: string): Record<string, unknown> =>
      JSON.parse(stdout.slice(stdout.indexOf('{'))) as Record<string, unknown>;

    beforeAll(async () => {
      expect(daemonPid, 'daemon did not become ready within 8s').toBeGreaterThan(0);
      // A connected analytics connector is what makes the delivery section visible at all.
      writeFileSync(settingsFile, JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'codemie hook --agent claude-code-otlp' }] }] },
      }, null, 2), 'utf-8');

      // The real spool code writes into the daemon's CODEMIE_HOME: a session bound to project A, some OTEL
      // bytes, then a hook of project B. The next snapshot finds the session conflicted and discards them.
      previousHome = process.env.CODEMIE_HOME;
      process.env.CODEMIE_HOME = homes.codemieHome;
      await appendSpool(SESSION, 'hooks', hookLine('project-a'), ['project-a']);
      await appendSpool(SESSION, 'logs', Buffer.from('unsent otel bytes'));
      await appendSpool(SESSION, 'hooks', hookLine('project-b'), ['project-b']);
      discardedAfter = Date.now();
      expect(await snapshotPendingBytes(SESSION, 'logs')).toBeNull();
      discardedBefore = Date.now();
    }, 30_000);

    afterAll(() => {
      if (previousHome === undefined) delete process.env.CODEMIE_HOME;
      else process.env.CODEMIE_HOME = previousHome;
      writeSettings({});
    });

    it('proxy doctor reports the discard as the last drop, with the explanation', () => {
      const result = runIsolatedCli(homes, ['proxy', 'doctor', '--json'], { cwd: root, env: statusEnv() });
      const report = jsonOf(result.stdout) as { sections: Array<{ id: string; message: string; hint?: string }> };
      const drop = report.sections.find((section) => section.id === 'delivery' && section.message.startsWith('Last dropped'));

      expect(drop?.message, describeRun(result)).toMatch(/^Last dropped: project_conflict_discard \(logs, \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}\)$/);
      expect(drop?.hint).toBe(HINT);
    });

    it('proxy analytics status --json carries it as delivery.latestDrop', () => {
      const result = runIsolatedCli(homes, ['proxy', 'analytics', 'status', '--json'], { cwd: root, env: statusEnv() });

      expectExit(result, 0);
      const delivery = jsonOf(result.stdout).delivery as { latestDrop?: { reason: string; stream?: string; at: number; local: boolean } };
      expect(delivery.latestDrop, describeRun(result)).toMatchObject({ reason: 'project_conflict_discard', stream: 'logs', local: true });
      expect(delivery.latestDrop!.at).toBeGreaterThanOrEqual(discardedAfter);
      expect(delivery.latestDrop!.at).toBeLessThanOrEqual(discardedBefore);
    });
  });
});
