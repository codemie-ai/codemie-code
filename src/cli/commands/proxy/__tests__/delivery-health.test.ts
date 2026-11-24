import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  type DeliveryReason,
} from '../delivery-health.js';
import type { DaemonState } from '../daemon-manager.js';
import { ORG_ENCODING_V1 } from '@/agents/core/evidence/org-encoding.js';
import { createStatus } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/session-status.js';
import { spoolRoot, statusFile, streamFile } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/spool-paths.js';

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
const FAILURE = { nextAt: Date.parse('2026-11-13T14:32:10.000Z'), detail: 'http_503' };
const marker = { detectedAt: 2000, reason: 'redirect', baseUrl: URL };

describe('collectDeliveryHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAnalyticsAuthStatus.mockResolvedValue(null);
    getLastSignInAt.mockResolvedValue(null);
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 0, mismatchHeld: false, classificationStalled: false });
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
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 10, mismatchHeld: true });
    expect(await collectDeliveryHealth(state, ok)).toEqual({
      status: 'unhealthy',
      reason: 'identity_mismatch',
      pendingBytes: 10,
    });
  });

  it('reports send_failed with the failure when the spool has a live delivery failure', async () => {
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 5, mismatchHeld: false, sendFailure: FAILURE });
    expect(await collectDeliveryHealth(state, ok)).toEqual({
      status: 'unhealthy',
      reason: 'send_failed',
      pendingBytes: 5,
      sendFailure: FAILURE,
    });
  });

  it('carries the failure only when send_failed is the reason', async () => {
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 5, mismatchHeld: false, sendFailure: FAILURE });
    expect(await collectDeliveryHealth(state, { credentials: 'stale' })).not.toHaveProperty('sendFailure');
  });

  it('applies the precedence stale > marker > mismatch > send failed', async () => {
    getAnalyticsAuthStatus.mockResolvedValue(marker);
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 1, mismatchHeld: true, sendFailure: FAILURE });
    expect((await collectDeliveryHealth(state, { credentials: 'stale' })).reason).toBe('credentials_expired');
    expect((await collectDeliveryHealth(state, ok)).reason).toBe('auth_rejected');
    getAnalyticsAuthStatus.mockResolvedValue(null);
    expect((await collectDeliveryHealth(state, ok)).reason).toBe('identity_mismatch');
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 1, mismatchHeld: false, sendFailure: FAILURE });
    expect((await collectDeliveryHealth(state, ok)).reason).toBe('send_failed');
  });

  describe('a session that is held as a whole and no longer retried', () => {
    let home: string;
    let prevHome: string | undefined;

    beforeEach(async () => {
      prevHome = process.env.CODEMIE_HOME;
      home = await mkdtemp(join(tmpdir(), 'delivery-health-held-'));
      process.env.CODEMIE_HOME = home;
      await mkdir(spoolRoot(), { recursive: true });
      // The real spool summary, read from the files below, instead of the canned one of the other tests.
      const real = await vi.importActual<typeof import('@/providers/plugins/sso/proxy/plugins/otlp-spool/delivery-summary.js')>(
        '@/providers/plugins/sso/proxy/plugins/otlp-spool/delivery-summary.js'
      );
      summarizeSpoolDelivery.mockImplementation(real.summarizeSpoolDelivery);
    });

    afterEach(async () => {
      if (prevHome === undefined) delete process.env.CODEMIE_HOME;
      else process.env.CODEMIE_HOME = prevHome;
      await rm(home, { recursive: true, force: true });
    });

    /** A session with 4 KiB unsent whose send failed 16 hours ago and which is held since. */
    async function heldSessionWithOldFailure(): Promise<void> {
      const id = '6267af33-6ee3-46ae-b6e5-59c1a556ac92';
      const failedAt = Date.now() - 16 * 3_600_000;
      await writeFile(streamFile(id, 'hooks'), 'x'.repeat(4096));
      const status = createStatus();
      status.holds = { session: { reason: 'publication_stopped', since: failedAt + 60_000 } };
      status.delivery = {
        hooks: { reason: 'delivery_failed', detail: 'request_error', since: failedAt, cursor: 0, end: 4096, attempts: 1, nextAt: failedAt + 120_000 },
      };
      await writeFile(statusFile(id), JSON.stringify(status));
    }

    it('is not send_failed and records no send failure, while its bytes stay unsent', async () => {
      await heldSessionWithOldFailure();

      const health = await collectDeliveryHealth(state, ok);

      expect(health).toEqual({ status: 'healthy', pendingBytes: 4096, heldBytes: 4096 });
    });

    it('does not hide a failing send of another session', async () => {
      await heldSessionWithOldFailure();
      const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      await writeFile(streamFile(id, 'hooks'), 'y'.repeat(100));
      const status = createStatus();
      const nextAt = Date.now() + 60_000;
      status.delivery = { hooks: { reason: 'delivery_failed', detail: 'http_503', since: Date.now(), cursor: 0, end: 100, attempts: 1, nextAt } };
      await writeFile(statusFile(id), JSON.stringify(status));

      const health = await collectDeliveryHealth(state, ok);

      expect(health).toMatchObject({ status: 'unhealthy', reason: 'send_failed', pendingBytes: 4096 + 100, heldBytes: 4096, sendFailure: { nextAt, detail: 'http_503' } });
    });
  });

  it('carries pending bytes on a healthy result', async () => {
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 42, mismatchHeld: false });
    expect(await collectDeliveryHealth(state, ok)).toEqual({ status: 'healthy', pendingBytes: 42 });
  });

  it('carries the latest drop on a healthy result', async () => {
    const latestDrop = { reason: 'no_project', stream: 'hooks', at: 5000, local: false };
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 0, mismatchHeld: false, latestDrop });
    expect(await collectDeliveryHealth(state, ok)).toEqual({ status: 'healthy', pendingBytes: 0, latestDrop });
  });

  it('carries the latest drop on an unhealthy result', async () => {
    const latestDrop = { reason: 'disk_full', at: 6000, local: true };
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 7, mismatchHeld: false, sendFailure: FAILURE, latestDrop });
    expect(await collectDeliveryHealth(state, ok)).toEqual({
      status: 'unhealthy',
      reason: 'send_failed',
      pendingBytes: 7,
      sendFailure: FAILURE,
      latestDrop,
    });
  });

  it('yields unknown, with no unsent amount, when a dependency throws', async () => {
    summarizeSpoolDelivery.mockRejectedValue(new Error('boom'));
    expect(await collectDeliveryHealth(state, ok)).toEqual({ status: 'unknown' });
  });

  it('yields unknown, with no unsent amount, when the marker read throws', async () => {
    getAnalyticsAuthStatus.mockRejectedValue(new Error('boom'));
    expect(await collectDeliveryHealth(state, ok)).toEqual({ status: 'unknown' });
  });

  it('is unknown, not healthy, with no unsent amount, when the spool could not be read completely', async () => {
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 0, mismatchHeld: false, incomplete: true });
    expect(await collectDeliveryHealth(state, ok)).toEqual({ status: 'unknown', incomplete: true });
  });

  it('keeps the latest drop on an unknown result for an unreadable spool', async () => {
    const latestDrop = { reason: 'no_project', stream: 'hooks', at: 5000, local: true };
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 0, mismatchHeld: false, incomplete: true, latestDrop });
    expect(await collectDeliveryHealth(state, ok)).toEqual({ status: 'unknown', incomplete: true, latestDrop });
  });

  it('leaves the unsent amount out of an unhealthy result when the spool could not be read completely', async () => {
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 5, mismatchHeld: false, incomplete: true });
    expect(await collectDeliveryHealth(state, { credentials: 'stale' })).toEqual({
      status: 'unhealthy',
      reason: 'credentials_expired',
    });
  });

  it('reports classification_unreachable when the spool is stalled and capability is unknown', async () => {
    getPolicyState.mockResolvedValue({ policy: null, capability: 'unknown', usable: false, refreshDue: true });
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 7, mismatchHeld: false, classificationStalled: true });
    expect(await collectDeliveryHealth(state, ok)).toEqual({
      status: 'unhealthy',
      reason: 'classification_unreachable',
      pendingBytes: 7,
    });
  });

  it('reports classification_unsupported when the spool is stalled and capability is legacy', async () => {
    getPolicyState.mockResolvedValue({ policy: null, capability: 'legacy', usable: false, refreshDue: true });
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 9, mismatchHeld: false, classificationStalled: true });
    expect(await collectDeliveryHealth(state, ok)).toEqual({
      status: 'unhealthy',
      reason: 'classification_unsupported',
      pendingBytes: 9,
    });
  });

  it('reports classification_unsupported when capability is evidence but the policy does not advertise the publication contract', async () => {
    getPolicyState.mockResolvedValue({ policy: null, capability: 'evidence', usable: false, refreshDue: true });
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 11, mismatchHeld: false, classificationStalled: true });
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
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 0, mismatchHeld: false, classificationStalled: true });
    const health = await collectDeliveryHealth(state, ok);
    expect(health).toMatchObject({ status: 'healthy' });
  });

  describe('organization-encoding stall', () => {
    const stalledOnEncoding = { pendingBytes: 13, mismatchHeld: false, classificationStalled: true, organizationEncodingStalled: true };

    it('reports classification_unsupported when the backend advertises the contract but not the organization encoding', async () => {
      getPolicyState.mockResolvedValue({
        policy: {},
        capability: 'evidence',
        usable: true,
        refreshDue: false,
        publicationContracts: ['1'],
      });
      summarizeSpoolDelivery.mockResolvedValue(stalledOnEncoding);
      expect(await collectDeliveryHealth(state, ok)).toEqual({
        status: 'unhealthy',
        reason: 'classification_unsupported',
        pendingBytes: 13,
      });
    });

    it('reports classification_unsupported when the cached policy has expired and its last answer lacked the organization encoding', async () => {
      getPolicyState.mockResolvedValue({
        policy: null,
        capability: 'evidence',
        usable: false,
        refreshDue: true,
        publicationContracts: ['1'],
      });
      summarizeSpoolDelivery.mockResolvedValue(stalledOnEncoding);
      expect(await collectDeliveryHealth(state, ok)).toMatchObject({ status: 'unhealthy', reason: 'classification_unsupported' });
    });

    it('stays quiet when the cached policy has expired but its last answer advertised the organization encoding (an outage, not a missing encoding)', async () => {
      getPolicyState.mockResolvedValue({
        policy: null,
        capability: 'evidence',
        usable: false,
        refreshDue: true,
        publicationContracts: ['1'],
        organizationEncodings: [ORG_ENCODING_V1],
      });
      summarizeSpoolDelivery.mockResolvedValue(stalledOnEncoding);
      expect(await collectDeliveryHealth(state, ok)).toMatchObject({ status: 'healthy' });
    });

    it('stays healthy when the policy already advertises the organization encoding (the hold is stale and clears on the next tick)', async () => {
      getPolicyState.mockResolvedValue({
        policy: {},
        capability: 'evidence',
        usable: true,
        refreshDue: false,
        publicationContracts: ['1'],
        organizationEncodings: [ORG_ENCODING_V1],
      });
      summarizeSpoolDelivery.mockResolvedValue(stalledOnEncoding);
      expect(await collectDeliveryHealth(state, ok)).toMatchObject({ status: 'healthy' });
    });

    it('stays quiet when the identity cannot be resolved, so no policy is read (AC3)', async () => {
      forwarderIdentity.mockReturnValue(null);
      summarizeSpoolDelivery.mockResolvedValue(stalledOnEncoding);
      const health = await collectDeliveryHealth(state, ok);
      expect(health.reason).toBeUndefined();
      expect(getPolicyState).not.toHaveBeenCalled();
    });

    it('keeps send_failed ahead of the organization-encoding stall in precedence', async () => {
      getPolicyState.mockResolvedValue({ policy: {}, capability: 'evidence', usable: true, refreshDue: false });
      summarizeSpoolDelivery.mockResolvedValue({ ...stalledOnEncoding, sendFailure: { nextAt: 2000 } });
      expect((await collectDeliveryHealth(state, ok)).reason).toBe('send_failed');
    });
  });

  it('resolves identity from the owner-verified credential, not the raw stored one', async () => {
    const stored = { apiUrl: URL, cookies: {} };
    const verified = { apiUrl: URL, cookies: {}, email: 'owner@example.com' };
    getStoredAnalyticsCredentials.mockResolvedValue({ credentials: stored, url: URL });
    withVerifiedOwner.mockResolvedValue(verified);
    getPolicyState.mockResolvedValue({ policy: null, capability: 'unknown', usable: false, refreshDue: true });
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 3, mismatchHeld: false, classificationStalled: true });

    const health = await collectDeliveryHealth(state, ok);

    expect(withVerifiedOwner).toHaveBeenCalledWith(stored);
    expect(forwarderIdentity).toHaveBeenCalledWith(verified);
    expect(health).toMatchObject({ status: 'unhealthy', reason: 'classification_unreachable' });
  });

  it('never reports classification_unreachable when the identity cannot be resolved (AC3)', async () => {
    forwarderIdentity.mockReturnValue(null);
    // A stalled session alone is not enough: the policy state must fall back to null when identity fails.
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 7, mismatchHeld: false, classificationStalled: true });
    const health = await collectDeliveryHealth(state, ok);
    expect(health.reason).not.toBe('classification_unreachable');
    expect(health.reason).not.toBe('classification_unsupported');
    expect(getPolicyState).not.toHaveBeenCalled();
  });

  it('keeps send_failed ahead of classification_unreachable in precedence', async () => {
    getPolicyState.mockResolvedValue({ policy: null, capability: 'unknown', usable: false, refreshDue: true });
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 1, mismatchHeld: false, sendFailure: { nextAt: 2000 }, classificationStalled: true });
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
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 10, mismatchHeld: true, classificationStalled: false });
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
    expect(DELIVERY_REASONS.credentials_expired.command).toBe('codemie profile login');
    expect(DELIVERY_REASONS.auth_rejected.command).toBe('codemie profile login');
    expect(DELIVERY_REASONS.identity_mismatch.command).toBe('codemie proxy restart');
    expect(DELIVERY_REASONS.send_failed.command).toBeUndefined();
    expect(DELIVERY_REASONS.classification_unreachable.command).toBeUndefined();
    expect(DELIVERY_REASONS.classification_unsupported.command).toBeUndefined();
  });
});
