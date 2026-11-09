import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const identity = vi.hoisted(() => ({
  current: { api_identity: 'api-x', owner_hash: 'owner-x' } as { api_identity: string; owner_hash: string } | null,
}));
vi.mock('@/agents/core/evidence/hook-identity.js', () => ({
  currentEvidenceIdentity: vi.fn(async () => identity.current),
}));
const faults = vi.hoisted(() => ({ consentThrows: false }));
vi.mock('@/agents/core/evidence/consent-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agents/core/evidence/consent-store.js')>();
  return {
    ...actual,
    consentHolds: vi.fn(async (...args: Parameters<typeof actual.consentHolds>) => {
      if (faults.consentThrows) throw new Error('consent store lock timeout');
      return actual.consentHolds(...args);
    }),
  };
});

const { freezeLegacyMetricsConsent, legacyMetricsVerdict, isLegacyGateSkip, isLegacyGatedProvider } = await import('../legacy-metrics-gate.js');
const { connectFolder, disconnectFolder } = await import('@/agents/core/evidence/consent-store.js');
const { recordKey } = await import('@/agents/core/evidence/record-store.js');
const { writeNotice, writeStop, markerState } = await import('@/agents/core/evidence/stop-marker.js');
const { evidenceDir, stopFileName } = await import('@/agents/core/evidence/record-store.js');
const { createStatus, writeStatus } = await import('@/providers/plugins/sso/proxy/plugins/otlp-spool/session-status.js');

const SCOPE = { api_identity: 'api-x', owner_hash: 'owner-x', project: 'test321' };
const NATIVE_ID = 'native-17054';
const GATED = 'anthropic-subscription';

describe('legacy /v1/metrics gate', () => {
  let root: string;
  let folder: string;
  const prevHome = process.env.CODEMIE_HOME;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'legacy-gate-'));
    folder = mkdtempSync(join(tmpdir(), 'legacy-gate-repo-'));
    process.env.CODEMIE_HOME = join(root, '.codemie');
    identity.current = { api_identity: 'api-x', owner_hash: 'owner-x' };
    faults.consentThrows = false;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CODEMIE_HOME; else process.env.CODEMIE_HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  async function session(provider = GATED, project: string | undefined = 'test321', agentSessionId = NATIVE_ID) {
    const legacyMetricsConsent = await freezeLegacyMetricsConsent(provider, project, folder);
    return { provider, project, workingDirectory: folder, correlation: { agentSessionId }, legacyMetricsConsent };
  }

  const PENDING = { publish: false, reason: 'destination-pending', transient: true };
  const UNAVAILABLE = { publish: false, reason: 'verdict-unavailable', transient: true };

  it('gates anthropic-subscription only', () => {
    expect(isLegacyGatedProvider(GATED)).toBe(true);
    for (const p of ['ai-run-sso', 'moonshot-subscription', 'jwt', undefined]) expect(isLegacyGatedProvider(p)).toBe(false);
    expect(isLegacyGateSkip('no-work-consent')).toBe(true);
    expect(isLegacyGateSkip('no-analytics-config')).toBe(false);
    expect(isLegacyGateSkip(undefined)).toBe(false);
  });

  it('publishes for ai-run-sso and moonshot-subscription without consent', async () => {
    for (const provider of ['ai-run-sso', 'moonshot-subscription']) {
      const s = await session(provider);
      expect(s.legacyMetricsConsent).toBeUndefined();
      expect(await legacyMetricsVerdict(s)).toEqual({ publish: true });
    }
  });

  it('a gated session without consent freezes nothing and is withheld as no-work-consent', async () => {
    const s = await session();
    expect(s.legacyMetricsConsent).toBeUndefined();
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: false, reason: 'no-work-consent' });
  });

  it('freezes nothing without an identity or a project', async () => {
    await connectFolder(SCOPE, folder);
    expect(await freezeLegacyMetricsConsent(GATED, '', folder)).toBeUndefined();
    expect(await freezeLegacyMetricsConsent(GATED, undefined, folder)).toBeUndefined();
    identity.current = null;
    expect(await freezeLegacyMetricsConsent(GATED, 'test321', folder)).toBeUndefined();
  });

  it('publishes while the frozen consent holds', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    expect(s.legacyMetricsConsent).toMatchObject({ apiIdentity: 'api-x', ownerHash: 'owner-x' });
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: true });
  });

  it('a disconnect after the freeze is consent-revoked', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    await disconnectFolder(SCOPE, folder);
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: false, reason: 'consent-revoked' });
  });

  it('a reconnect (new incarnation) after the freeze is consent-revoked', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    await disconnectFolder(SCOPE, folder);
    await connectFolder(SCOPE, folder);
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: false, reason: 'consent-revoked' });
  });

  it('a notice marker (a recoverable hold) is a transient destination-pending, never a final skip', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    await writeNotice(recordKey('api-x', 'owner-x', NATIVE_ID), 'hold_project_unavailable', NATIVE_ID);
    expect(await legacyMetricsVerdict(s)).toEqual(PENDING);
  });

  it('a non-empty spool holds entry is a transient destination-pending until the hold clears', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    await writeStatus(NATIVE_ID, { ...createStatus(), holds: { session: { reason: 'stamp_pending', since: 1 } } });
    expect(await legacyMetricsVerdict(s)).toEqual(PENDING);
    await writeStatus(NATIVE_ID, createStatus());
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: true });
  });

  it('a marker that cannot be read is transient verdict-unavailable', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    mkdirSync(join(evidenceDir(), stopFileName(recordKey('api-x', 'owner-x', NATIVE_ID))), { recursive: true });
    expect(await legacyMetricsVerdict(s)).toEqual(UNAVAILABLE);
  });

  it('an error while establishing the verdict is transient verdict-unavailable', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    faults.consentThrows = true;
    expect(await legacyMetricsVerdict(s)).toEqual(UNAVAILABLE);
  });

  it('an unsafe native session id never reaches a spool or marker path: transient verdict-unavailable', async () => {
    await connectFolder(SCOPE, folder);
    for (const unsafe of ['../escape', 'a/b', 'a\\b']) {
      expect(await legacyMetricsVerdict(await session(GATED, 'test321', unsafe))).toEqual(UNAVAILABLE);
    }
  });

  it('a stop marker is destination-held', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    await writeStop(recordKey('api-x', 'owner-x', NATIVE_ID), 'consent_revoked', NATIVE_ID);
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: false, reason: 'destination-held' });
  });

  it('a spool discard or stop intent is destination-held', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    await writeStatus(NATIVE_ID, { ...createStatus(), stopIntent: 'consent_revoked' });
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: false, reason: 'destination-held' });
    await writeStatus(NATIVE_ID, { ...createStatus(), lastDiscard: { reason: 'session_project_conflict', stream: 'hooks', bytes: 10, at: Date.now() } });
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: false, reason: 'destination-held' });
    await writeStatus(NATIVE_ID, createStatus());
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: true });
  });

  it('markerState tells absent, notice, stop and unreadable apart', async () => {
    const key = recordKey('api-x', 'owner-x', 'other');
    expect(await markerState(key)).toBe('absent');
    await writeNotice(key, 'hold_project_unavailable', 'other');
    expect(await markerState(key)).toBe('notice');
    await writeStop(key, 'consent_revoked', 'other');
    expect(await markerState(key)).toBe('stop');
    const unreadable = recordKey('api-x', 'owner-x', 'unreadable');
    mkdirSync(join(evidenceDir(), stopFileName(unreadable)), { recursive: true });
    expect(await markerState(unreadable)).toBe('unknown');
  });
});
