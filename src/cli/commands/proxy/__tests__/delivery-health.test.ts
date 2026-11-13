import { describe, it, expect, vi, beforeEach } from 'vitest';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';

const { getAnalyticsAuthStatus, clearAnalyticsAuthStatus, getLastSignInAt, summarizeSpoolDelivery } = vi.hoisted(
  () => ({
    getAnalyticsAuthStatus: vi.fn(),
    clearAnalyticsAuthStatus: vi.fn(),
    getLastSignInAt: vi.fn(),
    summarizeSpoolDelivery: vi.fn(),
  })
);

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
const FAILURE = { nextAt: Date.parse('2026-11-13T14:32:10.000Z'), detail: 'http_503' };
const marker = { detectedAt: 2000, reason: 'redirect', baseUrl: URL };

describe('collectDeliveryHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAnalyticsAuthStatus.mockResolvedValue(null);
    getLastSignInAt.mockResolvedValue(null);
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 0, mismatchHeld: false });
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

  it('leaves the unsent amount out when the spool could not be read completely', async () => {
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 0, mismatchHeld: false, incomplete: true });
    expect(await collectDeliveryHealth(state, ok)).toEqual({ status: 'healthy' });
  });

  it('leaves the unsent amount out of an unhealthy result when the spool could not be read completely', async () => {
    summarizeSpoolDelivery.mockResolvedValue({ pendingBytes: 5, mismatchHeld: false, incomplete: true });
    expect(await collectDeliveryHealth(state, { credentials: 'stale' })).toEqual({
      status: 'unhealthy',
      reason: 'credentials_expired',
    });
  });
});

describe('DELIVERY_REASONS', () => {
  it('labels every reason and gives a remedy to all but send_failed', () => {
    const codes: DeliveryReason[] = ['credentials_expired', 'auth_rejected', 'identity_mismatch', 'send_failed'];
    expect(Object.keys(DELIVERY_REASONS).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      expect(DELIVERY_REASONS[code].label.length).toBeGreaterThan(0);
    }
    expect(DELIVERY_REASONS.credentials_expired.run).toBe('codemie profile login');
    expect(DELIVERY_REASONS.auth_rejected.run).toBe('codemie profile login');
    expect(DELIVERY_REASONS.identity_mismatch.run).toBe('codemie proxy restart');
    expect(DELIVERY_REASONS.send_failed.run).toBeUndefined();
  });
});

describe('formatDeliveryLines', () => {
  const strip = (lines: string[]): string[] => lines.map((l) => stripAnsi(l));
  const NEXT_RETRY = '2026-11-13T14:32:10.000Z';

  it('prints healthy with no unsent data as plain rows flush left, with no heading', () => {
    const lines = formatDeliveryLines({ status: 'healthy', pendingBytes: 0 });

    expect(strip(lines)).toEqual(['Delivery: healthy', 'Unsent data: none']);
  });

  it('prints unsent data as unknown, never none, when the amount could not be read', () => {
    expect(strip(formatDeliveryLines({ status: 'unknown' }))).toEqual([
      'Delivery: unknown (restart the proxy to enable all checks)',
      'Unsent data: unknown',
    ]);
  });

  it('prints unsent data across all sessions as its own row', () => {
    expect(strip(formatDeliveryLines({ status: 'healthy', pendingBytes: 2048 }))).toEqual([
      'Delivery: healthy',
      'Unsent data: 2.00 KB (all sessions on this machine)',
    ]);
  });

  it('prints the label with the remedy as a hint when the user can act', () => {
    const lines = strip(
      formatDeliveryLines({ status: 'unhealthy', reason: 'credentials_expired', pendingBytes: 512 })
    );
    expect(lines).toEqual([
      `Delivery: unhealthy (${DELIVERY_REASONS.credentials_expired.label})`,
      '    Run: codemie profile login',
      'Unsent data: 512 B (all sessions on this machine)',
    ]);
  });

  it('prints the next retry and the error code of a failing delivery, with no Run line', () => {
    const lines = strip(
      formatDeliveryLines({
        status: 'unhealthy',
        reason: 'send_failed',
        pendingBytes: 49_357,
        sendFailure: { nextAt: Date.parse(NEXT_RETRY), detail: 'http_503' },
      })
    );
    expect(lines).toEqual([
      `Delivery: unhealthy (${DELIVERY_REASONS.send_failed.label})`,
      'Unsent data: 48.20 KB (all sessions on this machine)',
      `Next retry: ${NEXT_RETRY}`,
      'Error: http_503',
    ]);
  });

  it('reads a failure without an HTTP response as the backend being unreachable', () => {
    const lines = strip(
      formatDeliveryLines({
        status: 'unhealthy',
        reason: 'send_failed',
        pendingBytes: 0,
        sendFailure: { nextAt: Date.parse(NEXT_RETRY), detail: 'request_error' },
      })
    );
    expect(lines.slice(-2)).toEqual([`Next retry: ${NEXT_RETRY}`, 'Error: backend unreachable']);
  });

  it('omits the error row when the failure records no detail', () => {
    const lines = strip(
      formatDeliveryLines({
        status: 'unhealthy',
        reason: 'send_failed',
        pendingBytes: 0,
        sendFailure: { nextAt: Date.parse(NEXT_RETRY) },
      })
    );
    expect(lines.at(-1)).toBe(`Next retry: ${NEXT_RETRY}`);
    expect(lines.join('\n')).not.toContain('Error:');
  });

  it('prints no Run line for unknown', () => {
    expect(strip(formatDeliveryLines({ status: 'unknown', pendingBytes: 0 }))).toEqual([
      'Delivery: unknown (restart the proxy to enable all checks)',
      'Unsent data: none',
    ]);
  });

  it('says the spool-derived reasons cover the whole machine', () => {
    expect(DELIVERY_REASONS.identity_mismatch.label).toContain('on this machine');
    expect(DELIVERY_REASONS.send_failed.label).toContain('on this machine');
  });

  it('reports a stopped proxy for null, with no other rows', () => {
    expect(strip(formatDeliveryLines(null))).toEqual(['Delivery: proxy not running']);
  });

  it('prints the latest drop with the remedy of a session without a project', () => {
    const latestDrop = { reason: 'no_project', stream: 'hooks', at: Date.parse('2026-11-13T09:15:00.000Z'), local: true } as const;

    expect(strip(formatDeliveryLines({ status: 'healthy', pendingBytes: 0, latestDrop }))).toEqual([
      'Delivery: healthy',
      'Unsent data: none',
      'Last dropped: no_project (hooks, 2026-11-13T09:15:00.000Z)',
      '    Run: set a CodeMie project for the folder (codemie setup) — sessions without a project are not sent',
    ]);
  });

  it('prints a drop time outside the date range as the stored number', () => {
    const latestDrop = { reason: 'cli_analytics_disabled', stream: 'hooks', at: 9e15, local: false } as const;
    expect(strip(formatDeliveryLines({ status: 'healthy', pendingBytes: 0, latestDrop })))
      .toContain('Last dropped: cli_analytics_disabled (hooks, 9000000000000000)');
  });

  it('colors only the Delivery status text: green when healthy, yellow otherwise', () => {
    const delivery = (health: Parameters<typeof formatDeliveryLines>[0]): string => formatDeliveryLines(health)[0];
    const row = (status: string): string => chalk.white(`Delivery: ${status}`);

    expect(delivery({ status: 'healthy', pendingBytes: 0 })).toBe(row(chalk.green('healthy')));
    expect(delivery({ status: 'unhealthy', reason: 'auth_rejected', pendingBytes: 0 })).toBe(
      row(chalk.yellow(`unhealthy (${DELIVERY_REASONS.auth_rejected.label})`))
    );
    expect(delivery({ status: 'unknown', pendingBytes: 0 })).toBe(
      row(chalk.yellow('unknown (restart the proxy to enable all checks)'))
    );
    expect(delivery(null)).toBe(row(chalk.yellow('proxy not running')));
  });

  it('leaves every other row plain white', () => {
    const lines = formatDeliveryLines({
      status: 'unhealthy',
      reason: 'send_failed',
      pendingBytes: 0,
      sendFailure: { nextAt: Date.parse(NEXT_RETRY), detail: 'http_503' },
    });

    expect(lines.slice(1)).toEqual([
      chalk.white('Unsent data: none'),
      chalk.white(`Next retry: ${NEXT_RETRY}`),
      chalk.white('Error: http_503'),
    ]);
  });

  it('uses no icons', () => {
    const text = strip(formatDeliveryLines({ status: 'unhealthy', reason: 'auth_rejected', pendingBytes: 1 })).join('\n');
    for (const glyph of ['✓', '○', '⚠', '✗']) {
      expect(text).not.toContain(glyph);
    }
  });
});
