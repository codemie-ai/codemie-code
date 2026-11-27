import { describe, it, expect, vi, beforeEach } from 'vitest';

const order: string[] = [];

vi.mock('codemie-sdk', () => ({
  CodeMieClient: class {
    constructor() {
      order.push('construct');
    }
  },
}));
vi.mock('@/utils/network-error-capture.js', () => ({
  installNetworkErrorCapture: () => {
    order.push('install');
    return true;
  },
}));
vi.mock('ora', () => ({ default: () => ({ start: () => ({ text: '', succeed: vi.fn(), fail: vi.fn() }) }) }));
vi.mock('../config.js', () => ({ ConfigLoader: { load: vi.fn().mockResolvedValue({ baseUrl: 'https://x.example' }) } }));
vi.mock('../logger.js', () => ({ logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('../system-proxy.js', () => ({ applySystemProxyEnvironment: vi.fn() }));
vi.mock('../../providers/core/codemie-auth-helpers.js', () => ({
  getPlatformUrl: () => 'https://x.example',
  getStoredPlatformCredentials: async () => ({ credentials: { cookies: { a: 'b' }, apiUrl: 'https://x.example' } }),
}));

import { getCodemieClient } from '../sdk-client.js';

describe('getCodemieClient network capture', () => {
  beforeEach(() => {
    order.length = 0;
  });

  it('installs the capture before constructing the client', async () => {
    await getCodemieClient(true);
    expect(order).toEqual(['install', 'construct']);
  });
});
