import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchLatestVersionFromRegistry, resolveRegistry } from '../npm-registry.js';

// Real HTTP against a local server: the request path, proxying and timeouts are what matter here.
let server: Server;
let baseUrl: string;
let handler: (req: IncomingMessage, res: ServerResponse) => void;
const seenPaths: string[] = [];
// Targets of CONNECT tunnels the local server was asked to open (it acts as an https proxy).
const connectTargets: string[] = [];

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
  'CODEMIE_NO_SYSTEM_PROXY',
  // Set when the test runner itself was started via npm/npx; cleared so each test decides.
  'npm_command',
  'npm_execpath',
  'npm_lifecycle_event',
];
const savedEnv: Record<string, string | undefined> = {};
let workDir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    seenPaths.push(req.url ?? '');
    handler(req, res);
  });
  server.on('connect', (req: IncomingMessage, socket: Duplex) => {
    connectTargets.push(req.url ?? '');
    socket.destroy();
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
  // Nor the machine's Windows proxy/PAC settings, whose registry read can also outlast the
  // short timeouts below when the suite runs under full parallel load.
  process.env.CODEMIE_NO_SYSTEM_PROXY = '1';
  seenPaths.length = 0;
  connectTargets.length = 0;
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

const fetchFrom = (pkg: string, timeoutMs = 2000) => fetchLatestVersionFromRegistry(pkg, { timeoutMs });

// Writes the user-level .npmrc (the only npm config file the lookup reads).
const writeUserNpmrc = async (content: string): Promise<void> => {
  const userNpmrc = join(workDir, 'user-npmrc');
  await writeFile(userNpmrc, content, 'utf-8');
  process.env.npm_config_userconfig = userNpmrc;
};

describe('resolveRegistry', () => {
  it('defaults to the public npm registry', () => {
    expect(resolveRegistry('@openai/codex')).toBe('https://registry.npmjs.org/');
  });

  it('prefers a scoped registry from the user .npmrc over the default registry', async () => {
    await writeUserNpmrc(`registry=${baseUrl}\n@openai:registry=${baseUrl}scoped\n`);

    expect(resolveRegistry('@openai/codex')).toBe(`${baseUrl}scoped/`);
    expect(resolveRegistry('opencode-ai')).toBe(baseUrl);
  });

  it('lets the npm_config_registry env var override .npmrc', async () => {
    await writeUserNpmrc('registry=https://example.invalid/\n');
    process.env.npm_config_registry = baseUrl;

    expect(resolveRegistry('opencode-ai')).toBe(baseUrl);
  });

  it('strips quotes around .npmrc values', async () => {
    await writeUserNpmrc(`registry="${baseUrl}quoted"\n`);

    expect(resolveRegistry('opencode-ai')).toBe(`${baseUrl}quoted/`);
  });

  it('ignores the current project .npmrc, so a repo cannot pick the registry or proxy', async () => {
    await writeFile(
      join(workDir, '.npmrc'),
      'registry=https://attacker.invalid/\n@openai:registry=https://attacker.invalid/\nhttps-proxy=http://attacker.invalid:8080\n',
      'utf-8'
    );
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(workDir);
    try {
      expect(resolveRegistry('@openai/codex')).toBe('https://registry.npmjs.org/');
      expect(resolveRegistry('opencode-ai')).toBe('https://registry.npmjs.org/');
    } finally {
      cwd.mockRestore();
    }
  });

  it('ignores npm_config_* env vars when launched via npm/npx, which exports the project .npmrc', async () => {
    const home = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    // Under npm even npm_config_userconfig is untrusted, so only ~/.npmrc is read.
    process.env.HOME = workDir;
    process.env.USERPROFILE = workDir;
    try {
      await writeFile(join(workDir, '.npmrc'), `registry=${baseUrl}\n`, 'utf-8');
      process.env.npm_command = 'exec';
      process.env.npm_config_registry = 'https://attacker.invalid/';
      process.env.npm_config_userconfig = join(workDir, 'attacker-npmrc');

      expect(resolveRegistry('opencode-ai')).toBe(baseUrl);
    } finally {
      for (const [key, value] of Object.entries(home)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('expands env vars from the user .npmrc', async () => {
    process.env.CODEMIE_TEST_HOST = '127.0.0.1';
    try {
      await writeUserNpmrc('registry=https://${CODEMIE_TEST_HOST}/npm/\n');

      expect(resolveRegistry('opencode-ai')).toBe('https://127.0.0.1/npm/');
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

  it("prefers npm's own proxy setting over HTTP_PROXY, as npm does", async () => {
    process.env.npm_config_registry = 'http://registry.example.invalid/';
    process.env.HTTP_PROXY = 'http://127.0.0.1:1'; // would fail if used
    await writeUserNpmrc(`proxy=${baseUrl}\n`);

    await expect(fetchFrom('@openai/codex')).resolves.toBe('0.160.0');
    expect(seenPaths).toEqual(['http://registry.example.invalid/@openai%2fcodex/latest']);
  });

  it("tunnels an https registry through the user .npmrc https-proxy, ignoring HTTP(S)_PROXY", async () => {
    delete process.env.npm_config_registry;
    process.env.HTTP_PROXY = 'http://127.0.0.1:1'; // dead; would fail if used
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
    await writeUserNpmrc(`registry=https://registry.example.invalid/
https-proxy=${baseUrl}
`);

    // The proxy closes the tunnel, so the lookup fails — but only after asking for the registry host.
    await expect(fetchFrom('@openai/codex')).resolves.toBeNull();
    expect(connectTargets).toEqual(['registry.example.invalid:443']);
  });

  it('fails the lookup instead of going direct when the configured npm proxy is invalid', async () => {
    // A loopback host outside the implicit no-proxy list, so the npm proxy setting applies and a
    // direct request would reach the local registry and succeed.
    process.env.npm_config_registry = baseUrl.replace('127.0.0.1', '[::ffff:127.0.0.1]');
    await writeUserNpmrc('proxy=not a proxy url\n');

    await expect(fetchFrom('@openai/codex')).resolves.toBeNull();
    expect(seenPaths).toEqual([]);
  });

  it("applies npm's noproxy even when the proxy comes from HTTP_PROXY", async () => {
    process.env.npm_config_registry = 'http://registry.example.invalid/';
    process.env.HTTP_PROXY = baseUrl.replace(/\/$/, '');
    await writeUserNpmrc('noproxy=registry.example.invalid\n');

    // Goes direct to the (unresolvable) registry, so the proxy never sees the request.
    await expect(fetchFrom('@openai/codex')).resolves.toBeNull();
    expect(seenPaths).toEqual([]);
  });
});
