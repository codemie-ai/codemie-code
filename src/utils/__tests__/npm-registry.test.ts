import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchLatestVersionFromRegistry, resolveRegistry } from '../npm-registry.js';

// Real HTTP against a local server: the request path, proxying and timeouts are what matter here.
let server: Server;
let baseUrl: string;
let handler: (req: IncomingMessage, res: ServerResponse) => void;
const seenPaths: string[] = [];

const ENV_KEYS = [
  'npm_config_registry',
  'NPM_CONFIG_REGISTRY',
  'npm_config_userconfig',
  'NPM_CONFIG_USERCONFIG',
  'npm_config_proxy',
  'npm_config_https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
];
const savedEnv: Record<string, string | undefined> = {};
let workDir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    seenPaths.push(req.url ?? '');
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  workDir = await mkdtemp(join(tmpdir(), 'codemie-npm-registry-'));
  // No user .npmrc, so the developer's own npm settings can't leak into the tests.
  process.env.npm_config_userconfig = join(workDir, 'no-user-npmrc');
  seenPaths.length = 0;
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: '@openai/codex', version: '0.160.0' }));
  };
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await rm(workDir, { recursive: true, force: true });
});

const fetchFrom = (pkg: string, timeoutMs = 2000) => fetchLatestVersionFromRegistry(pkg, { timeoutMs, cwd: workDir });

describe('resolveRegistry', () => {
  it('defaults to the public npm registry', () => {
    expect(resolveRegistry('@openai/codex', workDir)).toBe('https://registry.npmjs.org/');
  });

  it('prefers a scoped registry from the project .npmrc over the default registry', async () => {
    await writeFile(join(workDir, '.npmrc'), `registry=${baseUrl}\n@openai:registry=${baseUrl}scoped\n`, 'utf-8');

    expect(resolveRegistry('@openai/codex', workDir)).toBe(`${baseUrl}scoped/`);
    expect(resolveRegistry('opencode-ai', workDir)).toBe(baseUrl);
  });

  it('lets the npm_config_registry env var override .npmrc', async () => {
    await writeFile(join(workDir, '.npmrc'), 'registry=https://example.invalid/\n', 'utf-8');
    process.env.npm_config_registry = baseUrl;

    expect(resolveRegistry('opencode-ai', workDir)).toBe(baseUrl);
  });

  it('strips quotes around .npmrc values', async () => {
    await writeFile(join(workDir, '.npmrc'), `registry="${baseUrl}quoted"\n`, 'utf-8');

    expect(resolveRegistry('opencode-ai', workDir)).toBe(`${baseUrl}quoted/`);
  });

  it('never expands env vars from a project .npmrc, so a repo cannot route secrets to its host', async () => {
    process.env.CODEMIE_TEST_SECRET = 'secret-token';
    try {
      await writeFile(join(workDir, '.npmrc'), 'registry=https://attacker.invalid/${CODEMIE_TEST_SECRET}/\n', 'utf-8');

      expect(resolveRegistry('opencode-ai', workDir)).toBe('https://registry.npmjs.org/');
    } finally {
      delete process.env.CODEMIE_TEST_SECRET;
    }
  });

  it('expands env vars from the user .npmrc', async () => {
    process.env.CODEMIE_TEST_HOST = '127.0.0.1';
    try {
      const userNpmrc = join(workDir, 'user-npmrc');
      await writeFile(userNpmrc, 'registry=https://${CODEMIE_TEST_HOST}/npm/\n', 'utf-8');
      process.env.npm_config_userconfig = userNpmrc;

      expect(resolveRegistry('opencode-ai', workDir)).toBe('https://127.0.0.1/npm/');
    } finally {
      delete process.env.CODEMIE_TEST_HOST;
    }
  });
});

describe('fetchLatestVersionFromRegistry', () => {
  beforeEach(() => {
    process.env.npm_config_registry = baseUrl;
  });

  it("returns the registry's latest version, requesting the encoded scoped path", async () => {
    await expect(fetchFrom('@openai/codex')).resolves.toBe('0.160.0');
    expect(seenPaths).toEqual(['/@openai%2fcodex/latest']);
  });

  it('resolves a registry configured under a path prefix (e.g. Artifactory)', async () => {
    process.env.npm_config_registry = `${baseUrl}api/npm/remote`;

    await expect(fetchFrom('@openai/codex')).resolves.toBe('0.160.0');
    expect(seenPaths).toEqual(['/api/npm/remote/@openai%2fcodex/latest']);
  });

  it.each([
    ['a non-200 status', (res: ServerResponse) => res.writeHead(404).end('{}')],
    ['invalid JSON', (res: ServerResponse) => res.writeHead(200).end('<html>proxy login</html>')],
    ['a body without a version', (res: ServerResponse) => res.writeHead(200).end('{"name":"x"}')],
  ])('returns null for %s', async (_label, respond) => {
    handler = (_req, res) => respond(res);

    await expect(fetchFrom('@openai/codex')).resolves.toBeNull();
  });

  it('returns null when the server never answers within the timeout', async () => {
    handler = () => undefined; // hold the request open

    const start = Date.now();
    await expect(fetchFrom('@openai/codex', 200)).resolves.toBeNull();
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it('returns null when a response keeps trickling past the overall deadline', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"version":');
      const timer = setInterval(() => res.write(' '), 50); // never idle, never finished
      res.on('close', () => clearInterval(timer));
    };

    const start = Date.now();
    await expect(fetchFrom('@openai/codex', 300)).resolves.toBeNull();
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it('returns null when the registry is unreachable', async () => {
    process.env.npm_config_registry = 'http://127.0.0.1:1/';

    await expect(fetchFrom('@openai/codex')).resolves.toBeNull();
  });

  it('sends the request through the configured proxy', async () => {
    process.env.npm_config_registry = 'http://registry.example.invalid/';
    process.env.HTTP_PROXY = baseUrl.replace(/\/$/, '');

    await expect(fetchFrom('@openai/codex')).resolves.toBe('0.160.0');
    // A forward proxy receives the absolute URL of the target.
    expect(seenPaths).toEqual(['http://registry.example.invalid/@openai%2fcodex/latest']);
  });

  it('bypasses the proxy for hosts listed in NO_PROXY', async () => {
    process.env.HTTP_PROXY = 'http://127.0.0.1:1';
    process.env.NO_PROXY = 'localhost,127.0.0.1';

    await expect(fetchFrom('@openai/codex')).resolves.toBe('0.160.0');
  });
});
