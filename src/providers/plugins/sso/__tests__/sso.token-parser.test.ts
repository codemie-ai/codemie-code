/**
 * Tests for parseSSOToken - shared SSO token decoding (browser callback and headless paste).
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseSSOToken } from '../sso.token-parser.js';

const BASE = 'https://codemie.example.com';
const cookies = { _oauth2_proxy: 'secret-cookie-value' };
const raw = Buffer.from(JSON.stringify({ cookies })).toString('base64');

describe('parseSSOToken', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts a raw base64 token (trimmed)', async () => {
    const result = await parseSSOToken(`  ${raw}\n`, { codeMieUrl: BASE });
    expect(result.cookies).toEqual(cookies);
    expect(result.apiUrl).toBe(`${BASE}/code-assistant-api`);
  });

  it.each(['token', 'auth', 'data'])('accepts a pasted redirect URL with %s param', async (param) => {
    const url = `http://localhost:1234/?${param}=${encodeURIComponent(raw)}`;
    const result = await parseSSOToken(url, { codeMieUrl: BASE });
    expect(result.cookies).toEqual(cookies);
  });

  it('uses VITE_API_URL from config.js when available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'VITE_API_URL: "https://api.example.com/x/"',
    }));
    const result = await parseSSOToken(raw, { codeMieUrl: BASE });
    expect(result.apiUrl).toBe('https://api.example.com/x');
  });

  it('passes a timeout signal to the config.js fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', fetchMock);
    await parseSSOToken(raw, { codeMieUrl: BASE });
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   \n'],
    ['garbage', 'not-a-token!!'],
    ['url without token', 'http://localhost:1234/?foo=bar'],
    ['base64 without cookies', Buffer.from(JSON.stringify({ a: 1 })).toString('base64')],
  ])('rejects %s with a fixed message that does not echo the input', async (_l, input) => {
    const err = await parseSSOToken(input, { codeMieUrl: BASE }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.length).toBeGreaterThan(0);
    if (input.trim()) expect((err as Error).message).not.toContain(input.trim());
  });
});
