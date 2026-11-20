/**
 * Claude Code OTLP hook sessions against a local mock CodeMie backend, for CLI contract tests.
 *
 * Runs the built `bin/codemie.js hook --agent claude-code-otlp` in an isolated temp home; the hook
 * cold-starts the real detached proxy daemon, which delivers the session to the mock backend.
 * keytar is blocked in every child process, so SSO credentials live in the temp home's file store
 * only. No network, no LLM. Requires dist/ built.
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BIN = join(REPO_ROOT, 'bin', 'codemie.js');
export const SECURITY_DIST = join(REPO_ROOT, 'dist', 'utils', 'security.js');
export const DAEMON_DIST = join(REPO_ROOT, 'dist', 'bin', 'proxy-daemon.js');
export const EVENT_HOOKS_PATH = '/v1/analytics/cli-analytics/event-hooks';
const RUN_TIMEOUT_MS = 30_000;

export interface RecordedRequest {
  method: string;
  path: string;
  cookie?: string;
  project?: string;
  body: string;
}

export interface MockServer {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

export interface MockBackend extends MockServer {
  /** What `GET /v1/user` answers; switch it to simulate a session expiring or coming back. */
  userInfo: { status: number; location?: string };
  /** Cookie headers the analytics ingest answers 401 to: an expired SSO session. */
  rejectedCookies: Set<string>;
}

export interface CodeMieUser {
  userId: string;
  name: string;
  username: string;
  email: string;
  applications: string[];
  applications_admin: string[];
}

export interface GlobalProfile {
  baseUrl: string;
  codeMieUrl?: string;
  codeMieProject?: string | null;
}

export type HookEvent = Record<string, unknown>;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => done(body));
  });
}

export interface MockReply {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** A local HTTP server that records every request and answers with `handle`. */
export async function startServer(
  handle: (path: string, req: IncomingMessage, body: string) => MockReply
): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = req.url ?? '';
    requests.push({
      method: req.method ?? '',
      path,
      cookie: req.headers.cookie,
      project: req.headers['x-codemie-project'] as string | undefined,
      body,
    });
    const reply = handle(path, req, body);
    res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  const url = await new Promise<string>((done) => {
    server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
  return { url, requests, close: () => new Promise((done) => server.close(() => done())) };
}

/**
 * The CodeMie API: `/v1/user` as configured, a classification policy the CLI can publish under, 200 otherwise.
 * Loopback URLs are used as the API base as-is (no `/code-assistant-api` suffix).
 */
export async function startMockBackend(user: CodeMieUser): Promise<MockBackend> {
  const userInfo: MockBackend['userInfo'] = { status: 200 };
  const rejectedCookies = new Set<string>();
  const server = await startServer((path, req, body): MockReply => {
    if (req.method === 'POST' && path.startsWith('/v1/analytics/') && rejectedCookies.has(req.headers.cookie ?? '')) {
      return { status: 401, body: { error: 'session expired' } };
    }
    if (req.method === 'POST' && path === EVENT_HOOKS_PATH) {
      // Accepted for the request's project, with the publication echo the CLI verifies before it acknowledges.
      const project = req.headers['x-codemie-project'] as string | undefined;
      return {
        status: 200,
        headers: {
          'x-codemie-publication-contract': (req.headers['x-codemie-publication-contract'] as string | undefined) ?? '1',
          'x-codemie-destination': 'project',
          ...(project ? { 'x-codemie-bound-project': project } : {}),
        },
        body: { accepted: body.split('\n').filter(Boolean).length, dropped: 0 },
      };
    }
    if (path === '/v1/user') {
      return userInfo.status === 200
        ? { status: 200, body: user }
        : { status: userInfo.status, headers: userInfo.location ? { location: userInfo.location } : {} };
    }
    if (path.startsWith('/v1/analytics/cli-analytics/classification-policy')) {
      return { status: 200, body: { organizations: [], version: 'v1', publication_contracts: ['1'] } };
    }
    return { status: 200 };
  });
  return { ...server, userInfo, rejectedCookies };
}

/** The hook events the backend received, one object per NDJSON line. */
export function deliveredHookEvents(backend: MockServer): HookEvent[] {
  return backend.requests
    .filter((r) => r.method === 'POST' && r.path === EVENT_HOOKS_PATH)
    .flatMap((r) => r.body.split('\n').filter(Boolean).map((line) => JSON.parse(line) as HookEvent));
}

export async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Waits until a prompt hook of the session has reached the backend; returns every delivered event. */
export function waitForDeliveredSession(backend: MockServer, timeoutMs: number, what: string): Promise<HookEvent[]> {
  return waitFor(
    () => {
      const events = deliveredHookEvents(backend);
      return events.some((e) => e.hook_event_name === 'UserPromptSubmit') ? events : undefined;
    },
    timeoutMs,
    what
  );
}

/** Environment of a CLI child process confined to `home`, with keytar blocked and fast delivery ticks. */
export function hookEnv(home: string): NodeJS.ProcessEnv {
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
  // Keep the credential store off the OS keychain: the file store in this home only.
  env.NODE_OPTIONS = `--import=${pathToFileURL(join(home, 'no-keytar-register.mjs')).href}`;
  // Deliver every 3 s; hooks-only sessions are sent on each tick instead of waiting for OTel data.
  env.OTLP_SEND_INTERVAL_MINUTES = '0.05';
  env.OTLP_SEND_MAX_ATTEMPTS = '0';
  return env;
}

/**
 * A warm temp home: `codemie version` has run once, so start-up work is done and the migration
 * ledger is complete; no migration rewrites the config the test writes next (migration 007 would
 * move a profile's own project into the shared workspace on a home without a ledger). `dropMigrations` / `addMigrations` edit that
 * ledger to stand for an older install.
 */
export function createCliHome(
  homes: string[],
  options: { dropMigrations?: string[]; addMigrations?: string[] } = {}
): string {
  const home = mkdtempSync(join(tmpdir(), 'codemie-hook-session-'));
  homes.push(home);
  writeFileSync(
    join(home, 'no-keytar-hooks.mjs'),
    `export async function resolve(specifier, context, next) {
  if (specifier === 'keytar') throw Object.assign(new Error('keytar blocked in tests'), { code: 'ERR_MODULE_NOT_FOUND' });
  return next(specifier, context);
}
`,
    'utf-8'
  );
  writeFileSync(
    join(home, 'no-keytar-register.mjs'),
    `import { register } from 'node:module';\nregister('./no-keytar-hooks.mjs', import.meta.url);\n`,
    'utf-8'
  );
  writeFileSync(join(home, 'transcript.jsonl'), '', 'utf-8');

  const first = spawnSync(process.execPath, [BIN, 'version'], { cwd: home, env: hookEnv(home), encoding: 'utf-8' });
  const ledgerPath = join(home, 'migrations.json');
  if (first.status !== 0 || !existsSync(ledgerPath)) {
    throw new Error(`setup: codemie version did not write a migration ledger\n${first.stderr}`);
  }
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as { migrations: Array<{ id: string }> };
  const drop = new Set(options.dropMigrations ?? []);
  ledger.migrations = [
    ...ledger.migrations.filter((m) => !drop.has(m.id)),
    ...(options.addMigrations ?? []).map((id) => ({ id, appliedAt: new Date().toISOString(), success: true })),
  ];
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf-8');
  return home;
}

/** Writes the global config: SSO profiles of a project-carrying provider, plus an optional shared workspace. */
export function writeGlobalConfig(
  home: string,
  activeProfile: string,
  profiles: Record<string, GlobalProfile>,
  workspace?: { codeMieUrl?: string; codeMieProject?: string }
): void {
  const entries = Object.fromEntries(
    Object.entries(profiles).map(([name, profile]) => [
      name,
      { name, provider: 'ai-run-sso', authMethod: 'sso', model: 'claude-haiku-5-5', ...profile },
    ])
  );
  writeFileSync(
    join(home, 'codemie-cli.config.json'),
    JSON.stringify({ version: 2, activeProfile, profiles: entries, ...(workspace ? { workspace } : {}) }, null, 2),
    'utf-8'
  );
}

export function readGlobalConfig(home: string): {
  activeProfile: string;
  profiles: Record<string, Record<string, unknown>>;
  workspace?: Record<string, unknown>;
} {
  return JSON.parse(readFileSync(join(home, 'codemie-cli.config.json'), 'utf-8'));
}

/** The connection record `codemie proxy connect` writes: the hook cold-starts the daemon on this profile. */
export function recordProxyConnection(home: string, profile: string): void {
  writeFileSync(
    join(home, 'proxy-connection.json'),
    JSON.stringify({ version: 1, profile, clientType: 'claude-code-otlp', updatedAt: new Date().toISOString() }),
    'utf-8'
  );
}

/** Stores an SSO login for `apiUrl` the way `codemie setup` does, through the built CredentialStore. */
export function storeSsoLogin(home: string, apiUrl: string, cookies: Record<string, string>): void {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { CredentialStore } = await import(${JSON.stringify(pathToFileURL(SECURITY_DIST).href)});
await CredentialStore.getInstance().storeSSOCredentials(
  { cookies: ${JSON.stringify(cookies)}, apiUrl: ${JSON.stringify(apiUrl)}, expiresAt: Date.now() + 3600000 },
  ${JSON.stringify(apiUrl)}
);`,
    ],
    { env: hookEnv(home), stdio: 'pipe' }
  );
}

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the built CLI in `home` with the hook environment. */
export function runCli(home: string, args: string[], input = ''): Promise<CliRun> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: home, env: hookEnv(home), windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`codemie ${args.join(' ')} did not exit within ${RUN_TIMEOUT_MS}ms\nstderr: ${stderr}`));
    }, RUN_TIMEOUT_MS);
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

/** One Claude Code hook event for `sessionId`, as Claude Code writes it to the hook's stdin. */
export function runHook(home: string, sessionId: string, event: HookEvent): Promise<CliRun> {
  const input = JSON.stringify({
    session_id: sessionId,
    transcript_path: join(home, 'transcript.jsonl'),
    cwd: home,
    ...event,
  });
  return runCli(home, ['hook', '--agent', 'claude-code-otlp'], input);
}

/** A session start and one typed prompt. Each hook must exit 0 silently. */
export async function runHookSession(home: string, sessionId: string): Promise<CliRun[]> {
  const runs: CliRun[] = [];
  for (const event of [
    { hook_event_name: 'SessionStart', source: 'startup' },
    { hook_event_name: 'UserPromptSubmit', prompt: 'Reply with OK.' },
  ]) {
    runs.push(await runHook(home, sessionId, event));
  }
  return runs;
}

export function fileLog(home: string): string {
  const dir = join(home, 'logs');
  if (!existsSync(dir)) return '';
  return readdirSync(dir).map((name) => readFileSync(join(dir, name), 'utf-8')).join('\n');
}

/** Kills the home's proxy daemon and removes the home. */
export function disposeCliHome(home: string): void {
  const stateFile = join(home, 'proxy-daemon.json');
  if (existsSync(stateFile)) {
    try {
      process.kill((JSON.parse(readFileSync(stateFile, 'utf-8')) as { pid: number }).pid, 'SIGKILL');
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
