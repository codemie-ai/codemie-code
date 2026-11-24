/**
 * The client of a request through the daemon's proxy: settled by the gateway key and the client-attribution plugin
 * before any client-gated plugin, carried in `X-CodeMie-Client`, the Desktop repository and the session's served mark.
 *
 * Seam: a real CodeMieProxy with the core plugins over a fake upstream on loopback; JWT auth with a dummy token. The
 * Desktop repository resolver is a stub, or the real one over Desktop session files in a temp HOME. A temp
 * CODEMIE_HOME holds the served marks.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../../../../../../utils/logger.js';
import { CodeMieProxy } from '../../sso.proxy.js';
import type { ProxyConfig, ProxyContext } from '../../proxy-types.js';
import { getPluginRegistry } from '../registry.js';
import '../index.js';
import { DesktopRepositoryResolver } from '../../../../../../telemetry/runtime/DesktopRepositoryResolver.js';
import { getClaudeDesktopCodeSessionsRoot } from '../../../../../../telemetry/clients/claude-desktop/claude-desktop.paths.js';

const KEY = 'codemie-proxy';
const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001';

/** Every client a request reached `onError` as, in order: a probe plugin of every client. */
const errorsSeenAs: string[] = [];
getPluginRegistry().register({
  id: 'test-error-probe',
  name: 'test-error-probe',
  version: '1.0.0',
  priority: 999,
  createInterceptor: () => ({
    name: 'test-error-probe',
    onError: async (context: ProxyContext) => {
      errorsSeenAs.push(context.agentName);
    },
  }),
});

interface Forwarded {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  rawHeaders: string[];
  body: Record<string, unknown> | null;
}

interface Harness {
  url: string;
  proxy: CodeMieProxy;
  /** The requests the upstream received, the model catalog listing aside. */
  forwarded: Forwarded[];
  /** The upstream drops the connection of the next forwarded request. */
  failNext: () => void;
}

let home: string;
let codemieHome: string;
let harnesses: Array<{ proxy: CodeMieProxy; upstream: Server }> = [];

async function startProxy(overrides: Partial<ProxyConfig> = {}): Promise<Harness> {
  const forwarded: Forwarded[] = [];
  let failing = false;
  const upstream = createServer((req, res) => {
    if (req.url?.startsWith('/v1/llm_models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (failing) {
        failing = false;
        req.socket.destroy();
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf-8');
      forwarded.push({
        method: req.method ?? '', url: req.url ?? '', headers: req.headers, rawHeaders: req.rawHeaders,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = new CodeMieProxy({
    targetApiUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    host: '127.0.0.1',
    authMethod: 'jwt',
    jwtToken: 'dummy-upstream-jwt',
    provider: 'jwt',
    version: '9.9.9',
    gatewayKey: KEY,
    clientType: 'codemie-daemon',
    desktopRepositoryResolver: stubResolver(),
    ...overrides,
  });
  const { url } = await proxy.start();
  harnesses.push({ proxy, upstream });
  return { url, proxy, forwarded, failNext: () => { failing = true; } };
}

type Answer = { repository: string | null; branch: string | null; isCowork: boolean };
let answer: Answer | Error;
const resolveForRequest = vi.fn(async (): Promise<Answer> => {
  if (answer instanceof Error) throw answer;
  return answer;
});

function stubResolver(): DesktopRepositoryResolver {
  return { resolveForRequest } as unknown as DesktopRepositoryResolver;
}

async function send(
  harness: Harness,
  { key, session, path = '/v1/messages', body = { model: 'claude-sonnet-5', messages: [] }, headers = {} }: {
    key?: string; session?: string; path?: string; body?: unknown; headers?: Record<string, string>;
  } = {}
): Promise<Response> {
  return fetch(`${harness.url}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key !== undefined && { Authorization: `Bearer ${key}` }),
      ...(session && { 'x-claude-code-session-id': session }),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const named = (client: string) => `${KEY}.${client}`;
const markPath = (session: string) => join(codemieHome, 'analytics', 'state', `${session}.cowork-served`);
const last = (harness: Harness) => harness.forwarded.at(-1)!;
const rawCount = (request: Forwarded, name: string) =>
  request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length;

/** The Claude normalizer's change: an enabled thinking budget above 8192 becomes adaptive with a high effort. */
const CLAUDE_BODY = { model: 'claude-sonnet-5', thinking: { type: 'enabled', budget_tokens: 10000 }, messages: [] };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'client-attribution-home-'));
  codemieHome = mkdtempSync(join(tmpdir(), 'client-attribution-codemie-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
  vi.stubEnv('LOCALAPPDATA', join(home, 'AppData', 'Local'));
  vi.stubEnv('CODEMIE_HOME', codemieHome);
  for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) vi.stubEnv(key, undefined);
  answer = { repository: null, branch: null, isCowork: false };
  resolveForRequest.mockClear();
  errorsSeenAs.length = 0;
});

afterEach(async () => {
  for (const { proxy, upstream } of harnesses.splice(0)) {
    await proxy.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  await logger.close();
  rmSync(codemieHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('the client of a request through the daemon', () => {
  it('a codex-desktop request carries its own label and no repository, and never reaches the resolver', async () => {
    const harness = await startProxy();

    await send(harness, { key: named('codex-desktop'), session: SESSION, path: '/v1/responses', body: { model: 'gpt-5.2', input: [] } });

    expect(last(harness).headers['x-codemie-client']).toBe('codex-desktop');
    expect(last(harness).headers).not.toHaveProperty('x-codemie-repository');
    expect(resolveForRequest).not.toHaveBeenCalled();
    expect(existsSync(markPath(SESSION))).toBe(false);
  });

  it('a claude-desktop request without a session header carries the Cowork repository', async () => {
    const harness = await startProxy();

    await send(harness, { key: named('claude-desktop') });

    expect(last(harness).headers).toMatchObject({ 'x-codemie-client': 'claude-desktop', 'x-codemie-repository': 'Cowork' });
  });

  it('a vscode-claude-code request the resolver answers Cowork for keeps its client: no Cowork repository, no served mark', async () => {
    answer = { repository: 'Cowork', branch: null, isCowork: true };
    const harness = await startProxy();

    await send(harness, { key: named('vscode-claude-code'), session: SESSION });

    expect(last(harness).headers['x-codemie-client']).toBe('claude-desktop');
    expect(last(harness).headers).not.toHaveProperty('x-codemie-repository');
    expect(existsSync(markPath(SESSION))).toBe(false);
  });

  it('a shared-key request the resolver marks Cowork is a claude-desktop request: label, Claude normalizer, served mark', async () => {
    answer = { repository: 'Cowork', branch: null, isCowork: true };
    const harness = await startProxy();

    await send(harness, { key: KEY, session: SESSION, body: CLAUDE_BODY });

    expect(last(harness).headers).toMatchObject({ 'x-codemie-client': 'claude-desktop', 'x-codemie-repository': 'Cowork' });
    expect(last(harness).body).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    expect(existsSync(markPath(SESSION))).toBe(true);
  });

  it('the models listing of a shared-key Cowork request is answered by desktop-models', async () => {
    answer = { repository: 'Cowork', branch: null, isCowork: true };
    const harness = await startProxy();

    const response = await fetch(`${harness.url}/v1/models`, {
      headers: { Authorization: `Bearer ${KEY}`, 'x-claude-code-session-id': SESSION },
    });

    expect(await response.json()).toMatchObject({ data: [], has_more: false });
    expect(harness.forwarded).toEqual([]);
  });

  it('a shared-key request without the session header never reaches the resolver and keeps the default client', async () => {
    const harness = await startProxy();

    await send(harness, { key: KEY, body: CLAUDE_BODY });

    expect(resolveForRequest).not.toHaveBeenCalled();
    expect(last(harness).headers['x-codemie-client']).toBe('codemie-daemon');
    expect(last(harness).body).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 10000 } });
  });

  it('a resolver that throws leaves the request unresolved: forwarded without a repository', async () => {
    answer = new Error('lsof failed');
    const harness = await startProxy();

    const response = await send(harness, { key: KEY, session: SESSION });

    expect(response.status).toBe(200);
    expect(last(harness).headers['x-codemie-client']).toBe('codemie-daemon');
    expect(last(harness).headers).not.toHaveProperty('x-codemie-repository');
  });

  it('edge: a request with no key is answered 401 before the resolver runs', async () => {
    const harness = await startProxy();

    const response = await send(harness, { session: SESSION });

    expect(response.status).toBe(401);
    expect(resolveForRequest).not.toHaveBeenCalled();
    expect(harness.forwarded).toEqual([]);
  });

  it('edge: GET /v1/models is answered by desktop-models for vscode-claude-code and forwarded for codex-desktop', async () => {
    const harness = await startProxy();

    const extension = await fetch(`${harness.url}/v1/models`, { headers: { Authorization: `Bearer ${named('vscode-claude-code')}` } });
    expect(await extension.json()).toMatchObject({ data: [], has_more: false });
    expect(harness.forwarded).toEqual([]);

    await fetch(`${harness.url}/v1/models`, { headers: { Authorization: `Bearer ${named('codex-desktop')}` } });
    expect(harness.forwarded.map((request) => [request.method, request.url])).toEqual([['GET', '/v1/models']]);
  });

  it('an upstream error on a codex-desktop request reaches onError under codex-desktop', async () => {
    const harness = await startProxy();
    harness.failNext();

    const response = await send(harness, { key: named('codex-desktop'), path: '/v1/responses', body: { model: 'gpt-5.2', input: [] } });

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(errorsSeenAs).toEqual(['codex-desktop']);
  });

  it('edge: a request whose body cannot be read gets the error answer and reaches onError under the proxy\'s client type', async () => {
    const harness = await startProxy();
    const req = new Readable({ read() { this.destroy(new Error('body read failed')); } }) as IncomingMessage;
    req.method = 'POST';
    req.url = '/v1/messages';
    req.headers = { authorization: `Bearer ${named('codex-desktop')}` };
    let status = 0;
    let ended = false;
    const res = {
      headersSent: false,
      set statusCode(value: number) { status = value; },
      setHeader: () => undefined,
      end: () => { ended = true; },
    } as unknown as ServerResponse;

    await (harness.proxy as unknown as { handleRequest(r: IncomingMessage, s: ServerResponse): Promise<void> }).handleRequest(req, res);

    expect(ended).toBe(true);
    expect(status).toBeGreaterThanOrEqual(500);
    expect(errorsSeenAs).toEqual(['codemie-daemon']);
  });
});

describe('the headers a client sends beside the proxy\'s own', () => {
  it('edge: a named-key request with its own x-codemie-client gets the injected value once', async () => {
    const harness = await startProxy();

    await send(harness, { key: named('codex-desktop'), path: '/v1/responses', body: { model: 'gpt-5.2', input: [] }, headers: { 'x-codemie-client': 'forged' } });

    expect(last(harness).headers['x-codemie-client']).toBe('codex-desktop');
    expect(rawCount(last(harness), 'x-codemie-client')).toBe(1);
  });

  it('edge: a named-key request with its own x-codemie-project gets the daemon\'s project once, never its own', async () => {
    const harness = await startProxy({ project: 'daemon-project' });

    await send(harness, { key: named('claude-desktop'), headers: { 'x-codemie-project': 'other' } });

    expect(last(harness).headers['x-codemie-project']).toBe('daemon-project');
    expect(rawCount(last(harness), 'x-codemie-project')).toBe(1);
  });

  it('edge: a daemon started without a project sets none, and a client\'s own header of that name passes', async () => {
    const harness = await startProxy();

    await send(harness, { key: named('claude-desktop'), headers: { 'x-codemie-project': 'client-project' } });

    expect(last(harness).headers['x-codemie-project']).toBe('client-project');
  });

  it('edge: a wrapper proxy (no gateway key, no resolver) sends today\'s headers', async () => {
    const harness = await startProxy({ gatewayKey: undefined, desktopRepositoryResolver: undefined, clientType: 'codemie-claude', repository: 'org/repo' });

    await send(harness, { session: SESSION });

    expect(last(harness).headers).toMatchObject({ 'x-codemie-client': 'codemie-claude', 'x-codemie-repository': 'org/repo' });
    expect(existsSync(markPath(SESSION))).toBe(false);
  });
});

describe('the served mark of a Cowork session', () => {
  beforeEach(() => {
    answer = { repository: 'Cowork', branch: null, isCowork: true };
  });

  it('edge: ten requests of one session leave one mark, written by the first', async () => {
    const harness = await startProxy();
    await send(harness, { key: named('claude-desktop'), session: SESSION });
    expect(existsSync(markPath(SESSION))).toBe(true);
    // Removed after the first write: a later request that wrote again would bring it back
    rmSync(markPath(SESSION));

    for (let request = 0; request < 9; request++) await send(harness, { key: named('claude-desktop'), session: SESSION });

    expect(harness.forwarded).toHaveLength(10);
    expect(existsSync(markPath(SESSION))).toBe(false);
  });

  it('edge: an unsafe session id leaves no file', async () => {
    const harness = await startProxy();

    await send(harness, { key: named('claude-desktop'), session: '../x' });

    expect(existsSync(join(codemieHome, 'analytics'))).toBe(false);
  });

  it('edge: a codex-desktop request carrying the session header leaves no mark', async () => {
    const harness = await startProxy();

    await send(harness, { key: named('codex-desktop'), session: SESSION, path: '/v1/responses', body: { model: 'gpt-5.2', input: [] } });

    expect(existsSync(markPath(SESSION))).toBe(false);
  });

  it('edge: a mark that cannot be written lets the request through, and the next request of the session writes it', async () => {
    const harness = await startProxy();
    mkdirSync(join(codemieHome, 'analytics'), { recursive: true });
    // A file where the state directory belongs: the mark's directory cannot be created
    writeFileSync(join(codemieHome, 'analytics', 'state'), '');
    const session = 'a1b2c3d4-0000-4000-8000-000000000002';

    const blocked = await send(harness, { key: named('claude-desktop'), session });
    expect(blocked.status).toBe(200);
    rmSync(join(codemieHome, 'analytics', 'state'));
    await send(harness, { key: named('claude-desktop'), session });

    expect(harness.forwarded).toHaveLength(2);
    expect(existsSync(markPath(session))).toBe(true);
  });
});

describe('the resolver\'s last-resolved slot and the VS Code Claude Code extension', () => {
  /** A Desktop Code-tab session file naming the folder of `session`, which the real resolver reads. */
  function codeTabSession(session: string, folder: string): void {
    const root = getClaudeDesktopCodeSessionsRoot();
    mkdirSync(root, { recursive: true });
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(root, `local_${session}.json`), JSON.stringify({ cliSessionId: session, cwd: folder }));
  }

  it('a resolved extension request carries the Desktop label, the Claude normalizer\'s change and its repository; a Desktop request after it does not get that repository', async () => {
    codeTabSession('ext-session', join(home, 'work', 'org-b', 'repo-b'));
    const harness = await startProxy({ desktopRepositoryResolver: new DesktopRepositoryResolver() });

    await send(harness, { key: named('vscode-claude-code'), session: 'ext-session', body: CLAUDE_BODY });
    const extension = last(harness);
    await send(harness, { key: named('claude-desktop'), session: 'desk-unknown' });

    expect(extension.headers).toMatchObject({ 'x-codemie-client': 'claude-desktop', 'x-codemie-repository': 'org-b/repo-b' });
    expect(extension.body).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    expect(last(harness).headers['x-codemie-repository']).toBe('Cowork');
  });

  it('an unresolved extension request within 30 s of a Desktop resolution carries no repository', async () => {
    codeTabSession('desk-session', join(home, 'work', 'org-a', 'repo-a'));
    const harness = await startProxy({ desktopRepositoryResolver: new DesktopRepositoryResolver() });

    await send(harness, { key: named('claude-desktop'), session: 'desk-session' });
    const desktop = last(harness);
    await send(harness, { key: named('vscode-claude-code'), session: 'ext-unknown' });

    expect(desktop.headers['x-codemie-repository']).toBe('org-a/repo-a');
    expect(last(harness).headers).not.toHaveProperty('x-codemie-repository');
    expect(readdirSync(join(codemieHome, 'analytics', 'state'))).toEqual(['desk-session.cowork-served']);
  });

  it('a shared-key request under codemie-daemon resolved to a repository, not Cowork, keeps its client and takes no repository; a Desktop request after it does not get it', async () => {
    codeTabSession('daemon-session', join(home, 'work', 'org-b', 'repo-b'));
    const harness = await startProxy({ desktopRepositoryResolver: new DesktopRepositoryResolver() });

    await send(harness, { key: KEY, session: 'daemon-session' });
    const shared = last(harness);
    await send(harness, { key: named('claude-desktop'), session: 'desk-unknown' });

    expect(shared.headers['x-codemie-client']).toBe('codemie-daemon');
    expect(shared.headers).not.toHaveProperty('x-codemie-repository');
    expect(existsSync(markPath('daemon-session'))).toBe(false);
    expect(last(harness).headers['x-codemie-repository']).toBe('Cowork');
  });

  it('an unresolved shared-key request under codex-desktop after a Desktop resolution carries no repository', async () => {
    codeTabSession('desk-session', join(home, 'work', 'org-a', 'repo-a'));
    const harness = await startProxy({ clientType: 'codex-desktop', desktopRepositoryResolver: new DesktopRepositoryResolver() });

    await send(harness, { key: named('claude-desktop'), session: 'desk-session' });
    const desktop = last(harness);
    await send(harness, { key: KEY, session: 'codex-unknown', path: '/v1/responses', body: { model: 'gpt-5.2', input: [] } });

    expect(desktop.headers['x-codemie-repository']).toBe('org-a/repo-a');
    expect(last(harness).headers['x-codemie-client']).toBe('codex-desktop');
    expect(last(harness).headers).not.toHaveProperty('x-codemie-repository');
  });

  it('edge: under default client claude-desktop an unresolved shared-key request after a Desktop resolution takes the last resolved repository', async () => {
    codeTabSession('desk-session', join(home, 'work', 'org-a', 'repo-a'));
    const harness = await startProxy({ clientType: 'claude-desktop', desktopRepositoryResolver: new DesktopRepositoryResolver() });

    await send(harness, { key: KEY, session: 'desk-session' });
    await send(harness, { key: KEY, session: 'code-tab-unknown' });

    expect(last(harness).headers).toMatchObject({ 'x-codemie-client': 'claude-desktop', 'x-codemie-repository': 'org-a/repo-a' });
  });
});
