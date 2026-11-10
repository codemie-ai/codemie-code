/**
 * EPMCDME-17054: the legacy `POST /v1/metrics` path of an `anthropic-subscription` session publishes only
 * while work consent holds for the folder, the backend has accepted the session's destination through the new
 * pipeline, and the new pipeline has not held or discarded the session.
 *
 * Seam: `processEvent`. The network boundary is `fetch`; records, the consent store and the evidence
 * markers are real files under a per-test CODEMIE_HOME; the signed-in identity is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    setAgentName: vi.fn(),
    setSessionId: vi.fn(),
    setProfileName: vi.fn(),
    isDebugMode: () => false,
    close: vi.fn(async () => {}),
    runWithContext: (_ctx: unknown, fn: () => unknown) => fn(),
  },
}));
vi.mock('../proxy/otlp-cold-start.js', () => ({ ensureOtlpProxy: vi.fn() }));
vi.mock('../../../providers/core/codemie-auth-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../providers/core/codemie-auth-helpers.js')>()),
  getStoredAnalyticsCredentials: vi.fn(async () => ({ credentials: { cookies: { session: 'abc' } } })),
}));
vi.mock('@/agents/core/evidence/hook-identity.js', () => ({
  currentEvidenceIdentity: vi.fn(async () => ({ api_identity: 'api-x', owner_hash: 'owner-x' })),
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

const { processEvent } = await import('../hook.js');
const { deliverSession, isDeliveryDone } = await import('../hook/delivery.js');
const { getSessionMetricsPath } = await import('@/agents/core/session/session-config.js');
const { SessionStore } = await import('@/agents/core/session/SessionStore.js');
const { getCodemiePath } = await import('@/utils/paths.js');
const { consentStorePath, connectFolder, disconnectFolder } = await import('@/agents/core/evidence/consent-store.js');
const { recordKey } = await import('@/agents/core/evidence/record-store.js');
const { writeNotice } = await import('@/agents/core/evidence/stop-marker.js');
const { writeAccepted } = await import('@/agents/core/evidence/accepted-marker.js');
const { advanceCursor, createStatus, writeStatus } = await import('@/providers/plugins/sso/proxy/plugins/otlp-spool/session-status.js');
const { recordUnacknowledged } = await import('@/providers/plugins/sso/proxy/plugins/otlp-spool/delivery-state.js');
const { streamFile } = await import('@/providers/plugins/sso/proxy/plugins/otlp-spool/spool-paths.js');

interface Sent {
  url: string;
  project: string | null;
  body: { name: string; attributes: Record<string, unknown> };
}

const IDENTITY = { api_identity: 'api-x', owner_hash: 'owner-x' };
const NATIVE_ID = 'agent-17054';

describe('EPMCDME-17054 legacy /v1/metrics work-consent gate', () => {
  let home: string;
  let repo: string;
  let sent: Sent[];
  let idCounter = 0;
  const prevHome = process.env.CODEMIE_HOME;

  const baseConfig = {
    agentName: 'claude',
    clientType: 'codemie-claude',
    version: '0.0.0-test',
    ssoUrl: 'https://codemie.example.com',
    syncApiUrl: 'https://codemie.example.com/code-assistant-api',
    project: 'test321',
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'gate17054-home-'));
    repo = mkdtempSync(join(tmpdir(), 'gate17054-repo-'));
    execFileSync('git', ['init', '-q', repo]);
    process.env.CODEMIE_HOME = home;
    mkdirSync(getCodemiePath('sessions'), { recursive: true });
    sent = [];
    faults.consentThrows = false;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      sent.push({ url: String(input), project: headers.get('X-CodeMie-Project'), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ success: true, message: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevHome === undefined) delete process.env.CODEMIE_HOME; else process.env.CODEMIE_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  function metricCalls(): Sent[] {
    return sent.filter((s) => s.url.endsWith('/v1/metrics'));
  }

  function usageCalls(): Sent[] {
    return metricCalls().filter((m) => m.body.name !== 'codemie_cli_session_total');
  }

  function transcriptLines(): string[] {
    return ['2026-11-01T10:00:01Z', '2026-11-01T10:00:02Z'].map((timestamp, i) => JSON.stringify({
      type: i % 2 === 0 ? 'user' : 'assistant',
      uuid: `msg-${i}`,
      sessionId: NATIVE_ID,
      timestamp,
      message: i % 2 === 0
        ? { role: 'user', content: 'prompt' }
        : { role: 'assistant', id: 'api-1', content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
    }));
  }

  function lifecycleStatuses(): unknown[] {
    return metricCalls().filter((m) => m.body.name === 'codemie_cli_session_total').map((m) => m.body.attributes?.status);
  }

  /** SessionStart, then `between`, then SessionEnd; returns the CodeMie session id. */
  async function runSession(provider: string, between: () => Promise<void> = async () => {}): Promise<string> {
    idCounter += 1;
    const sessionId = `gate-17054-${idCounter}`;
    const transcript = join(repo, 't.jsonl');
    writeFileSync(transcript, '{"type":"user"}\n');
    const base = { session_id: NATIVE_ID, transcript_path: transcript, permission_mode: 'default', cwd: repo };
    const config = { ...baseConfig, provider, sessionId };
    await processEvent({ ...base, hook_event_name: 'SessionStart', source: 'startup' } as never, config);
    await between();
    await processEvent({ ...base, hook_event_name: 'SessionEnd', reason: 'exit' } as never, config);
    return sessionId;
  }

  function configFor(provider: string, sessionId: string) {
    return { ...baseConfig, provider, sessionId };
  }

  const markerKey = (): string => recordKey(IDENTITY.api_identity, IDENTITY.owner_hash, NATIVE_ID);
  /** A backend 503 `project_unavailable` hold as the forwarder records it: the create-once notice plus the held delivery. */
  const hold = async (): Promise<void> => {
    await writeStatus(NATIVE_ID, createStatus());
    writeFileSync(streamFile(NATIVE_ID, 'hooks'), 'x'.repeat(100));
    await writeNotice(markerKey(), 'hold_project_unavailable', NATIVE_ID);
    await recordUnacknowledged(NATIVE_ID, 'hooks', { kind: 'retry', reason: 'http_503', detail: 'project_unavailable', hold: true }, { cursor: 0, end: 100 });
  };
  /** The backend accepts the session's publication to the consented project, as the forwarder records it. */
  const accept = (): Promise<void> => writeAccepted(markerKey(), NATIVE_ID, 'test321');
  /** The hold recovers: the backend acknowledges and accepts the range; the notice marker stays (it is never removed in production). */
  const recover = async (): Promise<void> => {
    await advanceCursor(NATIVE_ID, 'hooks', 100);
    await accept();
  };

  async function endMetricSkipped(sessionId: string): Promise<string | undefined> {
    return (await new SessionStore().loadSession(sessionId))?.endMetricSkipped;
  }

  it('anthropic-subscription without work consent sends no /v1/metrics and marks the end metric skipped', async () => {
    expect(existsSync(consentStorePath())).toBe(false);

    const sessionId = await runSession('anthropic-subscription');

    expect(metricCalls()).toEqual([]);
    expect(await endMetricSkipped(sessionId)).toBe('no-work-consent');
  });

  it('(a) with consent connected for the cwd and the destination accepted, start and end are POSTed with X-CodeMie-Project', async () => {
    await connectFolder({ ...IDENTITY, project: 'test321' }, repo);
    await accept();

    const sessionId = await runSession('anthropic-subscription');

    expect(lifecycleStatuses()).toEqual(['started', 'completed']);
    expect(metricCalls().every((m) => m.project === 'test321')).toBe(true);
    expect(await endMetricSkipped(sessionId)).toBeUndefined();
  });

  it('(a2) consent without the backend accepting the destination (e.g. not a project member): nothing is sent, the record stays undelivered', async () => {
    // QA ed56e443 / cb5ee530: a short session ends before the forwarder's first send, so no hold is known yet
    await connectFolder({ ...IDENTITY, project: 'test321' }, repo);

    const sessionId = await runSession('anthropic-subscription');

    expect(metricCalls()).toEqual([]);
    expect(await endMetricSkipped(sessionId)).toBeUndefined();
    expect(await isDeliveryDone(sessionId, configFor('anthropic-subscription', sessionId))).toBe(false);

    // The backend then refuses the destination: still nothing on a later delivery
    await hold();
    await deliverSession(sessionId, configFor('anthropic-subscription', sessionId));
    expect(metricCalls()).toEqual([]);

    // A member's session is accepted later: the deferred start goes ahead of the end
    await recover();
    await deliverSession(sessionId, configFor('anthropic-subscription', sessionId));
    expect(lifecycleStatuses()).toEqual(['started', 'completed']);
  });

  it('(b) consent revoked between start and end: only the start metric is sent', async () => {
    await connectFolder({ ...IDENTITY, project: 'test321' }, repo);
    await accept();

    const sessionId = await runSession('anthropic-subscription', async () => {
      await disconnectFolder(IDENTITY, repo);
    });

    expect(lifecycleStatuses()).toEqual(['started']);
    expect(await endMetricSkipped(sessionId)).toBe('consent-revoked');
  });

  it('(c) a recoverable hold at SessionEnd leaves the end metric unmarked; it is sent once the hold clears', async () => {
    await connectFolder({ ...IDENTITY, project: 'test321' }, repo);
    await accept(); // accepted at first, then held: a later hold wins over the earlier acceptance

    const sessionId = await runSession('anthropic-subscription', hold);

    expect(lifecycleStatuses()).toEqual(['started']);
    expect(await endMetricSkipped(sessionId)).toBeUndefined();
    expect(await isDeliveryDone(sessionId, configFor('anthropic-subscription', sessionId))).toBe(false);

    await recover();
    await deliverSession(sessionId, configFor('anthropic-subscription', sessionId));

    expect(lifecycleStatuses()).toEqual(['started', 'completed']);
    expect(await endMetricSkipped(sessionId)).toBeUndefined();
  });

  it('(c3) a recoverable hold at SessionStart defers the start metric: it is sent ahead of the end once the hold clears', async () => {
    await connectFolder({ ...IDENTITY, project: 'test321' }, repo);
    await hold();

    const sessionId = await runSession('anthropic-subscription', async () => {
      expect(lifecycleStatuses()).toEqual([]);
      expect((await new SessionStore().loadSession(`gate-17054-${idCounter}`))?.startMetricDeferred).toBe('startup');
      await recover();
    });

    expect(lifecycleStatuses()).toEqual(['started', 'completed']);
    expect((await new SessionStore().loadSession(sessionId))?.startMetricDeferred).toBeUndefined();
  });

  it('(c2) a final hold (stop marker) at SessionEnd is persisted as destination-held', async () => {
    await connectFolder({ ...IDENTITY, project: 'test321' }, repo);
    await accept();
    const { writeStop } = await import('@/agents/core/evidence/stop-marker.js');

    const sessionId = await runSession('anthropic-subscription', async () => {
      await writeStop(markerKey(), 'consent_revoked', NATIVE_ID);
    });

    expect(lifecycleStatuses()).toEqual(['started']);
    expect(await endMetricSkipped(sessionId)).toBe('destination-held');
  });

  it('(e) a gate error at SessionEnd sends nothing and leaves the end metric unmarked; a later delivery sends it', async () => {
    await connectFolder({ ...IDENTITY, project: 'test321' }, repo);
    await accept();

    const sessionId = await runSession('anthropic-subscription', async () => {
      faults.consentThrows = true;
    });

    expect(lifecycleStatuses()).toEqual(['started']);
    expect(await endMetricSkipped(sessionId)).toBeUndefined();

    faults.consentThrows = false;
    await deliverSession(sessionId, configFor('anthropic-subscription', sessionId));

    expect(lifecycleStatuses()).toEqual(['started', 'completed']);
  });

  it('(f) usage deltas under a recoverable hold stay pending and are sent once the hold clears', async () => {
    await connectFolder({ ...IDENTITY, project: 'test321' }, repo);
    await accept(); // accepted at first, then held: a later hold wins over the earlier acceptance
    const sessionId = 'gate-17054-held-deltas';
    const transcript = join(repo, 'held-deltas.jsonl');
    writeFileSync(transcript, `${transcriptLines().join('\n')}\n`);
    const base = { session_id: NATIVE_ID, transcript_path: transcript, permission_mode: 'default', cwd: repo };
    const config = configFor('anthropic-subscription', sessionId);

    await processEvent({ ...base, hook_event_name: 'SessionStart', source: 'startup', startTime: Date.parse('2026-11-01T10:00:00Z') } as never, config);
    await hold();
    await processEvent({ ...base, hook_event_name: 'Stop' } as never, config);
    await processEvent({ ...base, hook_event_name: 'SessionEnd', reason: 'exit' } as never, config);

    expect(lifecycleStatuses()).toEqual(['started']);
    expect(usageCalls()).toEqual([]);
    expect(await endMetricSkipped(sessionId)).toBeUndefined();
    expect(await isDeliveryDone(sessionId, config)).toBe(false);

    await recover();
    await deliverSession(sessionId, config);

    expect(lifecycleStatuses()).toEqual(['started', 'completed']);
    expect(usageCalls().length).toBeGreaterThan(0);
    expect(await isDeliveryDone(sessionId, config)).toBe(true);
  });

  it('without consent, transcript deltas are withheld at Stop and SessionEnd and the session counts as delivered', async () => {
    const sessionId = 'gate-17054-deltas';
    const transcript = join(repo, 'deltas.jsonl');
    writeFileSync(transcript, `${transcriptLines().join('\n')}\n`);
    const base = { session_id: NATIVE_ID, transcript_path: transcript, permission_mode: 'default', cwd: repo };
    const config = { ...baseConfig, provider: 'anthropic-subscription', sessionId };

    await processEvent({ ...base, hook_event_name: 'SessionStart', source: 'startup', startTime: Date.parse('2026-11-01T10:00:00Z') } as never, config);
    await processEvent({ ...base, hook_event_name: 'Stop' } as never, config);
    await processEvent({ ...base, hook_event_name: 'SessionEnd', reason: 'exit' } as never, config);

    // Delivered records are renamed to completed_; the deltas were extracted either way
    const live = getSessionMetricsPath(sessionId);
    const deltaFile = existsSync(live) ? live : join(getCodemiePath('sessions'), `completed_${sessionId}_metrics.jsonl`);
    expect(readFileSync(deltaFile, 'utf-8').trim()).not.toBe('');
    expect(metricCalls()).toEqual([]);
    expect(await endMetricSkipped(sessionId)).toBe('no-work-consent');
    expect(await isDeliveryDone(sessionId, config)).toBe(true);
  });

  it('(d) ai-run-sso without consent still sends start and end', async () => {
    const sessionId = await runSession('ai-run-sso');

    expect(lifecycleStatuses()).toEqual(['started', 'completed']);
    expect(metricCalls().every((m) => m.project === 'test321')).toBe(true);
    expect(await endMetricSkipped(sessionId)).toBeUndefined();
  });
});
