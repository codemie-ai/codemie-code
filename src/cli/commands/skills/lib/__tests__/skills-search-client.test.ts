/**
 * Unit tests for the two-source search HTTP client used by `codemie skills find`.
 *
 * Spec §5 requires:
 *   - searchPublic always hits skills.sh, no auth, no cookies
 *   - searchInternal returns { available: false, results: [] } immediately
 *     when neither env var nor config field is set (no HTTP call)
 *   - searchInternal attaches SSO cookies when configured
 *   - both functions never throw on network/parse errors
 *   - upstream `id` is mapped to our `slug`
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetStoredCredentials = vi.fn();
const mockConfigLoad = vi.fn();

vi.mock('@/utils/config.js', () => ({
  ConfigLoader: { load: () => mockConfigLoad() },
}));

vi.mock('@/providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: class {
    getStoredCredentials = (...args: unknown[]) => mockGetStoredCredentials(...args);
  },
}));

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockGetStoredCredentials.mockReset();
  mockConfigLoad.mockReset();
  delete process.env.CODEMIE_SKILLS_SEARCH_URL;

  fetchSpy = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ skills: [] }),
  });
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  vi.resetModules();
  delete process.env.CODEMIE_SKILLS_SEARCH_URL;
});

async function importClient(): Promise<typeof import('../skills-search-client.js')> {
  vi.resetModules();
  return import('../skills-search-client.js');
}

describe('searchPublic', () => {
  it('GETs skills.sh with the URL-encoded query and the limit', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        skills: [
          {
            name: 'pdf',
            id: 'anthropics/skills/pdf',
            source: 'anthropics/skills',
            installs: 93100,
          },
        ],
      }),
    });

    const { searchPublic } = await importClient();
    const section = await searchPublic('pdf agent', 7);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://skills.sh/api/search?q=pdf%20agent&limit=7');
    expect(init.headers.Cookie).toBeUndefined();
    expect(section.available).toBe(true);
    expect(section.results).toHaveLength(1);
    expect(section.results[0]).toMatchObject({
      name: 'pdf',
      slug: 'anthropics/skills/pdf',
      source: 'anthropics/skills',
      installs: 93100,
    });
  });

  it('returns { available: false, results: [] } on non-2xx response', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({}),
    });
    const { searchPublic } = await importClient();
    const section = await searchPublic('pdf', 10);
    expect(section).toEqual({ available: false, results: [] });
  });

  it('does not throw on network errors', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    const { searchPublic } = await importClient();
    await expect(searchPublic('pdf', 10)).resolves.toEqual({
      available: false,
      results: [],
    });
  });

  it('drops entries that have no id/slug', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        skills: [
          { name: 'no-id', source: 'x/y' },
          { name: 'kept', id: 'x/y/kept', source: 'x/y' },
        ],
      }),
    });
    const { searchPublic } = await importClient();
    const section = await searchPublic('q', 10);
    expect(section.available).toBe(true);
    expect(section.results.map((r) => r.slug)).toEqual(['x/y/kept']);
  });
});

describe('searchInternal', () => {
  it('returns { available: false, results: [] } and makes no HTTP call when no URL is configured', async () => {
    mockConfigLoad.mockResolvedValue({});
    const { searchInternal } = await importClient();
    const section = await searchInternal('pdf', 10);
    expect(section).toEqual({ available: false, results: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses the env var when set, with cookies attached', async () => {
    process.env.CODEMIE_SKILLS_SEARCH_URL = 'https://internal.example.com/v1/skills/search';
    mockConfigLoad.mockResolvedValue({ codeMieUrl: 'https://codemie.lab.epam.com' });
    mockGetStoredCredentials.mockResolvedValue({
      cookies: { session: 'abc', other: 'def' },
    });
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        skills: [{ name: 'sec', id: 'epam/sec', source: 'epam', installs: 5 }],
      }),
    });

    const { searchInternal } = await importClient();
    const section = await searchInternal('pdf', 5);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://internal.example.com/v1/skills/search?q=pdf&limit=5');
    expect(init.headers.Cookie).toMatch(/session=abc/);
    expect(init.headers.Cookie).toMatch(/other=def/);
    expect(init.headers['X-CodeMie-Client']).toBe('codemie-cli');
    expect(section.available).toBe(true);
    expect(section.results[0]?.slug).toBe('epam/sec');
  });

  it('prefers env var over config when both are set', async () => {
    process.env.CODEMIE_SKILLS_SEARCH_URL = 'https://from-env.example.com/search';
    mockConfigLoad.mockResolvedValue({
      codeMieUrl: 'https://codemie.lab.epam.com',
      skillsSearchUrl: 'https://from-config.example.com/search',
    });
    mockGetStoredCredentials.mockResolvedValue({ cookies: { session: 'abc' } });

    const { searchInternal } = await importClient();
    await searchInternal('q', 10);

    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://from-env.example.com/search?q=q&limit=10');
  });

  it('falls back to config field when env var is unset', async () => {
    mockConfigLoad.mockResolvedValue({
      codeMieUrl: 'https://codemie.lab.epam.com',
      skillsSearchUrl: 'https://from-config.example.com/search',
    });
    mockGetStoredCredentials.mockResolvedValue({ cookies: { session: 'abc' } });

    const { searchInternal } = await importClient();
    await searchInternal('q', 10);

    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://from-config.example.com/search?q=q&limit=10');
  });

  it('returns { available: false, results: [] } on 401', async () => {
    process.env.CODEMIE_SKILLS_SEARCH_URL = 'https://internal.example.com/search';
    mockConfigLoad.mockResolvedValue({ codeMieUrl: 'https://codemie.lab.epam.com' });
    mockGetStoredCredentials.mockResolvedValue({ cookies: { session: 'abc' } });
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({}),
    });

    const { searchInternal } = await importClient();
    const section = await searchInternal('q', 10);
    expect(section).toEqual({ available: false, results: [] });
  });
});
