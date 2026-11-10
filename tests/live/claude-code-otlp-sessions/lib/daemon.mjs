// Starts the REAL built proxy daemon (dist/bin/proxy-daemon.js) isolated: temp CODEMIE_HOME, temp state file,
// a free port, target URL = the fake backend, fake SSO login seeded into the temp credential store,
// fast tick intervals. Also drives the REAL hook entry point (bin/codemie.js hook) as a child process.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { DIST, REPO_ROOT, NO_KEYTAR_PRELOAD } from './env.mjs';
import { fileURLToPath } from 'node:url';

const SEED = fileURLToPath(new URL('./seed-credentials.mjs', import.meta.url));
const REAL_DEFAULT_PORT = 4001; // the user's real daemon default; never used here

/** Fast-tick defaults (minutes accept fractions). Override per run through `tuning`. */
export const FAST_TUNING = {
  OTLP_SEND_INTERVAL_MINUTES: '0.02', // tick every 1.2 s instead of 2 min
  OTLP_SEND_MAX_ATTEMPTS: '3',        // hooks-only wait / otel-only wait = 3 ticks (~3.6 s)
  OTLP_SWEEP_INTERVAL_MINUTES: '15',
  OTLP_ENDED_SESSION_GRACE_MINUTES: '15',
  OTLP_ABANDONED_SESSION_GRACE_MINUTES: '60',
};

export function assertBuilt() {
  for (const f of ['bin/proxy-daemon.js', 'agents/plugins/claude-code-otlp/claude-code-otlp.plugin.js']) {
    if (!existsSync(join(DIST, f))) throw new Error(`dist is missing ${f}; run "npm run build" at the repo root`);
  }
}

export function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => (port === REAL_DEFAULT_PORT ? freePort().then(ok, fail) : ok(port)));
    });
  });
}

/** Proves the keytar block works in the child env, so the real OS credential store is never reached. */
export function assertKeytarBlocked(te) {
  const r = spawnSync(process.execPath, ['-e', "import('keytar').then(()=>{console.log('LOADED');process.exit(1)},()=>console.log('BLOCKED'))"], { env: te.env, encoding: 'utf8' });
  if (!/BLOCKED/.test(r.stdout || '')) throw new Error(`safety: keytar is not blocked in the child env (${r.stdout}${r.stderr})`);
}

export function seedCredentials(te, backendUrl, email = 'live.tester@example.com') {
  const r = spawnSync(process.execPath, [SEED, DIST, backendUrl, email], { env: te.env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`seeding fake credentials failed: ${r.stdout}${r.stderr}`);
}

/**
 * @param te       env handle from createTestEnv()
 * @param backend  fake backend handle
 * @param opts     { tuning, gatewayKey, profile, email }
 * @returns handle { url, port, gatewayKey, stateFile, pid, logFile, stop(), readState(), spoolDir }
 */
export async function startDaemon(te, backend, { tuning = {}, gatewayKey = 'live-gateway-key', profile = 'live-test', email } = {}) {
  assertBuilt();
  assertKeytarBlocked(te);
  seedCredentials(te, backend.url, email);

  const port = await freePort();
  const stateFile = te.assertInside(join(te.codemieHome, 'proxy-daemon.json'));
  const logFile = join(te.root, 'daemon.log');
  const out = openSync(logFile, 'a');
  const args = [
    join(DIST, 'bin', 'proxy-daemon.js'),
    '--target-url', backend.url,
    '--port', String(port),
    '--state-file', stateFile,
    '--gateway-key', gatewayKey,
    '--provider', 'ai-run-sso',
    '--profile', profile,
  ];
  const child = spawn(process.execPath, args, {
    env: te.envWith({ ...FAST_TUNING, ...tuning }),
    cwd: te.root,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  closeSync(out);
  let exited = null;
  child.once('exit', (code, sig) => { exited = { code, sig }; });

  const readState = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return null; } };

  const deadline = Date.now() + 20_000;
  let state = null;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`isolated daemon exited early (${JSON.stringify(exited)}):\n${readFileSync(logFile, 'utf8').slice(-2000)}`);
    state = readState();
    if (state?.port && state.health === 'ok') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!state?.port || state.health !== 'ok') {
    child.kill();
    throw new Error(`isolated daemon not ready in 20s (state=${JSON.stringify(state)}):\n${readFileSync(logFile, 'utf8').slice(-2000)}`);
  }
  if (state.port !== port) throw new Error(`daemon bound ${state.port}, expected ${port}`);

  const handle = {
    url: state.url, // http://127.0.0.1:<port>
    port: state.port,
    gatewayKey,
    stateFile,
    logFile,
    pid: child.pid,
    spoolDir: join(te.codemieHome, 'proxy', 'otlp-spool'),
    readState,
    log: () => readFileSync(logFile, 'utf8'),
    async stop() {
      if (exited) return;
      child.kill(); // our own child only; Windows has no graceful SIGTERM, which is fine for a temp daemon
      await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); });
    },
  };
  return handle;
}

/**
 * Run the real hook entry (`node bin/codemie.js hook --agent claude-code-otlp`) as a child with the isolated env.
 * `input` is the Claude Code hook payload. The hook finds the daemon through <CODEMIE_HOME>/proxy-daemon.json.
 */
export function runHook(te, input, { cwd, extraEnv = {}, timeoutMs = 60_000 } = {}) {
  return new Promise((ok) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [join(REPO_ROOT, 'bin', 'codemie.js'), 'hook', '--agent', 'claude-code-otlp'], {
      env: te.envWith(extraEnv),
      cwd: cwd ?? input.cwd ?? te.root,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); ok({ code, stdout, stderr, durationMs: Date.now() - t0, at: t0 }); });
    child.stdin.end(JSON.stringify(input));
  });
}

/** Standard Claude Code hook payload. */
export function hookInput({ sessionId, transcriptPath, cwd, name, ...extra }) {
  return { session_id: sessionId, transcript_path: transcriptPath, cwd, hook_event_name: name, ...extra };
}
