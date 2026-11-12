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
vi.mock('@/providers/plugins/sso/proxy/plugins/otlp-spool/policy-cache.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 0, mismatchHeld: false, sendFailed: false, classificationStalled: false });
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

  it('reports classification_unreachable when the spool is stalled and capability is unknown', async () => {
    getPolicyState.mockResolvedValue({ policy: null, capability: 'unknown', usable: false, refreshDue: true });
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 7, mismatchHeld: false, sendFailed: false, classificationStalled: true });
    expect(await collectDeliveryHealth(state, ok)).toEqual({
      status: 'unhealthy',
      reason: 'classification_unreachable',
      pendingBytes: 7,
    });
  });

  it('reports classification_unsupported when the spool is stalled and capability is legacy', async () => {
    getPolicyState.mockResolvedValue({ policy: null, capability: 'legacy', usable: false, refreshDue: true });
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 9, mismatchHeld: false, sendFailed: false, classificationStalled: true });
    expect(await collectDeliveryHealth(state, ok)).toEqual({
      status: 'unhealthy',
      reason: 'classification_unsupported',
      pendingBytes: 9,
    });
  });

  it('reports classification_unsupported when capability is evidence but the policy does not advertise the publication contract', async () => {
    getPolicyState.mockResolvedValue({ policy: null, capability: 'evidence', usable: false, refreshDue: true });
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 11, mismatchHeld: false, sendFailed: false, classificationStalled: true });
    expect(await collectDeliveryHealth(state, ok)).toEqual({
      status: 'unhealthy',
      reason: 'classification_unsupported',
      pendingBytes: 11,
    });
  });

  it('stays healthy when capability is evidence and the policy already advertises the publication contract, even if stalled', async () => {
    getPolicyState.mockResolvedValue({
      policy: null,
      capability: 'evidence',
      usable: false,
      refreshDue: true,
      publicationContracts: ['1'],
    });
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 0, mismatchHeld: false, sendFailed: false, classificationStalled: true });
    const health = await collectDeliveryHealth(state, ok);
    expect(health).toMatchObject({ status: 'healthy' });
  });

  it('resolves identity from the owner-verified credential, not the raw stored one', async () => {
    const stored = { apiUrl: URL, cookies: {} };
    const verified = { apiUrl: URL, cookies: {}, email: 'owner@example.com' };
    getStoredAnalyticsCredentials.mockResolvedValue({ credentials: stored, url: URL });
    withVerifiedOwner.mockResolvedValue(verified);
    getPolicyState.mockResolvedValue({ policy: null, capability: 'unknown', usable: false, refreshDue: true });
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 3, mismatchHeld: false, sendFailed: false, classificationStalled: true });

    const health = await collectDeliveryHealth(state, ok);

    expect(withVerifiedOwner).toHaveBeenCalledWith(stored);
    expect(forwarderIdentity).toHaveBeenCalledWith(verified);
    expect(health).toMatchObject({ status: 'unhealthy', reason: 'classification_unreachable' });
  });

  it('never reports classification_unreachable when the identity cannot be resolved (AC3)', async () => {
    forwarderIdentity.mockReturnValue(null);
    // A stalled session alone is not enough: the policy state must fall back to null when identity fails.
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 7, mismatchHeld: false, sendFailed: false, classificationStalled: true });
    const health = await collectDeliveryHealth(state, ok);
    expect(health.reason).not.toBe('classification_unreachable');
    expect(health.reason).not.toBe('classification_unsupported');
    expect(getPolicyState).not.toHaveBeenCalled();
  });

  it('keeps send_failed ahead of classification_unreachable in precedence', async () => {
    getPolicyState.mockResolvedValue({ policy: null, capability: 'unknown', usable: false, refreshDue: true });
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 1, mismatchHeld: false, sendFailed: true, classificationStalled: true });
    expect((await collectDeliveryHealth(state, ok)).reason).toBe('send_failed');
  });

  it('starts the spool scan without waiting for capability resolution to finish', async () => {
    let resolveCreds!: (v: unknown) => void;
    getStoredAnalyticsCredentials.mockImplementation(
      () => new Promise((resolve) => { resolveCreds = resolve; })
    );
    const pending = collectDeliveryHealth(state, ok);
    await Promise.resolve(); // flush the microtask queue so Promise.all's synchronous starts run
    expect(summarizeSpoolDelivery).toHaveBeenCalledTimes(1);
    resolveCreds(null);
    await pending;
  });

  it('still resolves normally when there is no stored analytics credential', async () => {
    getStoredAnalyticsCredentials.mockResolvedValue(null);
    expect(await collectDeliveryHealth(state, ok)).toEqual({ status: 'healthy', pendingBytes: 0 });
  });

  it('falls back to an unresolved policy state, instead of going unknown, when the credential lookup throws', async () => {
    getStoredAnalyticsCredentials.mockRejectedValue(new Error('boom'));
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 10, mismatchHeld: true, sendFailed: false, classificationStalled: false });
    expect(await collectDeliveryHealth(state, ok)).toEqual({
      status: 'unhealthy',
      reason: 'identity_mismatch',
      pendingBytes: 10,
    });
  });
});

describe('DELIVERY_REASONS', () => {
  it('labels every reason and gives a remedy to all but send_failed, classification_unreachable and classification_unsupported', () => {
    const codes: DeliveryReason[] = [
      'credentials_expired',
      'auth_rejected',
      'identity_mismatch',
      'send_failed',
      'classification_unreachable',
      'classification_unsupported',
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
    expect(DELIVERY_REASONS.classification_unsupported.run).toBeUndefined();
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

  it('prints no Run line for classification_unsupported', () => {
    const lines = strip(formatDeliveryLines({ status: 'unhealthy', reason: 'classification_unsupported', pendingBytes: 0 }));
    expect(lines).toEqual([`Delivery: unhealthy (${DELIVERY_REASONS.classification_unsupported.label})`]);
  });

  it('prints no Run line for unknown', () => {
    expect(strip(formatDeliveryLines({ status: 'unknown', pendingBytes: 0 }))).toEqual([
      'Delivery: unknown (restart the proxy to enable all checks)',
    ]);
  });

  it('says the spool-derived reasons cover the whole machine', () => {
    expect(DELIVERY_REASONS.identity_mismatch.label).toContain('on this machine');
    expect(DELIVERY_REASONS.send_failed.label).toContain('on this machine');
  });

  it('writes classification_unreachable/classification_unsupported for a non-technical reader', () => {
    expect(DELIVERY_REASONS.classification_unreachable.label).toBe('waiting for the CodeMie server to respond');
    expect(DELIVERY_REASONS.classification_unsupported.label).toBe(
      "the CodeMie server isn't set up to accept this data yet — contact your CodeMie administrator"
    );
  });

  it('reports a stopped proxy for null', () => {
    expect(strip(formatDeliveryLines(null))).toEqual(['Delivery: proxy not running']);
  });
});
