import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const identity = vi.hoisted(() => ({
  current: { api_identity: 'api-x', owner_hash: 'owner-x' } as { api_identity: string; owner_hash: string } | null,
}));
vi.mock('@/agents/core/evidence/hook-identity.js', () => ({
  currentEvidenceIdentity: vi.fn(async () => identity.current),
}));

const { freezeLegacyMetricsConsent, legacyMetricsVerdict, isLegacyGateSkip, isLegacyGatedProvider } = await import('../legacy-metrics-gate.js');
const { connectFolder, disconnectFolder } = await import('@/agents/core/evidence/consent-store.js');
const { recordKey } = await import('@/agents/core/evidence/record-store.js');
const { writeNotice, writeStop, hasMarker } = await import('@/agents/core/evidence/stop-marker.js');
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
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CODEMIE_HOME; else process.env.CODEMIE_HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  async function session(provider = GATED, project: string | undefined = 'test321') {
    const legacyMetricsConsent = await freezeLegacyMetricsConsent(provider, project, folder);
    return { provider, project, workingDirectory: folder, correlation: { agentSessionId: NATIVE_ID }, legacyMetricsConsent };
  }

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

  it('a notice marker is destination-held', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    await writeNotice(recordKey('api-x', 'owner-x', NATIVE_ID), 'hold_project_unavailable', NATIVE_ID);
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: false, reason: 'destination-held' });
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

  it('hasMarker is false only when no marker exists', async () => {
    const key = recordKey('api-x', 'owner-x', 'other');
    expect(await hasMarker(key)).toBe(false);
    await writeNotice(key, 'hold_project_unavailable', 'other');
    expect(await hasMarker(key)).toBe(true);
  });
});
