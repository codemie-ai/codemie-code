/**
 * mcp-auth-proxy metadata discovery + cache tests (fetchJson injected — no network).
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  METADATA_TTL_MS,
  NEGATIVE_TTL_MS,
  MetadataCache,
  MetadataDiscoveryError,
} from '../metadata-cache.js';
import { logger } from '../../../utils/logger.js';
import type { JsonObject, RouteConfig } from '../types.js';

const route: RouteConfig = { upstreamUrl: 'https://mcp.example.com/mcp/radar' };

const PRM: JsonObject = {
  resource: 'https://mcp.example.com/mcp/radar/',
  authorization_servers: ['https://idp.example.com/realms/x'],
};
const AS: JsonObject = {
  issuer: 'https://idp.example.com/realms/x',
  authorization_endpoint: 'https://idp.example.com/a',
  token_endpoint: 'https://idp.example.com/t',
  registration_endpoint: 'https://idp.example.com/r',
};

const PRM_PATH_URL = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp/radar';
const AS_8414_URL = 'https://idp.example.com/.well-known/oauth-authorization-server/realms/x';

function fakeFetcher(docs: Record<string, JsonObject>): {
  calls: string[];
  fetchJson: (url: string) => Promise<JsonObject>;
} {
  const calls: string[] = [];
  return {
    calls,
    fetchJson: (url: string): Promise<JsonObject> => {
      calls.push(url);
      const doc = docs[url];
      return doc !== undefined ? Promise.resolve(doc) : Promise.reject(new Error(`404 ${url}`));
    },
  };
}

const HAPPY_DOCS: Record<string, JsonObject> = {
  [PRM_PATH_URL]: PRM,
  [AS_8414_URL]: AS,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MetadataCache', () => {
  it('discovers PRM path-variant first and AS metadata in the spec priority order', async () => {
    const { calls, fetchJson } = fakeFetcher(HAPPY_DOCS);
    const cache = new MetadataCache(fetchJson);
    const meta = await cache.getMetadata('radar', route);
    expect(calls[0]).toBe(PRM_PATH_URL);
    expect(calls[1]).toBe(AS_8414_URL);
    expect(meta.upstreamResource).toBe('https://mcp.example.com/mcp/radar');
    expect(meta.registrationEndpoint).toBe('https://idp.example.com/r');
    expect(meta.authorizationEndpoint).toBe('https://idp.example.com/a');
    expect(meta.tokenEndpoint).toBe('https://idp.example.com/t');
    expect(meta.revocationEndpoint).toBeUndefined();
    expect(cache.getStatus('radar')).toBe('ok');
  });

  it('falls back to the root PRM variant and the OIDC path-appending AS variant', async () => {
    const docs: Record<string, JsonObject> = {
      'https://mcp.example.com/.well-known/oauth-protected-resource': PRM,
      'https://idp.example.com/realms/x/.well-known/openid-configuration': AS,
    };
    const { calls, fetchJson } = fakeFetcher(docs);
    const cache = new MetadataCache(fetchJson);
    await cache.getMetadata('radar', route);
    expect(calls).toContain('https://mcp.example.com/.well-known/oauth-protected-resource');
    const insertion = calls.indexOf(AS_8414_URL);
    const oidcInsertion = calls.indexOf(
      'https://idp.example.com/.well-known/openid-configuration/realms/x'
    );
    const appending = calls.indexOf(
      'https://idp.example.com/realms/x/.well-known/openid-configuration'
    );
    expect(insertion).toBeGreaterThanOrEqual(0);
    expect(insertion).toBeLessThan(oidcInsertion);
    expect(oidcInsertion).toBeLessThan(appending);
  });

  it('prefers a PRM URL captured from a live 401 challenge', async () => {
    const hinted = 'https://mcp.example.com/custom/prm-location';
    const { calls, fetchJson } = fakeFetcher({ ...HAPPY_DOCS, [hinted]: PRM });
    const cache = new MetadataCache(fetchJson);
    cache.notePrmUrl('radar', hinted);
    await cache.getMetadata('radar', route);
    expect(calls[0]).toBe(hinted);
  });

  it('caches positive results for the TTL and refreshes after expiry', async () => {
    const { calls, fetchJson } = fakeFetcher(HAPPY_DOCS);
    const cache = new MetadataCache(fetchJson);
    await cache.getMetadata('radar', route);
    await cache.getMetadata('radar', route);
    expect(calls.length).toBe(2);
    vi.advanceTimersByTime(METADATA_TTL_MS + 1);
    await cache.getMetadata('radar', route);
    expect(calls.length).toBe(4);
  });

  it('negative-caches failures for 10 s, retries after, and keeps failures per-route', async () => {
    const { calls, fetchJson } = fakeFetcher({});
    const cache = new MetadataCache(fetchJson);
    await expect(cache.getMetadata('radar', route)).rejects.toThrow(MetadataDiscoveryError);
    expect(cache.getStatus('radar')).toBe('degraded');
    const callsAfterFirst = calls.length;
    await expect(cache.getMetadata('radar', route)).rejects.toThrow(MetadataDiscoveryError);
    expect(calls.length).toBe(callsAfterFirst);
    expect(cache.getStatus('other')).toBe('unknown');
    vi.advanceTimersByTime(NEGATIVE_TTL_MS + 1);
    await expect(cache.getMetadata('radar', route)).rejects.toThrow(MetadataDiscoveryError);
    expect(calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('warns and uses the first AS when the upstream PRM lists several', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const docs: Record<string, JsonObject> = {
      [PRM_PATH_URL]: {
        ...PRM,
        authorization_servers: ['https://idp.example.com/realms/x', 'https://other.example'],
      },
      [AS_8414_URL]: AS,
    };
    const cache = new MetadataCache(fakeFetcher(docs).fetchJson);
    const meta = await cache.getMetadata('radar', route);
    expect(meta.tokenEndpoint).toBe('https://idp.example.com/t');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('fails when the AS advertises no registration_endpoint (DCR is mandatory)', async () => {
    const asWithoutRegistration: JsonObject = { ...AS };
    delete asWithoutRegistration.registration_endpoint;
    const docs: Record<string, JsonObject> = { [PRM_PATH_URL]: PRM, [AS_8414_URL]: asWithoutRegistration };
    const cache = new MetadataCache(fakeFetcher(docs).fetchJson);
    await expect(cache.getMetadata('radar', route)).rejects.toThrow(/registration_endpoint/);
  });

  it('fails when the PRM has no authorization_servers', async () => {
    const docs: Record<string, JsonObject> = { [PRM_PATH_URL]: { resource: 'x' } };
    const cache = new MetadataCache(fakeFetcher(docs).fetchJson);
    await expect(cache.getMetadata('radar', route)).rejects.toThrow(/authorization_servers/);
  });
});
