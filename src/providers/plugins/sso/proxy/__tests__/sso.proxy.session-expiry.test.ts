/**
 * CodeMieProxy — session-expiry unit tests
 *
 * S6: sendSessionExpiredResponse emits a correct Anthropic authentication_error body
 * S7: attemptSSOReauth returns false immediately when authMethod === 'jwt'
 *
 * @group unit
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- module mocks must come before all imports ---

vi.mock('../../../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Prevent the proxy constructor / start() from touching ProviderRegistry
vi.mock('../../../../core/registry.js', () => ({
  ProviderRegistry: {
    getProvider: vi.fn().mockReturnValue(null),
  },
}));

// Prevent ProxyHTTPClient from opening real sockets
vi.mock('../proxy-http-client.js', () => {
  const MockClient = function MockProxyHTTPClient(this: any) {
    this.close = vi.fn();
  };
  return { ProxyHTTPClient: MockClient };
});

// Prevent auto-registration of plugins which may have side effects
vi.mock('../plugins/index.js', () => ({}));

// Provide a registry that returns an empty interceptors list
vi.mock('../plugins/registry.js', () => ({
  getPluginRegistry: vi.fn().mockReturnValue({
    initialize: vi.fn().mockResolvedValue([]),
  }),
}));

// SSO module — authenticate is the spy we will assert on in S7
const mockAuthenticate = vi.fn();
vi.mock('../../sso.auth.js', () => ({
  CodeMieSSO: vi.fn().mockImplementation(() => ({
    authenticate: mockAuthenticate,
    getStoredCredentials: vi.fn().mockResolvedValue(null),
  })),
}));

import { ServerResponse } from 'http';
import { CodeMieProxy } from '../sso.proxy.js';
import { ProxyConfig, ProxyContext } from '../proxy-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMinimalConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    targetApiUrl: 'https://api.codemie.example.com',
    sessionId: 'test-session',
    ...overrides,
  };
}

function createMockRes(): {
  statusCode: number;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  capturedBody: string;
} {
  let body = '';
  return {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((data: string) => {
      body = data;
    }),
    get capturedBody() {
      return body;
    },
  };
}

function createProxyContext(overrides: Partial<ProxyContext> = {}): ProxyContext {
  return {
    requestId: 'test-request-id',
    sessionId: 'test-session',
    agentName: 'test-agent',
    method: 'POST',
    url: '/v1/messages',
    headers: {},
    requestBody: null,
    requestStartTime: Date.now(),
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodeMieProxy — session expiry behaviour', () => {
  let proxy: CodeMieProxy;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // S6 — sendSessionExpiredResponse
  // -------------------------------------------------------------------------
  describe('S6: sendSessionExpiredResponse', () => {
    beforeEach(() => {
      proxy = new CodeMieProxy(createMinimalConfig());
    });

    it('sets response statusCode to 401', () => {
      const res = createMockRes();
      const ctx = createProxyContext();

      (proxy as any).sendSessionExpiredResponse(res as unknown as ServerResponse, ctx);

      expect(res.statusCode).toBe(401);
    });

    it('sets Content-Type header to application/json', () => {
      const res = createMockRes();
      const ctx = createProxyContext();

      (proxy as any).sendSessionExpiredResponse(res as unknown as ServerResponse, ctx);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    });

    it('sends a body with type === "error"', () => {
      const res = createMockRes();
      const ctx = createProxyContext();

      (proxy as any).sendSessionExpiredResponse(res as unknown as ServerResponse, ctx);

      const parsed = JSON.parse(res.capturedBody);
      expect(parsed.type).toBe('error');
    });

    it('sends a body with error.type === "authentication_error"', () => {
      const res = createMockRes();
      const ctx = createProxyContext();

      (proxy as any).sendSessionExpiredResponse(res as unknown as ServerResponse, ctx);

      const parsed = JSON.parse(res.capturedBody);
      expect(parsed.error.type).toBe('authentication_error');
    });

    it('sends a message that references "codemie profile login"', () => {
      const res = createMockRes();
      const ctx = createProxyContext();

      (proxy as any).sendSessionExpiredResponse(res as unknown as ServerResponse, ctx);

      const parsed = JSON.parse(res.capturedBody);
      expect(parsed.error.message).toContain('codemie profile login');
    });

    it('calls res.end exactly once', () => {
      const res = createMockRes();
      const ctx = createProxyContext();

      (proxy as any).sendSessionExpiredResponse(res as unknown as ServerResponse, ctx);

      expect(res.end).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // S7 — attemptSSOReauth JWT bypass
  // -------------------------------------------------------------------------
  describe('S7: attemptSSOReauth — JWT bypass', () => {
    it('returns false immediately when authMethod is "jwt"', async () => {
      proxy = new CodeMieProxy(createMinimalConfig({ authMethod: 'jwt' }));

      const result = await (proxy as any).attemptSSOReauth();

      expect(result).toBe(false);
    });

    it('does NOT call CodeMieSSO.authenticate when authMethod is "jwt"', async () => {
      proxy = new CodeMieProxy(createMinimalConfig({ authMethod: 'jwt' }));

      await (proxy as any).attemptSSOReauth();

      expect(mockAuthenticate).not.toHaveBeenCalled();
    });

    it('returns false for JWT even when profileConfig.codeMieUrl is set', async () => {
      proxy = new CodeMieProxy(
        createMinimalConfig({
          authMethod: 'jwt',
          profileConfig: { codeMieUrl: 'https://codemie.example.com' } as any,
        })
      );

      const result = await (proxy as any).attemptSSOReauth();

      expect(result).toBe(false);
      expect(mockAuthenticate).not.toHaveBeenCalled();
    });
  });
});
