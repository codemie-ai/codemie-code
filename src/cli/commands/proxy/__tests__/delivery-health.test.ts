import { describe, it, expect, vi, beforeEach } from 'vitest';
import stripAnsi from 'strip-ansi';

const {
  getAnalyticsAuthStatus,
  clearAnalyticsAuthStatus,
  getLastSignInAt,
  summarizeSpoolDelivery,
  getStoredAnalyticsCredentials,
  withVerifiedOwner,
  forwarderIdentity,
  getPolicyState,
} = vi.hoisted(() => ({
  getAnalyticsAuthStatus: vi.fn(),
  clearAnalyticsAuthStatus: vi.fn(),
  getLastSignInAt: vi.fn(),
  summarizeSpoolDelivery: vi.fn(),
  getStoredAnalyticsCredentials: vi.fn(),
  withVerifiedOwner: vi.fn(),
  forwarderIdentity: vi.fn(),
  getPolicyState: vi.fn(),
}));

vi.mock('@/utils/analytics-auth-status.js', () => ({
  getAnalyticsAuthStatus,
  clearAnalyticsAuthStatus,
}));
vi.mock('@/providers/plugins/sso/sso.detached-login.js', () => ({
  startDetachedSsoLogin: vi.fn(),
  waitForDetachedSsoLogin: vi.fn(),
  describeLogin: vi.fn(),
  getLastSignInAt,
  SSO_LOGIN_WAIT_MS: 150_000,
}));
vi.mock('@/providers/plugins/sso/proxy/plugins/otlp-spool/delivery-summary.js', () => ({
  summarizeSpoolDelivery,
}));
vi.mock('@/providers/core/codemie-auth-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getStoredAnalyticsCredentials,
}));
vi.mock('@/providers/core/credential-owner.js', () => ({
  withVerifiedOwner,
}));
vi.mock('@/providers/plugins/sso/proxy/plugins/otlp-spool/spool-io.js', () => ({
  forwarderIdentity,
}));
vi.mock('@/providers/plugins/sso/proxy/plugins/otlp-spool/policy-cache.js', () => ({
  getPolicyState,
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  collectDeliveryHealth,
  DELIVERY_REASONS,
  formatDeliveryLines,
  type DeliveryReason,
} from '../delivery-health.js';
import type { DaemonState } from '../daemon-manager.js';

const URL = 'https://codemie.example.com';

const state = {
  pid: 1,
  port: 4001,
  url: 'http://localhost:4001',
  profile: 'default',
  gatewayKey: 'k',
  provider: 'ai-run-sso',
  targetUrl: URL,
  syncApiUrl: `${URL}/code-assistant-api`,
  syncCodeMieUrl: URL,
  startedAt: '2026-01-01T00:00:00.000Z',
} as DaemonState;

const ok = { credentials: 'ok' } as const;
const marker = { detectedAt: 2000, reason: 'redirect', baseUrl: URL };

describe('collectDeliveryHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAnalyticsAuthStatus.mockResolvedValue(null);
    getLastSignInAt.mockResolvedValue(null);
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 0, mismatchHeld: false, sendFailed: false, classificationUnreachable: false });
    getStoredAnalyticsCredentials.mockResolvedValue({ credentials: { apiUrl: URL, email: 'user@example.com' }, url: URL });
    withVerifiedOwner.mockImplementation(async (creds: unknown) => creds);
    forwarderIdentity.mockReturnValue({ api_identity: 'id', owner_hash: 'hash' });
    getPolicyState.mockResolvedValue({ policy: null, capability: 'evidence', usable: false, refreshDue: true });
  });

  it('is healthy when the reply is ok and nothing else applies', async () => {
    expect(await collectDeliveryHealth(state, ok)).toEqual({ status: 'healthy', pendingBytes: 0 });
  });

  it('is unknown, not healthy, when there is no reply', async () => {
    expect(await collectDeliveryHealth(state)).toEqual({ status: 'unknown', pendingBytes: 0 });
  });

  it('reports credentials_expired for a stale reply', async () => {
    expect(await collectDeliveryHealth(state, { credentials: 'stale' })).toEqual({
      status: 'unhealthy',
      reason: 'credentials_expired',
      pendingBytes: 0,
    });
  });

  it('reports auth_rejected for an applicable marker', async () => {
    getAnalyticsAuthStatus.mockResolvedValue(marker);
    const health = await collectDeliveryHealth(state, ok);
    expect(health).toMatchObject({ status: 'unhealthy', reason: 'auth_rejected' });
  });

  it('reports auth_rejected even without a reply', async () => {
    getAnalyticsAuthStatus.mockResolvedValue(marker);
    expect(await collectDeliveryHealth(state)).toMatchObject({ status: 'unhealthy', reason: 'auth_rejected' });
  });

  it('ignores a marker detected before the latest sign-in', async () => {
    getAnalyticsAuthStatus.mockResolvedValue(marker);
    getLastSignInAt.mockResolvedValue(3000);
    expect(await collectDeliveryHealth(state, ok)).toMatchObject({ status: 'healthy' });
  });

  it('keeps a marker detected after the latest sign-in', async () => {
    getAnalyticsAuthStatus.mockResolvedValue(marker);
    getLastSignInAt.mockResolvedValue(1000);
    expect(await collectDeliveryHealth(state, ok)).toMatchObject({ reason: 'auth_rejected' });
  });

  it('ignores a marker recorded for another profile URL', async () => {
    getAnalyticsAuthStatus.mockResolvedValue({ ...marker, baseUrl: 'https://other.example.com' });
    expect(await collectDeliveryHealth(state, ok)).toMatchObject({ status: 'healthy' });
  });

  it('ignores a marker that records no URL, since it cannot be attributed to this profile', async () => {
    getAnalyticsAuthStatus.mockResolvedValue({ detectedAt: 2000, reason: 'redirect' });
    expect(await collectDeliveryHealth(state, ok)).toMatchObject({ status: 'healthy' });
  });

  it('never clears the marker', async () => {
    getAnalyticsAuthStatus.mockResolvedValue(marker);
    getLastSignInAt.mockResolvedValue(3000);
    await collectDeliveryHealth(state, ok);
    expect(clearAnalyticsAuthStatus).not.toHaveBeenCalled();
  });

  it('resolves the sign-in from the daemon record only, not the current process profile', async () => {
    getAnalyticsAuthStatus.mockResolvedValue(marker);
    await collectDeliveryHealth(state, ok);
    expect(getLastSignInAt).toHaveBeenCalledWith({
      provider: 'ai-run-sso',
      baseUrl: URL,
      codeMieUrl: URL,
    });
  });

  it('reports identity_mismatch when a session is held', async () => {
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 10, mismatchHeld: true, sendFailed: false });
    expect(await collectDeliveryHealth(state, ok)).toEqual({
      status: 'unhealthy',
      reason: 'identity_mismatch',
      pendingBytes: 10,
    });
  });

  it('reports send_failed for a live delivery failure', async () => {
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 5, mismatchHeld: false, sendFailed: true });
    expect(await collectDeliveryHealth(state, ok)).toEqual({
      status: 'unhealthy',
      reason: 'send_failed',
      pendingBytes: 5,
    });
  });

  it('applies the precedence stale > marker > mismatch > send failed', async () => {
    getAnalyticsAuthStatus.mockResolvedValue(marker);
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 1, mismatchHeld: true, sendFailed: true });
    expect((await collectDeliveryHealth(state, { credentials: 'stale' })).reason).toBe('credentials_expired');
    expect((await collectDeliveryHealth(state, ok)).reason).toBe('auth_rejected');
    getAnalyticsAuthStatus.mockResolvedValue(null);
    expect((await collectDeliveryHealth(state, ok)).reason).toBe('identity_mismatch');
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 1, mismatchHeld: false, sendFailed: true });
    expect((await collectDeliveryHealth(state, ok)).reason).toBe('send_failed');
  });

  it('carries pending bytes on a healthy result', async () => {
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 42, mismatchHeld: false, sendFailed: false });
    expect(await collectDeliveryHealth(state, ok)).toEqual({ status: 'healthy', pendingBytes: 42 });
  });

  it('yields unknown when a dependency throws', async () => {
    summarizeSpoolDelivery.mockRejectedValue(new Error('boom'));
    expect(await collectDeliveryHealth(state, ok)).toEqual({ status: 'unknown', pendingBytes: 0 });
  });

  it('yields unknown when the marker read throws', async () => {
    getAnalyticsAuthStatus.mockRejectedValue(new Error('boom'));
    expect(await collectDeliveryHealth(state, ok)).toEqual({ status: 'unknown', pendingBytes: 0 });
  });

  it('reports classification_unreachable when the spool flags it and capability is unknown', async () => {
    getPolicyState.mockResolvedValue({ policy: null, capability: 'unknown', usable: false, refreshDue: true });
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 7, mismatchHeld: false, sendFailed: false, classificationUnreachable: true });
    expect(await collectDeliveryHealth(state, ok)).toEqual({
      status: 'unhealthy',
      reason: 'classification_unreachable',
      pendingBytes: 7,
    });
    expect(summarizeSpoolDelivery).toHaveBeenCalledWith('unknown');
  });

  it('threads the resolved capability into summarizeSpoolDelivery', async () => {
    getPolicyState.mockResolvedValue({ policy: null, capability: 'evidence', usable: false, refreshDue: true });
    summarizeSpoolDelivery.mockImplementation(async (capability: string) => ({
      pendingBytes: 0,
      mismatchHeld: false,
      sendFailed: false,
      classificationUnreachable: capability !== 'evidence',
    }));
    const health = await collectDeliveryHealth(state, ok);
    expect(summarizeSpoolDelivery).toHaveBeenCalledWith('evidence');
    expect(health).toMatchObject({ status: 'healthy' });
  });

  it('resolves identity from the owner-verified credential, not the raw stored one', async () => {
    const stored = { apiUrl: URL, cookies: {} };
    const verified = { apiUrl: URL, cookies: {}, email: 'owner@example.com' };
    getStoredAnalyticsCredentials.mockResolvedValue({ credentials: stored, url: URL });
    withVerifiedOwner.mockResolvedValue(verified);
    getPolicyState.mockResolvedValue({ policy: null, capability: 'unknown', usable: false, refreshDue: true });
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 3, mismatchHeld: false, sendFailed: false, classificationUnreachable: true });

    const health = await collectDeliveryHealth(state, ok);

    expect(withVerifiedOwner).toHaveBeenCalledWith(stored);
    expect(forwarderIdentity).toHaveBeenCalledWith(verified);
    expect(health).toMatchObject({ status: 'unhealthy', reason: 'classification_unreachable' });
  });

  it('never reports classification_unreachable when the identity cannot be resolved (AC3)', async () => {
    forwarderIdentity.mockReturnValue(null);
    // Mirrors the real spool's own capability check (capability === 'unknown'), so this only passes if 'evidence' was threaded through.
    summarizeSpoolDelivery.mockImplementation(async (capability: string) => ({
      pendingBytes: 7,
      mismatchHeld: false,
      sendFailed: false,
      classificationUnreachable: capability === 'unknown',
    }));
    const health = await collectDeliveryHealth(state, ok);
    expect(health.reason).not.toBe('classification_unreachable');
    expect(summarizeSpoolDelivery).toHaveBeenCalledWith('evidence');
    expect(getPolicyState).not.toHaveBeenCalled();
  });

  it('keeps send_failed ahead of classification_unreachable in precedence', async () => {
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 1, mismatchHeld: false, sendFailed: true, classificationUnreachable: true });
    expect((await collectDeliveryHealth(state, ok)).reason).toBe('send_failed');
  });

  it('still resolves normally when there is no stored analytics credential', async () => {
    getStoredAnalyticsCredentials.mockResolvedValue(null);
    expect(await collectDeliveryHealth(state, ok)).toEqual({ status: 'healthy', pendingBytes: 0 });
    expect(summarizeSpoolDelivery).toHaveBeenCalledWith('evidence');
  });

  it('falls back to evidence, instead of going unknown, when the credential lookup throws', async () => {
    getStoredAnalyticsCredentials.mockRejectedValue(new Error('boom'));
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 10, mismatchHeld: true, sendFailed: false, classificationUnreachable: false });
    expect(await collectDeliveryHealth(state, ok)).toEqual({
      status: 'unhealthy',
      reason: 'identity_mismatch',
      pendingBytes: 10,
    });
    expect(summarizeSpoolDelivery).toHaveBeenCalledWith('evidence');
  });
});

describe('DELIVERY_REASONS', () => {
  it('labels every reason and gives a remedy to all but send_failed and classification_unreachable', () => {
    const codes: DeliveryReason[] = [
      'credentials_expired',
      'auth_rejected',
      'identity_mismatch',
      'send_failed',
      'classification_unreachable',
    ];
    expect(Object.keys(DELIVERY_REASONS).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      expect(DELIVERY_REASONS[code].label.length).toBeGreaterThan(0);
    }
    expect(DELIVERY_REASONS.credentials_expired.run).toBe('codemie profile login');
    expect(DELIVERY_REASONS.auth_rejected.run).toBe('codemie profile login');
    expect(DELIVERY_REASONS.identity_mismatch.run).toBe('codemie proxy restart');
    expect(DELIVERY_REASONS.send_failed.run).toBeUndefined();
    expect(DELIVERY_REASONS.classification_unreachable.run).toBeUndefined();
  });
});

describe('formatDeliveryLines', () => {
  const strip = (lines: string[]): string[] => lines.map((l) => stripAnsi(l));

  it('prints a healthy headline only', () => {
    expect(strip(formatDeliveryLines({ status: 'healthy', pendingBytes: 0 }))).toEqual(['Delivery: healthy']);
  });

  it('prints pending bytes when there are any', () => {
    expect(strip(formatDeliveryLines({ status: 'healthy', pendingBytes: 2048 }))).toEqual([
      'Delivery: healthy',
      '  Pending: 2.00 KB (all sessions on this machine)',
    ]);
  });

  it('prints the label, pending and remedy for an unhealthy reason', () => {
    const lines = strip(
      formatDeliveryLines({ status: 'unhealthy', reason: 'credentials_expired', pendingBytes: 512 })
    );
    expect(lines).toEqual([
      `Delivery: unhealthy (${DELIVERY_REASONS.credentials_expired.label})`,
      '  Pending: 512 B (all sessions on this machine)',
      '  Run: codemie profile login',
    ]);
  });

  it('prints no Run line for send_failed', () => {
    const lines = strip(formatDeliveryLines({ status: 'unhealthy', reason: 'send_failed', pendingBytes: 0 }));
    expect(lines).toEqual([`Delivery: unhealthy (${DELIVERY_REASONS.send_failed.label})`]);
  });

  it('prints no Run line for unknown', () => {
    expect(strip(formatDeliveryLines({ status: 'unknown', pendingBytes: 0 }))).toEqual([
      'Delivery: unknown (restart the proxy to enable all checks)',
    ]);
  });

  it('says the spool-derived reasons cover the whole machine', () => {
    expect(DELIVERY_REASONS.identity_mismatch.label).toContain('on this machine');
    expect(DELIVERY_REASONS.send_failed.label).toContain('on this machine');
    expect(DELIVERY_REASONS.classification_unreachable.label).toContain('on this machine');
  });

  it('reports a stopped proxy for null', () => {
    expect(strip(formatDeliveryLines(null))).toEqual(['Delivery: proxy not running']);
  });
});
