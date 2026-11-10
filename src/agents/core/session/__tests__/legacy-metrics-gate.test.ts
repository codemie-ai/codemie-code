import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    consentStatus: vi.fn(async (...args: Parameters<typeof actual.consentStatus>) => {
      if (faults.consentThrows) throw new Error('consent store lock timeout');
      return actual.consentStatus(...args);
    }),
  };
});

const { freezeLegacyMetricsConsent, legacyMetricsVerdict, isLegacyGateSkip, isLegacyGatedProvider } = await import('../legacy-metrics-gate.js');
const { connectFolder, consentStorePath, disconnectFolder } = await import('@/agents/core/evidence/consent-store.js');
const { recordKey } = await import('@/agents/core/evidence/record-store.js');
const { writeNotice, writeStop, markerState } = await import('@/agents/core/evidence/stop-marker.js');
const { acceptedFileName, endedFileName, evidenceDir, projectTag, stopFileName } = await import('@/agents/core/evidence/record-store.js');
const { writeAccepted, acceptedState, writeDestinationMarker } = await import('@/agents/core/evidence/accepted-marker.js');
const { advanceCursor, createStatus, writeStatus } = await import('@/providers/plugins/sso/proxy/plugins/otlp-spool/session-status.js');
const { recordUnacknowledged } = await import('@/providers/plugins/sso/proxy/plugins/otlp-spool/delivery-state.js');
const { statusFile, streamFile } = await import('@/providers/plugins/sso/proxy/plugins/otlp-spool/spool-paths.js');
const { dirname } = await import('node:path');

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
    const startTime = Date.now();
    const frozen = await freezeLegacyMetricsConsent(provider, project, folder);
    return { provider, project, workingDirectory: folder, startTime, correlation: { agentSessionId }, ...frozen };
  }

  const PENDING = { publish: false, reason: 'destination-pending', transient: true };
  const UNCONFIRMED = { publish: false, reason: 'destination-unconfirmed', transient: true };
  /** What the forwarder writes on the backend's verified acceptance of the consented project. */
  const accept = (id = NATIVE_ID, project = 'test321'): Promise<void> => writeAccepted(recordKey('api-x', 'owner-x', id), id, project);
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
    expect(await freezeLegacyMetricsConsent(GATED, '', folder)).toEqual({});
    expect(await freezeLegacyMetricsConsent(GATED, undefined, folder)).toEqual({});
    identity.current = null;
    expect(await freezeLegacyMetricsConsent(GATED, 'test321', folder)).toEqual({});
  });

  it('publishes while the frozen consent holds', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    expect(s.legacyMetricsConsent).toMatchObject({ apiIdentity: 'api-x', ownerHash: 'owner-x' });
    await accept();
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: true });
  });

  it('consent alone does not publish: the session waits, transiently, for the backend to accept its destination', async () => {
    // A short session that ends before the forwarder's first send (QA ed56e443 / cb5ee530): no status, no answer yet
    await connectFolder(SCOPE, folder);
    const s = await session();
    expect(await legacyMetricsVerdict(s)).toEqual(UNCONFIRMED);
    // A status with nothing acknowledged yet is no answer either
    await writeStatus(NATIVE_ID, createStatus());
    expect(await legacyMetricsVerdict(s)).toEqual(UNCONFIRMED);
    await accept();
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: true });
  });

  it('an acceptance outlives the swept spool status: a later retry still publishes', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    await writeStatus(NATIVE_ID, createStatus());
    await accept();
    rmSync(statusFile(NATIVE_ID));
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: true });
  });

  it('a later hold or stop wins over an earlier acceptance', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    await accept();
    await writeStatus(NATIVE_ID, { ...createStatus(), holds: { session: { reason: 'stamp_pending', since: 1 } } });
    expect(await legacyMetricsVerdict(s)).toEqual(PENDING);
    await writeStatus(NATIVE_ID, { ...createStatus(), stopIntent: 'consent_revoked' });
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: false, reason: 'destination-held' });
  });

  it('an unreadable acceptance marker is verdict-unavailable; a corrupt one is no confirmation', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    const path = join(evidenceDir(), acceptedFileName(recordKey('api-x', 'owner-x', NATIVE_ID), projectTag('test321')));
    mkdirSync(path, { recursive: true });
    expect(await legacyMetricsVerdict(s)).toEqual(UNAVAILABLE);
    rmSync(path, { recursive: true });
    writeFileSync(path, '{not json');
    expect(await acceptedState(recordKey('api-x', 'owner-x', NATIVE_ID), 'test321')).toBe('absent');
    expect(await legacyMetricsVerdict(s)).toEqual(UNCONFIRMED);
  });

  it('the acceptance marker is create-once', async () => {
    const key = recordKey('api-x', 'owner-x', NATIVE_ID);
    expect(await acceptedState(key, 'test321')).toBe('absent');
    await writeAccepted(key, NATIVE_ID, 'test321');
    await writeAccepted(key, NATIVE_ID, 'test321');
    expect(await acceptedState(key, 'test321')).toBe('accepted');
  });

  it('an acceptance is for its project only: accepted for A, resumed under B is unconfirmed until B is accepted', async () => {
    await connectFolder(SCOPE, folder);
    await accept(NATIVE_ID, 'test321');
    // The user moves the folder to another project; the same native session is resumed and freezes consent for B
    await disconnectFolder(SCOPE, folder);
    await connectFolder({ ...SCOPE, project: 'other-b' }, folder);
    const resumed = await session(GATED, 'other-b');
    expect(await legacyMetricsVerdict(resumed)).toEqual(UNCONFIRMED);
    await accept(NATIVE_ID, 'other-b');
    expect(await legacyMetricsVerdict(resumed)).toEqual({ publish: true });
  });

  it('the project of an acceptance is compared case-insensitively, as the echo is', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    await accept(NATIVE_ID, 'TEST321');
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: true });
  });

  it('an ended marker wins over an earlier acceptance, with the spool status already swept', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    await accept();
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: true });
    await writeDestinationMarker({ marker: 'ended' }, recordKey('api-x', 'owner-x', NATIVE_ID), NATIVE_ID);
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: false, reason: 'destination-held' });
  });

  it('an unreadable ended marker is verdict-unavailable; a corrupt one counts as ended', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    await accept();
    const path = join(evidenceDir(), endedFileName(recordKey('api-x', 'owner-x', NATIVE_ID)));
    mkdirSync(path, { recursive: true });
    expect(await legacyMetricsVerdict(s)).toEqual(UNAVAILABLE);
    rmSync(path, { recursive: true });
    writeFileSync(path, '{not json');
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: false, reason: 'destination-held' });
  });

  it('a marker the forwarder still owes (status intent) answers for it: acceptance of this project, or the end', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    const key = recordKey('api-x', 'owner-x', NATIVE_ID);
    await writeStatus(NATIVE_ID, { ...createStatus(), destinationIntent: { key, accepted: [projectTag('other-b')] } });
    expect(await legacyMetricsVerdict(s)).toEqual(UNCONFIRMED);
    await writeStatus(NATIVE_ID, { ...createStatus(), destinationIntent: { key: 'f'.repeat(64), accepted: [projectTag('test321')] } });
    expect(await legacyMetricsVerdict(s)).toEqual(UNCONFIRMED);
    await writeStatus(NATIVE_ID, { ...createStatus(), destinationIntent: { key, accepted: [projectTag('test321')] } });
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: true });
    await writeStatus(NATIVE_ID, { ...createStatus(), destinationIntent: { key, accepted: [projectTag('test321')], ended: true } });
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: false, reason: 'destination-held' });
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

  it('a backend hold (503 project_unavailable, as the forwarder records it) is pending until acknowledged; the notice outlives it', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    await writeStatus(NATIVE_ID, createStatus());
    writeFileSync(streamFile(NATIVE_ID, 'hooks'), 'x'.repeat(100));
    await writeNotice(recordKey('api-x', 'owner-x', NATIVE_ID), 'hold_project_unavailable', NATIVE_ID);
    await recordUnacknowledged(NATIVE_ID, 'hooks', { kind: 'retry', reason: 'http_503', detail: 'project_unavailable', hold: true }, { cursor: 0, end: 100 });
    expect(await legacyMetricsVerdict(s)).toEqual(PENDING);
    await advanceCursor(NATIVE_ID, 'hooks', 100);
    expect(await legacyMetricsVerdict(s)).toEqual(UNCONFIRMED);
    await accept();
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: true });
  });

  it('a session-ending discard stays held after a later benign discard replaces lastDiscard', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    await writeStatus(NATIVE_ID, createStatus());
    await advanceCursor(NATIVE_ID, 'hooks', 10, { reason: 'session_project_conflict', stream: 'hooks', bytes: 10, at: Date.now() });
    await advanceCursor(NATIVE_ID, 'logsJson', 10, { reason: 'payload_rejected', stream: 'logsJson', bytes: 10, at: Date.now() });
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: false, reason: 'destination-held' });
  });

  it('a non-empty spool holds entry is a transient destination-pending until the hold clears', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    await writeStatus(NATIVE_ID, { ...createStatus(), holds: { session: { reason: 'stamp_pending', since: 1 } } });
    expect(await legacyMetricsVerdict(s)).toEqual(PENDING);
    await accept();
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

  it('a corrupt marker is a stop, as isStopped reads it: destination-held', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    mkdirSync(evidenceDir(), { recursive: true });
    writeFileSync(join(evidenceDir(), stopFileName(recordKey('api-x', 'owner-x', NATIVE_ID))), '{not json');
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: false, reason: 'destination-held' });
  });

  it('a spool status that cannot be parsed is transient verdict-unavailable, even when it may carry a stop intent', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    await writeStatus(NATIVE_ID, createStatus());
    writeFileSync(statusFile(NATIVE_ID), '{"stopIntent":"consent_revoked"');
    expect(await legacyMetricsVerdict(s)).toEqual(UNAVAILABLE);
  });

  it('an unreadable consent store at send time is transient verdict-unavailable, never consent-revoked', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    writeFileSync(consentStorePath(), '{not json');
    expect(await legacyMetricsVerdict(s)).toEqual(UNAVAILABLE);
  });

  it('a consent store unreadable at start is resolved at send time instead of a final no-work-consent', async () => {
    await connectFolder(SCOPE, folder);
    const { readFileSync } = await import('node:fs');
    const good = readFileSync(consentStorePath(), 'utf-8');
    writeFileSync(consentStorePath(), '{not json');
    const s = await session();
    expect(s).toMatchObject({ legacyMetricsConsentUnresolved: { apiIdentity: 'api-x', ownerHash: 'owner-x' } });
    expect(s.legacyMetricsConsent).toBeUndefined();
    expect(await legacyMetricsVerdict(s)).toEqual(UNAVAILABLE);
    writeFileSync(consentStorePath(), good);
    await accept();
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: true });
    await disconnectFolder(SCOPE, folder);
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: false, reason: 'no-work-consent' });
  });

  it('the send-time lookup runs under the start identity, whoever is signed in now', async () => {
    await connectFolder(SCOPE, folder);
    const { readFileSync } = await import('node:fs');
    const good = readFileSync(consentStorePath(), 'utf-8');
    writeFileSync(consentStorePath(), '{not json');
    const s = await session();
    writeFileSync(consentStorePath(), good);
    await accept();
    identity.current = null; // signed out / unreadable credentials at send time
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: true });
    identity.current = { api_identity: 'api-other', owner_hash: 'owner-other' };
    await connectFolder({ ...SCOPE, api_identity: 'api-other', owner_hash: 'owner-other' }, folder);
    await disconnectFolder(SCOPE, folder);
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: false, reason: 'no-work-consent' });
  });

  it('an entry connected after the session started never counts for an unresolved session', async () => {
    mkdirSync(dirname(consentStorePath()), { recursive: true });
    writeFileSync(consentStorePath(), '{not json');
    const s = await session();
    rmSync(consentStorePath());
    await new Promise((r) => setTimeout(r, 5));
    await connectFolder(SCOPE, folder);
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: false, reason: 'no-work-consent' });
  });

  it('a final verdict persisted on the record is honoured without re-checking', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    expect(await legacyMetricsVerdict({ ...s, legacyMetricsWithheld: 'consent-revoked' })).toEqual({ publish: false, reason: 'consent-revoked' });
  });

  it('an error while establishing the verdict is transient verdict-unavailable', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    faults.consentThrows = true;
    expect(await legacyMetricsVerdict(s)).toEqual(UNAVAILABLE);
  });

  it('a missing or unsafe native session id can never be checked: final session-unverifiable, no spool or marker path', async () => {
    await connectFolder(SCOPE, folder);
    for (const id of ['../escape', 'a/b', 'a\\b', '', 'unknown']) {
      expect(await legacyMetricsVerdict(await session(GATED, 'test321', id))).toEqual({ publish: false, reason: 'session-unverifiable' });
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
    await accept();
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: true });
  });

  it('a rejected legacy OTEL batch (payload_rejected) drops that batch only: the session still publishes', async () => {
    await connectFolder(SCOPE, folder);
    const s = await session();
    await writeStatus(NATIVE_ID, { ...createStatus(), lastDiscard: { reason: 'payload_rejected', stream: 'logsJson', bytes: 10, at: Date.now() } });
    await accept();
    expect(await legacyMetricsVerdict(s)).toEqual({ publish: true });
  });

  it('markerState tells absent, notice, stop and unreadable apart; a corrupt marker is a stop', async () => {
    const key = recordKey('api-x', 'owner-x', 'other');
    expect(await markerState(key)).toBe('absent');
    await writeNotice(key, 'hold_project_unavailable', 'other');
    expect(await markerState(key)).toBe('notice');
    await writeStop(key, 'consent_revoked', 'other');
    expect(await markerState(key)).toBe('stop');
    const unreadable = recordKey('api-x', 'owner-x', 'unreadable');
    mkdirSync(join(evidenceDir(), stopFileName(unreadable)), { recursive: true });
    expect(await markerState(unreadable)).toBe('unknown');
    const corrupt = recordKey('api-x', 'owner-x', 'corrupt');
    writeFileSync(join(evidenceDir(), stopFileName(corrupt)), '');
    expect(await markerState(corrupt)).toBe('stop');
  });
});
