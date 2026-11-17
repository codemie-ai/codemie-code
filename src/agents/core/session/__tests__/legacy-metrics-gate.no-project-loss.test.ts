import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/agents/core/evidence/hook-identity.js', () => ({
  currentEvidenceIdentity: vi.fn(async () => ({ api_identity: 'api-x', owner_hash: 'owner-x' })),
}));

const { freezeLegacyMetricsConsent, legacyMetricsVerdict } = await import('../legacy-metrics-gate.js');
const { connectFolder } = await import('@/agents/core/evidence/consent-store.js');
const { recordKey } = await import('@/agents/core/evidence/record-store.js');
const { writeAccepted } = await import('@/agents/core/evidence/accepted-marker.js');
const { createStatus, writeStatus } = await import('@/providers/plugins/sso/proxy/plugins/otlp-spool/session-status.js');

const SCOPE = { api_identity: 'api-x', owner_hash: 'owner-x', project: 'test321' };
const NATIVE_ID = 'native-no-project-loss';

describe('legacy /v1/metrics gate and a no_project loss', () => {
  let root: string;
  let folder: string;
  const prevHome = process.env.CODEMIE_HOME;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'legacy-gate-loss-'));
    folder = mkdtempSync(join(tmpdir(), 'legacy-gate-loss-repo-'));
    process.env.CODEMIE_HOME = join(root, '.codemie');
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CODEMIE_HOME; else process.env.CODEMIE_HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  it('decides as for the same session with no loss and no discard', async () => {
    await connectFolder(SCOPE, folder);
    const frozen = await freezeLegacyMetricsConsent('anthropic-subscription', 'test321', folder);
    const session = {
      provider: 'anthropic-subscription',
      project: 'test321',
      workingDirectory: folder,
      startTime: Date.now(),
      correlation: { agentSessionId: NATIVE_ID },
      ...frozen,
    };
    const withLoss = { ...createStatus(), lastLoss: { reason: 'no_project' as const, at: 1_700_000_000_000, bytes: 200, stream: 'hooks' as const } };

    await writeStatus(NATIVE_ID, createStatus());
    expect(await legacyMetricsVerdict(session)).toEqual({ publish: false, reason: 'destination-unconfirmed', transient: true });
    await writeStatus(NATIVE_ID, withLoss);
    expect(await legacyMetricsVerdict(session)).toEqual({ publish: false, reason: 'destination-unconfirmed', transient: true });

    await writeAccepted(recordKey('api-x', 'owner-x', NATIVE_ID), NATIVE_ID, 'test321');
    await writeStatus(NATIVE_ID, createStatus());
    expect(await legacyMetricsVerdict(session)).toEqual({ publish: true });
    await writeStatus(NATIVE_ID, withLoss);
    expect(await legacyMetricsVerdict(session)).toEqual({ publish: true });
  });
});
