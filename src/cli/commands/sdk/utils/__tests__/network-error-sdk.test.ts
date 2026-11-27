import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';

// Real SDK, real axios, real local server; only config, terminal and logging are replaced.
const mockConfigLoad = vi.fn();
vi.mock('ora', () => ({ default: () => ({ start: () => ({ text: '', succeed: vi.fn(), fail: vi.fn() }) }) }));
vi.mock('@/utils/config.js', () => ({ ConfigLoader: { load: () => mockConfigLoad() } }));
vi.mock('@/utils/logger.js', () => ({ logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import { CodeMieClient } from 'codemie-sdk';
import { getAuthenticatedClient } from '@/utils/auth.js';
import { getCodemieClient } from '@/utils/sdk-client.js';
import { CredentialStore } from '@/utils/security.js';
import { handleSdkError } from '../cli-utils.js';

const originalAdapter = axios.defaults.adapter;

function printed(error: unknown): string {
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((m: unknown) => void lines.push(String(m)));
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  handleSdkError(error, 'list assistants');
  return lines.join('\n');
}

async function failure(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

describe('SDK network failure reporting against a redirect loop', () => {
  let server: Server;
  let baseUrl: string;
  let home: string;
  let previousHome: string | undefined;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(302, { location: `${baseUrl}/loop` });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    axios.defaults.adapter = originalAdapter;
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(async () => {
    previousHome = process.env.CODEMIE_HOME;
    home = mkdtempSync(join(tmpdir(), 'codemie-network-error-'));
    process.env.CODEMIE_HOME = home;
    mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl });
    await CredentialStore.getInstance().storeSSOCredentials(
      { cookies: { _oauth2_proxy: 'cookie-value' }, apiUrl: baseUrl },
      baseUrl
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // Must run first: no factory has installed the capture yet.
  it('control: without the capture the SDK reports only a generic HTTP 500', async () => {
    const client = new CodeMieClient({
      codemie_api_domain: baseUrl,
      cookies: { _oauth2_proxy: 'cookie-value' },
      verify_ssl: true,
    });
    const out = printed(await failure(() => client.assistants.list()));
    expect(out).toContain('HTTP 500');
    expect(out).not.toContain('ERR_FR_TOO_MANY_REDIRECTS');
  });

  it('getCodemieClient reports the axios error code', async () => {
    const client = await getCodemieClient(true);
    const out = printed(await failure(() => client.assistants.list()));
    expect(out).toContain('ERR_FR_TOO_MANY_REDIRECTS');
    expect(out).not.toContain('HTTP 500');
  });

  it('getAuthenticatedClient reports the axios error code', async () => {
    const client = await getAuthenticatedClient(await mockConfigLoad());
    const out = printed(await failure(() => client.assistants.list()));
    expect(out).toContain('ERR_FR_TOO_MANY_REDIRECTS');
    expect(out).not.toContain('HTTP 500');
  });
});
