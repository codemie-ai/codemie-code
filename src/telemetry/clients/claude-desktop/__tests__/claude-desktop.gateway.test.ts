/**
 * The reader of Claude Desktop's applied gateway and its two predicates, over a temp Desktop base directory.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isDesktopConnectedTo,
  isDesktopPointedAtLocalProxy,
  readDesktopGatewayConfig,
  readDesktopGatewayState,
} from '../claude-desktop.gateway.js';

let baseDir: string;
const originalPlatform = process.platform;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'desktop-gateway-reader-'));
  await mkdir(join(baseDir, 'configLibrary'), { recursive: true });
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  await rm(baseDir, { recursive: true, force: true });
});

async function writeLibrary(meta: unknown, applied?: Record<string, unknown>): Promise<void> {
  const lib = join(baseDir, 'configLibrary');
  await writeFile(join(lib, '_meta.json'), JSON.stringify(meta));
  if (applied) await writeFile(join(lib, 'a.json'), JSON.stringify(applied));
}

const gateway = (fields: Record<string, unknown> = {}) => ({
  inferenceProvider: 'gateway',
  inferenceGatewayBaseUrl: 'http://127.0.0.1:4001',
  inferenceGatewayApiKey: 'codemie-proxy',
  ...fields,
});

describe('readDesktopGatewayConfig', () => {
  it.each([
    ['the shared key', 'codemie-proxy'],
    ['the named Desktop key', 'codemie-proxy.claude-desktop'],
    ['another key', 'sk-user-own'],
  ])('gives the port and key of a loopback gateway config with %s', async (_case, key) => {
    await writeLibrary({ appliedId: 'a' }, gateway({ inferenceGatewayApiKey: key }));
    await expect(readDesktopGatewayConfig(baseDir)).resolves.toEqual({ port: 4001, apiKey: key });
  });

  it.each([
    ['with', { inferenceCredentialKind: 'interactive' }],
    ['without', {}],
  ])('reads the same %s inferenceCredentialKind', async (_case, fields) => {
    await writeLibrary({ appliedId: 'a' }, gateway(fields));
    await expect(readDesktopGatewayConfig(baseDir)).resolves.toEqual({ port: 4001, apiKey: 'codemie-proxy' });
  });

  it.each([
    ['__sealed__:v1:QUJD'],
    ['  __sealed__:v2:QUJD'],
  ])('gives the port and the sealed case, no key, for the sealed key %j', async (key) => {
    await writeLibrary({ appliedId: 'a' }, gateway({ inferenceGatewayApiKey: key }));
    await expect(readDesktopGatewayConfig(baseDir)).resolves.toEqual({ port: 4001, sealed: true });
  });

  it('gives the port alone, not sealed, with no inferenceGatewayApiKey', async () => {
    await writeLibrary({ appliedId: 'a' }, gateway({ inferenceGatewayApiKey: undefined }));
    await expect(readDesktopGatewayConfig(baseDir)).resolves.toEqual({ port: 4001 });
  });

  it.each([
    ['a non-loopback URL', { inferenceGatewayBaseUrl: 'https://gateway.example.com:4001' }],
    ['a provider that is not gateway', { inferenceProvider: 'anthropic' }],
  ])('is null for a sealed key with %s', async (_case, fields) => {
    await writeLibrary({ appliedId: 'a' }, gateway({ inferenceGatewayApiKey: '__sealed__:v1:QUJD', ...fields }));
    await expect(readDesktopGatewayConfig(baseDir)).resolves.toBeNull();
  });

  it('is null for a non-loopback URL', async () => {
    await writeLibrary({ appliedId: 'a' }, gateway({ inferenceGatewayBaseUrl: 'https://gateway.example.com:4001' }));
    await expect(readDesktopGatewayConfig(baseDir)).resolves.toBeNull();
  });

  it('is null with no _meta.json', async () => {
    await expect(readDesktopGatewayConfig(baseDir)).resolves.toBeNull();
  });

  it('is null when appliedId names a missing file', async () => {
    await writeLibrary({ appliedId: 'a' });
    await expect(readDesktopGatewayConfig(baseDir)).resolves.toBeNull();
  });

  it('is null on an unsupported platform, never throwing', async () => {
    Object.defineProperty(process, 'platform', { value: 'aix', configurable: true });
    await expect(readDesktopGatewayConfig()).resolves.toBeNull();
  });
});

describe('readDesktopGatewayState', () => {
  it('gives a loopback gateway, naming a gateway', async () => {
    await writeLibrary({ appliedId: 'a' }, gateway());
    await expect(readDesktopGatewayState(baseDir)).resolves.toEqual({
      gateway: { port: 4001, apiKey: 'codemie-proxy' },
      namesGateway: true,
    });
  });

  it('names a gateway for a non-loopback one, with no gateway of its own', async () => {
    await writeLibrary({ appliedId: 'a' }, gateway({ inferenceGatewayBaseUrl: 'https://gateway.example.com:4001' }));
    await expect(readDesktopGatewayState(baseDir)).resolves.toEqual({ gateway: null, namesGateway: true });
  });

  it.each([
    ['no _meta.json', async () => {}],
    ['_meta.json without appliedId', () => writeLibrary({ entries: [] })],
    ['an applied entry without inferenceProvider', () => writeLibrary({ appliedId: 'a' }, { managedMcpServers: '[]' })],
    ['appliedId naming a missing file', () => writeLibrary({ appliedId: 'a' })],
  ])('names no gateway with %s', async (_case, arrange) => {
    await arrange();
    await expect(readDesktopGatewayState(baseDir)).resolves.toEqual({ gateway: null, namesGateway: false });
  });

  it.each([
    ['not a string', 7],
    ['not a safe file name', '../a'],
  ])('takes an appliedId that is %s for a gateway', async (_case, appliedId) => {
    await writeLibrary({ appliedId });
    await expect(readDesktopGatewayState(baseDir)).resolves.toEqual({ gateway: null, namesGateway: true });
  });

  it('takes an unparsable _meta.json for a gateway, never throwing', async () => {
    await writeFile(join(baseDir, 'configLibrary', '_meta.json'), '{not json');
    await expect(readDesktopGatewayState(baseDir)).resolves.toEqual({ gateway: null, namesGateway: true });
  });
});

describe('the gateway predicates', () => {
  it.each([
    ['the shared key', 'codemie-proxy', true],
    ['the named Desktop key', 'codemie-proxy.claude-desktop', true],
    ['the key named for another client', 'codemie-proxy.codex-desktop', false],
    ['another key', 'sk-user-own', false],
    ['no key', undefined, false],
  ])('Desktop with %s points at the local proxy: %s', (_case, apiKey, expected) => {
    expect(isDesktopPointedAtLocalProxy({ port: 4005, ...(apiKey && { apiKey }) }, 'codemie-proxy')).toBe(expected);
  });

  it('Desktop is connected to this daemon only on its port', () => {
    expect(isDesktopConnectedTo({ port: 4001, apiKey: 'codemie-proxy.claude-desktop' }, 'codemie-proxy', 4001)).toBe(true);
    expect(isDesktopConnectedTo({ port: 4005, apiKey: 'codemie-proxy' }, 'codemie-proxy', 4001)).toBe(false);
  });

  it.each([
    ['a sealed key on the daemon\'s port', '__sealed__:v1:QUJD', 'http://127.0.0.1:4001', true, true],
    ['a sealed key on another loopback port', '__sealed__:v1:QUJD', 'http://localhost:4005', true, false],
    ['another client\'s named key on the daemon\'s port', 'codemie-proxy.vscode-claude-code', 'http://127.0.0.1:4001', false, false],
    ['no key on the daemon\'s port', undefined, 'http://127.0.0.1:4001', false, false],
  ])('Desktop config read with %s: pointed %s, connected %s', async (_case, key, url, pointed, connected) => {
    await writeLibrary({ appliedId: 'a' }, gateway({ inferenceGatewayApiKey: key, inferenceGatewayBaseUrl: url }));
    const read = await readDesktopGatewayConfig(baseDir);
    expect(isDesktopPointedAtLocalProxy(read, 'codemie-proxy')).toBe(pointed);
    expect(isDesktopConnectedTo(read, 'codemie-proxy', 4001)).toBe(connected);
  });

  it('no gateway is neither pointed nor connected', () => {
    expect(isDesktopPointedAtLocalProxy(null, 'codemie-proxy')).toBe(false);
    expect(isDesktopConnectedTo(null, 'codemie-proxy', 4001)).toBe(false);
  });
});
