/**
 * Proxy daemon lifecycle — real-spawn integration test.
 *
 * WHY THIS EXISTS
 * ---------------
 * `daemon-manager.test.ts` mocks `spawnDetached`, and `endpoint-blocking.test.ts`
 * runs `CodeMieProxy` in-process against a mock upstream. Neither ever spawns the
 * real detached `bin/proxy-daemon.js` subprocess. So the release-critical path —
 * detached spawn → state-file write → readiness poll → local serving → SIGTERM
 * shutdown → state cleanup — is only ever verified by hand (`codemie proxy
 * start` / `stop`). This test closes that gap.
 *
 * It exercises REAL work with ZERO external credentials:
 *   - spawns the real daemon process (bin/proxy-daemon.js → dist)
 *   - the daemon binds a real local port and serves the pre-auth /health endpoint
 *   - the REAL production functions readState / checkStatus / checkProxyHealth /
 *     stopDaemon are driven against that live process
 *   - stop goes through the real SIGTERM→SIGKILL path; we assert the PID is reaped
 *     and the state file is cleared.
 *
 * The daemon boots in JWT auth-method with a DUMMY token: the JWT boot path only
 * checks the token is *present* (it is validated upstream only on a real gateway
 * request, which /health never makes), so the local server comes up and serves
 * /health with no keychain/SSO/network dependency. That keeps this test fully
 * deterministic and runnable in CI. The SSO-credential boot path is already
 * exercised indirectly by the agent-tier tests (every agent run starts the real
 * proxy); what was missing — and what this adds — is explicit lifecycle
 * verification and a credential-free variant.
 *
 * ISOLATION / CLEANUP
 * -------------------
 *   - Unique temp CODEMIE_HOME, so the state file never touches the developer's
 *     real ~/.codemie/proxy-daemon.json.
 *   - daemon-manager is imported dynamically AFTER CODEMIE_HOME is set, so its
 *     module-level DEFAULT_STATE_FILE resolves inside the temp home.
 *   - afterAll ALWAYS stops the daemon (even if assertions failed), hard-kills any
 *     survivor, restores env, and removes the temp home — no orphan survives.
 *
 * Requires dist/ built (CI builds before running tests; locally run
 * `npm run build` first). If dist is missing the suite skips with a warning.
 *
 * Run: npx vitest run --project cli -- proxy-daemon-lifecycle
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DAEMON_BIN = join(REPO_ROOT, 'bin', 'proxy-daemon.js');
const DAEMON_DIST = join(REPO_ROOT, 'dist', 'bin', 'proxy-daemon.js');

// Uncommon fixed port to avoid colliding with a real running proxy on the
// default daemon port. Deterministic so a leaked listener is easy to spot.
const TEST_PORT = 47317;
const GATEWAY_KEY = 'codemie-proxy-lifecycle-test';
const PROFILE = 'proxy-daemon-lifecycle-test';

type DaemonManager = typeof import('../../src/cli/commands/proxy/daemon-manager.js');
type HealthCheck = typeof import('../../src/cli/commands/proxy/health-check.js');
type Processes = typeof import('../../src/utils/processes.js');

describe.skipIf(!existsSync(DAEMON_DIST))('Proxy daemon lifecycle (real spawn)', () => {
  let testHome: string;
  let originalHome: string | undefined;
  let originalJwt: string | undefined;
  let stateFile: string;
  let dm: DaemonManager;
  let health: HealthCheck;
  let daemonPid = -1;

  beforeAll(async () => {
    originalHome = process.env.CODEMIE_HOME;
    originalJwt = process.env.CODEMIE_JWT_TOKEN;
    testHome = mkdtempSync(join(tmpdir(), 'codemie-proxy-daemon-'));
    stateFile = join(testHome, 'proxy-daemon.json');

    // Set BEFORE importing daemon-manager: DEFAULT_STATE_FILE is derived from
    // getCodemieHome() at module-load time. The dummy token satisfies the JWT
    // boot's presence check without any real credential.
    process.env.CODEMIE_HOME = testHome;
    process.env.CODEMIE_JWT_TOKEN = 'dummy-token-for-lifecycle-test';

    dm = await import('../../src/cli/commands/proxy/daemon-manager.js');
    health = await import('../../src/cli/commands/proxy/health-check.js');
    const { spawnDetached }: Processes = await import('../../src/utils/processes.js');

    // Spawn the real detached daemon in credential-free JWT mode. Mirrors the
    // args spawnDaemon() builds, plus --auth-method jwt so boot skips the SSO
    // keychain lookup.
    spawnDetached(process.execPath, [
      DAEMON_BIN,
      '--target-url', 'https://codemie.lab.epam.com/code-assistant-api',
      '--provider', 'jwt',
      '--auth-method', 'jwt',
      '--profile', PROFILE,
      '--gateway-key', GATEWAY_KEY,
      '--state-file', stateFile,
      '--port', String(TEST_PORT),
    ]);

    // Readiness poll (up to 8s): the daemon writes state once its server binds.
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const state = await dm.readState(stateFile);
      if (state && dm.isProcessAlive(state.pid)) {
        daemonPid = state.pid;
        break;
      }
    }
  }, 30_000);

  afterAll(async () => {
    // ALWAYS tear down, even if a test above threw before the stop test ran.
    try {
      // stopDaemon() uses DEFAULT_STATE_FILE, which resolves to our temp home
      // because daemon-manager was imported after CODEMIE_HOME was set.
      if (dm) await dm.stopDaemon();
    } catch {
      /* fall through to hard kill */
    }
    if (daemonPid > 0) {
      try {
        process.kill(daemonPid, 0); // still alive?
        try { process.kill(daemonPid, 'SIGKILL'); } catch { /* already gone */ }
      } catch {
        /* already reaped — good */
      }
    }
    if (originalHome) process.env.CODEMIE_HOME = originalHome;
    else delete process.env.CODEMIE_HOME;
    if (originalJwt) process.env.CODEMIE_JWT_TOKEN = originalJwt;
    else delete process.env.CODEMIE_JWT_TOKEN;
    if (testHome) rmSync(testHome, { recursive: true, force: true });
  });

  it('spawns a live detached process and persists its state', async () => {
    expect(daemonPid, 'daemon did not become ready within 8s').toBeGreaterThan(0);
    expect(dm.isProcessAlive(daemonPid)).toBe(true);

    const state = await dm.readState(stateFile);
    expect(state, 'proxy-daemon.json should exist in the temp CODEMIE_HOME').not.toBeNull();
    expect(state?.pid).toBe(daemonPid);
    expect(state?.port).toBe(TEST_PORT);
    expect(state?.gatewayKey).toBe(GATEWAY_KEY);
    expect(state?.url).toContain(String(TEST_PORT));
    expect(state?.profile).toBe(PROFILE);
  });

  it('checkStatus reports the daemon as running', async () => {
    const { running, state } = await dm.checkStatus(stateFile);
    expect(running).toBe(true);
    expect(state?.pid).toBe(daemonPid);
  });

  it('serves the pre-auth /health endpoint (shallow healthy)', async () => {
    const result = await health.checkProxyHealth({
      port: TEST_PORT,
      gatewayKey: GATEWAY_KEY,
      deep: false,
    });
    expect(
      result.healthy,
      `shallow health failed: ${result.code} ${result.reason ?? ''}`,
    ).toBe(true);
    expect(result.level).toBe('shallow');
  });

  it('stops the daemon and clears state (real SIGTERM path)', async () => {
    await dm.stopDaemon();

    expect(dm.isProcessAlive(daemonPid)).toBe(false);
    expect(await dm.readState(stateFile)).toBeNull();

    const { running } = await dm.checkStatus(stateFile);
    expect(running).toBe(false);

    // Port is no longer served.
    const afterStop = await health.checkProxyHealth({
      port: TEST_PORT,
      gatewayKey: GATEWAY_KEY,
      deep: false,
    });
    expect(afterStop.healthy).toBe(false);
  });
});
