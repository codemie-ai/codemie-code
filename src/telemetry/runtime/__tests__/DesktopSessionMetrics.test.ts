/**
 * DesktopSessionMetrics credential loading: SSO cookies, else the JWT a cookie-stripping reverse
 * proxy left the browser callback to store instead.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRetrieveSSOCredentials, mockRetrieveJWTCredentials, mockMarkedInvalid } = vi.hoisted(() => ({
  mockRetrieveSSOCredentials: vi.fn(),
  mockRetrieveJWTCredentials: vi.fn(),
  mockMarkedInvalid: vi.fn(async () => false),
}));

vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/agents/core/session/stale-session-reconciliation.js', () => ({
  analyticsAuthMarkedInvalid: mockMarkedInvalid,
}));
vi.mock('@/providers/plugins/sso/index.js', () => ({ MetricsSender: vi.fn() }));
// The resolver reads both credential slots for the URL (global slot when the URL has none)
vi.mock('@/utils/security.js', () => ({
  CredentialStore: {
    getInstance: () => ({
      retrieveSSOCredentials: mockRetrieveSSOCredentials,
      retrieveJWTCredentials: mockRetrieveJWTCredentials,
      clearSSOCredentials: vi.fn(),
      clearJWTCredentials: vi.fn(),
    }),
  },
}));

const { DesktopSessionMetrics } = await import('../DesktopSessionMetrics.js');

const URL_ = 'https://codemie.example.com';
const session = { sessionId: 's-1', correlation: {} } as never;

function metrics(): InstanceType<typeof DesktopSessionMetrics> {
  return new DesktopSessionMetrics(
    { targetApiUrl: URL_, syncCodeMieUrl: URL_, clientType: 'codemie-desktop', version: '1.0.0' } as never,
    {} as never
  );
}

describe('DesktopSessionMetrics credentials', () => {
  beforeEach(() => {
    mockRetrieveSSOCredentials.mockReset();
    mockRetrieveJWTCredentials.mockReset();
    mockMarkedInvalid.mockReset();
    mockMarkedInvalid.mockResolvedValue(false);
  });

  it('uses the stored SSO cookies over a legacy JWT stored for the same host', async () => {
    mockRetrieveSSOCredentials.mockResolvedValue({ cookies: { s: '1' }, apiUrl: URL_ });
    mockRetrieveJWTCredentials.mockResolvedValue({ token: 'jwt-tok', apiUrl: URL_ });

    const context = await metrics().buildProcessingContext(session);

    expect(context).toMatchObject({ cookies: 's=1' });
    expect(context.jwtToken).toBeUndefined();
  });

  it('falls back to the JWT stored for its CodeMie host when no SSO session exists', async () => {
    mockRetrieveSSOCredentials.mockResolvedValue(null);
    mockRetrieveJWTCredentials.mockResolvedValue({ token: 'jwt-tok', apiUrl: URL_ });

    const context = await metrics().buildProcessingContext(session);

    expect(mockRetrieveJWTCredentials).toHaveBeenCalledWith(URL_, { includeExpired: true });
    expect(context).toMatchObject({ cookies: '', jwtToken: 'jwt-tok' });
  });

  it('falls back to the JWT when the SSO record has no usable cookies', async () => {
    mockRetrieveSSOCredentials.mockResolvedValue({ cookies: {}, apiUrl: URL_ });
    mockRetrieveJWTCredentials.mockResolvedValue({ token: 'jwt-tok', apiUrl: URL_ });

    const context = await metrics().buildProcessingContext(session);

    expect(context).toMatchObject({ cookies: '', jwtToken: 'jwt-tok' });
  });

  it('cannot deliver with an SSO record of unusable cookies and no JWT', async () => {
    mockRetrieveSSOCredentials.mockResolvedValue({ cookies: {}, apiUrl: URL_ });
    mockRetrieveJWTCredentials.mockResolvedValue(null);

    await expect(metrics().canDeliver()).resolves.toBe(false);
  });

  it('can deliver with only a stored JWT', async () => {
    mockRetrieveSSOCredentials.mockResolvedValue(null);
    mockRetrieveJWTCredentials.mockResolvedValue({ token: 'jwt-tok', apiUrl: URL_ });

    await expect(metrics().canDeliver()).resolves.toBe(true);
  });

  it('cannot deliver with neither cookies nor a JWT', async () => {
    mockRetrieveSSOCredentials.mockResolvedValue(null);
    mockRetrieveJWTCredentials.mockResolvedValue(null);

    await expect(metrics().canDeliver()).resolves.toBe(false);
  });

  it('cannot deliver while the analytics auth is marked invalid, without reading the store', async () => {
    mockMarkedInvalid.mockResolvedValue(true);

    await expect(metrics().canDeliver()).resolves.toBe(false);
    expect(mockRetrieveSSOCredentials).not.toHaveBeenCalled();
    expect(mockRetrieveJWTCredentials).not.toHaveBeenCalled();
  });
});
