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
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProcessAlive } from '../../src/utils/processes.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DAEMON_BIN = join(REPO_ROOT, 'bin', 'proxy-daemon.js');
const DAEMON_DIST = join(REPO_ROOT, 'dist', 'bin', 'proxy-daemon.js');
const CLI_VERSION = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string }).version;

// Uncommon fixed port to avoid colliding with a real running proxy on the
// default daemon port. Deterministic so a leaked listener is easy to spot.
const TEST_PORT = 47317;
const GATEWAY_KEY = 'codemie-proxy-lifecycle-test';
const PROFILE = 'proxy-daemon-lifecycle-test';

type DaemonManager = typeof import('../../src/cli/commands/proxy/daemon-manager.js');
type HealthCheck = typeof import('../../src/cli/commands/proxy/health-check.js');
type Processes = typeof import('../../src/utils/processes.js');
type ColdStart = typeof import('../../src/cli/commands/proxy/otlp-cold-start.js');

/** A loopback port no process listens on now. */
async function freeLoopbackPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe.skipIf(!existsSync(DAEMON_DIST))('Proxy daemon lifecycle (real spawn)', () => {
  let testHome: string;
  let originalHome: string | undefined;
  let originalUserHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalJwt: string | undefined;
  let upstream: http.Server;
  /** The model requests the fake upstream received: the client label and the parsed body. */
  const received: Array<{ url: string; client: string | undefined; cli: string | undefined; body: Record<string, unknown> }> = [];
  /** Held until both streams reached the upstream, so the two are served at the same time. */
  let bothArrived!: () => void;
  const arrivals = new Promise<void>((resolve) => { bothArrived = resolve; });
  let stateFile: string;
  let dm: DaemonManager;
  let health: HealthCheck;
  let daemonPid = -1;
  let upstreamUrl = '';
  /** Every daemon the start tests below brought up: afterAll kills a survivor. */
  const startedPids: number[] = [];

  /**
   * A hook's cold start in a process of its own: the built cold start on `PostToolUse`, then the pid its state
   * names, on a line of its own (outside a hook the logger prints its status lines to stdout too). With no such
   * line it rejects with the child's stdout and stderr.
   */
  const coldStartProcess = (): Promise<number> => {
    const script = [
      `const { ensureOtlpProxy } = await import(${JSON.stringify(join(REPO_ROOT, 'dist/cli/commands/proxy/otlp-cold-start.js'))});`,
      `const { readState } = await import(${JSON.stringify(join(REPO_ROOT, 'dist/cli/commands/proxy/daemon-manager.js'))});`,
      `await ensureOtlpProxy('claude-code-otlp', 'PostToolUse');`,
      'process.stdout.write(`\\npid=${(await readState()).pid}\\n`);',
    ].join('\n');
    return new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: testHome,
        env: { ...process.env, CODEMIE_HOME: testHome, HOME: testHome, USERPROFILE: testHome, CODEMIE_JWT_TOKEN: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`cold start exited ${code}: ${err}`));
        const match = /^pid=(\d+)$/m.exec(out);
        if (!match) return reject(new Error(`cold start printed no pid line\nstdout: ${out}\nstderr: ${err}`));
        const pid = Number(match[1]);
        if (pid > 0) startedPids.push(pid);
        resolve(pid);
      });
    });
  };

  /** The pids of the daemons whose command line names this suite's state file. */
  const daemonPids = (): Promise<string[]> => new Promise<string[]>((resolve) => {
    const pgrep = spawn('pgrep', ['-f', stateFile], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    pgrep.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    pgrep.on('close', () => resolve(out.trim().split('\n')));
  });

  beforeAll(async () => {
    originalHome = process.env.CODEMIE_HOME;
    originalUserHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalJwt = process.env.CODEMIE_JWT_TOKEN;
    testHome = mkdtempSync(join(tmpdir(), 'codemie-proxy-daemon-'));
    stateFile = join(testHome, 'proxy-daemon.json');
    // The daemon reads Claude Desktop's config and the connection record: none of the real home's
    process.env.HOME = testHome;
    process.env.USERPROFILE = testHome;

    // A fake upstream: the model catalog, and a streamed answer to every model request.
    upstream = http.createServer((req, res) => {
      if (req.url?.startsWith('/v1/llm_models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ deployment_name: 'gpt-5-2-2026-01-15', enabled: true }]));
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', async () => {
        received.push({
          url: req.url ?? '',
          client: req.headers['x-codemie-client'] as string | undefined,
          cli: req.headers['x-codemie-cli'] as string | undefined,
          body: JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>,
        });
        if (received.length === 2) bothArrived();
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"part":1}\n\n');
        await Promise.race([arrivals, new Promise((resolve) => setTimeout(resolve, 5000))]);
        res.end('data: {"part":2}\n\n');
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

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
      '--target-url', upstreamUrl,
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
      if (state && isProcessAlive(state.pid)) {
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
    for (const pid of [daemonPid, ...startedPids]) {
      if (pid <= 0) continue;
      try {
        process.kill(pid, 0); // still alive?
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      } catch {
        /* already reaped — good */
      }
    }
    if (originalHome) process.env.CODEMIE_HOME = originalHome;
    else delete process.env.CODEMIE_HOME;
    if (originalUserHome) process.env.HOME = originalUserHome;
    else delete process.env.HOME;
    if (originalUserProfile) process.env.USERPROFILE = originalUserProfile;
    else delete process.env.USERPROFILE;
    if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
    if (originalJwt) process.env.CODEMIE_JWT_TOKEN = originalJwt;
    else delete process.env.CODEMIE_JWT_TOKEN;
    if (testHome) rmSync(testHome, { recursive: true, force: true });
  });

  it('spawns a live detached process and persists its state', async () => {
    expect(daemonPid, 'daemon did not become ready within 8s').toBeGreaterThan(0);
    expect(isProcessAlive(daemonPid)).toBe(true);

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

  it('serves a Desktop stream and a Codex stream at the same time, each with its own label and normalizer', async () => {
    const stream = (path: string, client: string, body: unknown) => fetch(`http://127.0.0.1:${TEST_PORT}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GATEWAY_KEY}.${client}` },
      body: JSON.stringify(body),
    }).then((response) => response.text());
    // Both bodies carry what each normalizer changes: an enabled thinking budget (Claude), an undated model and an
    // empty tool description (Codex)
    const body = (model: string) => ({
      model, thinking: { type: 'enabled', budget_tokens: 10000 }, tools: [{ name: 'lookup', description: '' }], messages: [],
    });

    const answers = await Promise.all([
      stream('/v1/messages', 'claude-desktop', body('claude-sonnet-5')),
      stream('/responses', 'codex-desktop', body('gpt-5.2')),
    ]);

    for (const answer of answers) expect(answer).toBe('data: {"part":1}\n\ndata: {"part":2}\n\n');
    const desktop = received.find((request) => request.url === '/v1/messages')!;
    const codex = received.find((request) => request.url === '/responses')!;
    expect(desktop.client).toBe('claude-desktop');
    expect(desktop.body).toMatchObject({ model: 'claude-sonnet-5', thinking: { type: 'adaptive' }, tools: [{ name: 'lookup', description: '' }] });
    expect(codex.client).toBe('codex-desktop');
    expect(codex.body).toMatchObject({
      model: 'gpt-5-2-2026-01-15', thinking: { type: 'enabled', budget_tokens: 10000 }, tools: [{ name: 'lookup', description: 'lookup' }],
    });
    for (const request of [desktop, codex]) expect(request.cli).toMatch(/^codemie-cli\/\d+\.\d+\.\d+$/);
  });

  it('leaves the served mark of a claude-desktop request\'s session, and none of a codex-desktop request\'s', async () => {
    const desktopSession = 'a1b2c3d4-0000-4000-8000-00000000000a';
    const codexSession = 'a1b2c3d4-0000-4000-8000-00000000000b';
    const send = (client: string, session: string) => fetch(`http://127.0.0.1:${TEST_PORT}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GATEWAY_KEY}.${client}`,
        'x-claude-code-session-id': session,
      },
      body: JSON.stringify({ model: 'claude-sonnet-5', messages: [] }),
    }).then((response) => response.text());
    const mark = (session: string) => join(testHome, 'analytics', 'state', `${session}.cowork-served`);

    await send('claude-desktop', desktopSession);
    await send('codex-desktop', codexSession);

    expect(existsSync(mark(desktopSession))).toBe(true);
    expect(existsSync(mark(codexSession))).toBe(false);
  });

  it('stops the daemon and clears state (real SIGTERM path)', async () => {
    await dm.stopDaemon();

    expect(isProcessAlive(daemonPid)).toBe(false);
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

  // The starts below run on an SSO profile with no login: each daemon holds its port awaiting a sign-in and
  // writes its state, which is all a start waits for.
  it('a replacement cut between the stop and the spawn leaves the dead daemon\'s state, from which a hook brings it back with its project', async () => {
    const port = await freeLoopbackPort();
    const first = await dm.spawnDaemon({
      targetUrl: upstreamUrl, provider: 'ai-run-sso', profile: 'lifecycle-sso', port, project: 'lifecycle-project', writeRecord: false,
    });
    startedPids.push(first.pid);
    expect(first.project).toBe('lifecycle-project');

    // A replacement up to its cut: the real SIGTERM, the state written back, no spawn.
    await dm.stopDaemon();
    await dm.writeState(first);
    expect(isProcessAlive(first.pid)).toBe(false);
    expect((await dm.readState(stateFile))?.pid).toBe(first.pid);

    const { ensureOtlpProxy }: ColdStart = await import('../../src/cli/commands/proxy/otlp-cold-start.js');
    await ensureOtlpProxy('claude-code-otlp', 'PostToolUse');

    const back = await dm.readState(stateFile);
    startedPids.push(back?.pid ?? -1);
    expect(back?.pid).not.toBe(first.pid);
    expect(isProcessAlive(back!.pid)).toBe(true);
    expect(back).toMatchObject({ project: 'lifecycle-project', port, profile: 'lifecycle-sso', targetUrl: upstreamUrl });
  }, 30_000);

  it('a hook replaces a live daemon whose state names version 0.0.1 on the recorded port', async () => {
    const live = (await dm.readState(stateFile))!;
    const recordedPort = await freeLoopbackPort();
    writeFileSync(join(testHome, 'proxy-connection.json'), JSON.stringify({ version: 1, profile: live.profile, port: recordedPort }), 'utf-8');
    await dm.writeState({ ...live, version: '0.0.1' });

    const { ensureOtlpProxy }: ColdStart = await import('../../src/cli/commands/proxy/otlp-cold-start.js');
    await ensureOtlpProxy('claude-code-otlp', 'PostToolUse');

    const replaced = await dm.readState(stateFile);
    startedPids.push(replaced?.pid ?? -1);
    expect(isProcessAlive(live.pid)).toBe(false);
    expect(replaced?.pid).not.toBe(live.pid);
    expect(replaced).toMatchObject({ port: recordedPort, project: 'lifecycle-project' });
    expect(replaced?.version).toBe(CLI_VERSION);
  }, 30_000);

  it.skipIf(process.platform === 'win32')('two hooks at once over a live daemon of an older CLI replace it once, both reading the one new daemon', async () => {
    const live = (await dm.readState(stateFile))!;
    await dm.writeState({ ...live, version: '0.0.1' });

    const pids = await Promise.all([coldStartProcess(), coldStartProcess()]);

    const state = await dm.readState(stateFile);
    expect(isProcessAlive(live.pid)).toBe(false);
    expect(pids).toEqual([state!.pid, state!.pid]);
    expect(isProcessAlive(state!.pid)).toBe(true);
    expect(state).toMatchObject({ project: live.project, port: live.port });
    expect(live.project).toBe('lifecycle-project');
    expect(await daemonPids()).toEqual([String(state!.pid)]);
  }, 60_000);

  it.skipIf(process.platform === 'win32')('two cold starts at once through the real spawn leave one live daemon, whose pid both callers read', async () => {
    await dm.stopDaemon();
    const port = await freeLoopbackPort();
    writeFileSync(join(testHome, 'codemie-cli.config.json'), JSON.stringify({
      version: 2,
      activeProfile: 'lifecycle-sso',
      profiles: { 'lifecycle-sso': { name: 'lifecycle-sso', provider: 'ai-run-sso', baseUrl: upstreamUrl } },
    }), 'utf-8');
    writeFileSync(join(testHome, 'proxy-connection.json'), JSON.stringify({ version: 1, profile: 'lifecycle-sso', port }), 'utf-8');

    // Each caller is a process of its own, as two hooks are.
    const pids = await Promise.all([coldStartProcess(), coldStartProcess()]);

    const state = await dm.readState(stateFile);
    expect(pids[0]).toBeGreaterThan(0);
    expect(pids).toEqual([state!.pid, state!.pid]);
    expect(isProcessAlive(state!.pid)).toBe(true);
    expect(state?.port).toBe(port);
    expect(await daemonPids()).toEqual([String(state!.pid)]);
  }, 60_000);

  it.skipIf(process.platform === 'win32')('a cold start over an unparsable state file and no daemon starts one daemon and rewrites the file', async () => {
    await dm.stopDaemon();
    writeFileSync(stateFile, '{', 'utf-8');

    const pid = await coldStartProcess();

    const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as { pid: number };
    expect(pid).toBeGreaterThan(0);
    expect(state.pid).toBe(pid);
    expect(isProcessAlive(pid)).toBe(true);
    expect(await daemonPids()).toEqual([String(pid)]);
  }, 60_000);
});
