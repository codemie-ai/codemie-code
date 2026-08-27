/**
 * Regression tests for the analytics auth-status marker.
 *
 * Pins the current contract of markAnalyticsAuthInvalid /
 * getAnalyticsAuthStatus / clearAnalyticsAuthStatus. The marker file lives at
 * getCodemiePath('analytics-auth-status.json'), which honours CODEMIE_HOME, so
 * every test runs against its own throwaway CODEMIE_HOME temp dir.
 */

import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  markAnalyticsAuthInvalid,
  getAnalyticsAuthStatus,
  clearAnalyticsAuthStatus
} from '../analytics-auth-status.js';
import { getCodemiePath } from '../paths.js';

const BASE_URL = 'https://metrics.example.com';

describe('analytics-auth-status', () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.CODEMIE_HOME;
    tempHome = mkdtempSync(join(tmpdir(), 'codemie-analytics-auth-'));
    process.env.CODEMIE_HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.CODEMIE_HOME;
    } else {
      process.env.CODEMIE_HOME = originalHome;
    }
    try {
      rmSync(tempHome, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  });

  const markerPath = (): string => getCodemiePath('analytics-auth-status.json');

  it('mark then get round-trips the status', async () => {
    await markAnalyticsAuthInvalid('HTTP 401', BASE_URL);

    const status = await getAnalyticsAuthStatus();
    expect(status).not.toBeNull();
    expect(status).toMatchObject({
      status: 'invalid',
      reason: 'HTTP 401',
      baseUrl: BASE_URL
    });
    expect(typeof status?.detectedAt).toBe('number');
    expect(status?.detectedAt).toBeGreaterThan(0);
    // Marker file is physically written under CODEMIE_HOME
    expect(existsSync(markerPath())).toBe(true);
  });

  it('preserves the original detectedAt on a second mark with a different reason', async () => {
    await markAnalyticsAuthInvalid('HTTP 401', BASE_URL);
    const first = await getAnalyticsAuthStatus();
    expect(first).not.toBeNull();
    const originalDetectedAt = first!.detectedAt;

    // Overwrite the detectedAt on disk with a known older value so the
    // preservation is observable regardless of clock resolution.
    const older = originalDetectedAt - 60_000;
    writeFileSync(
      markerPath(),
      JSON.stringify({ status: 'invalid', reason: 'HTTP 401', baseUrl: BASE_URL, detectedAt: older }),
      'utf-8'
    );

    await markAnalyticsAuthInvalid('HTML login page', 'https://other.example.com');

    const second = await getAnalyticsAuthStatus();
    expect(second).not.toBeNull();
    // detectedAt is preserved from the pre-existing marker...
    expect(second!.detectedAt).toBe(older);
    // ...while reason and baseUrl are updated to the latest values.
    expect(second!.reason).toBe('HTML login page');
    expect(second!.baseUrl).toBe('https://other.example.com');
  });

  it('clear removes the marker and get returns null afterwards', async () => {
    await markAnalyticsAuthInvalid('HTTP 403', BASE_URL);
    expect(existsSync(markerPath())).toBe(true);

    await clearAnalyticsAuthStatus();

    expect(existsSync(markerPath())).toBe(false);
    expect(await getAnalyticsAuthStatus()).toBeNull();
  });

  it('get returns null when the marker file is missing', async () => {
    expect(existsSync(markerPath())).toBe(false);
    expect(await getAnalyticsAuthStatus()).toBeNull();
  });

  it('get returns null (never throws) for a corrupt / non-JSON marker file', async () => {
    writeFileSync(markerPath(), 'this is not json {{{', 'utf-8');
    await expect(getAnalyticsAuthStatus()).resolves.toBeNull();
  });

  it('get returns null when the marker status is not "invalid"', async () => {
    writeFileSync(
      markerPath(),
      JSON.stringify({ status: 'valid', reason: 'ok', baseUrl: BASE_URL, detectedAt: Date.now() }),
      'utf-8'
    );
    expect(await getAnalyticsAuthStatus()).toBeNull();
  });

  it('get returns null for valid JSON that is missing the status field', async () => {
    writeFileSync(markerPath(), JSON.stringify({ reason: 'x', baseUrl: BASE_URL }), 'utf-8');
    expect(await getAnalyticsAuthStatus()).toBeNull();
  });

  it('clear is a no-op (never throws) when no marker exists', async () => {
    expect(existsSync(markerPath())).toBe(false);
    await expect(clearAnalyticsAuthStatus()).resolves.toBeUndefined();
    expect(existsSync(markerPath())).toBe(false);
  });

  it('mark is best-effort and never throws when the marker cannot be written', async () => {
    // Point CODEMIE_HOME at a path whose parent does not exist, so writeFile
    // rejects internally. The function must swallow the error.
    process.env.CODEMIE_HOME = join(tempHome, 'does', 'not', 'exist');
    await expect(markAnalyticsAuthInvalid('HTTP 401', BASE_URL)).resolves.toBeUndefined();
    // And a subsequent read of the unwritable location stays null, not throwing.
    await expect(getAnalyticsAuthStatus()).resolves.toBeNull();
  });

  it('isolates marker state per CODEMIE_HOME', async () => {
    await markAnalyticsAuthInvalid('HTTP 401', BASE_URL);
    expect(await getAnalyticsAuthStatus()).not.toBeNull();

    // Switch to a fresh home: the marker must not leak across homes.
    const otherHome = mkdtempSync(join(tmpdir(), 'codemie-analytics-auth-other-'));
    mkdirSync(otherHome, { recursive: true });
    process.env.CODEMIE_HOME = otherHome;
    try {
      expect(await getAnalyticsAuthStatus()).toBeNull();
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
    }
  });
});
