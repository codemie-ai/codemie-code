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
vi.mock('@/utils/sdk-client.js', () => ({
  getCodemieClient: vi.fn(async () => {
    order.push('install');
    order.push('construct');
    return {};
  }),
}));
vi.mock('@/utils/system-proxy.js', () => ({ applySystemProxyEnvironment: vi.fn() }));
vi.mock('@/providers/plugins/jwt/jwt.utils.js', () => ({
  resolveJwtToken: () => 'token',
  resolveJwtTokenEnvVar: () => 'X',
}));

import { getAuthenticatedClient } from '@/utils/auth.js';
import { AuthMethod } from '@/providers/core/types.js';
import type { CodeMieConfigOptions } from '@/env/types.js';

describe('getAuthenticatedClient network capture', () => {
  beforeEach(() => {
    order.length = 0;
  });

  it('installs the capture before constructing the client on the JWT path', async () => {
    await getAuthenticatedClient({ authMethod: AuthMethod.JWT, baseUrl: 'https://x.example' } as CodeMieConfigOptions);
    expect(order).toEqual(['install', 'construct']);
  });
});
