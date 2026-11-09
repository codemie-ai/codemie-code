/**
 * EPMCDME-17054: the legacy `POST /v1/metrics` path of an `anthropic-subscription` session publishes only
 * while work consent holds for the folder and the new pipeline has not held or discarded the session.
 *
 * Seam: `processEvent`. The network boundary is `fetch`; records, the consent store and the evidence
 * markers are real files under a per-test CODEMIE_HOME; the signed-in identity is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const { processEvent } = await import('../hook.js');
const { SessionStore } = await import('@/agents/core/session/SessionStore.js');
const { getCodemiePath } = await import('@/utils/paths.js');
const { consentStorePath, connectFolder, disconnectFolder } = await import('@/agents/core/evidence/consent-store.js');
const { recordKey } = await import('@/agents/core/evidence/record-store.js');
const { writeNotice } = await import('@/agents/core/evidence/stop-marker.js');

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

  async function endMetricSkipped(sessionId: string): Promise<string | undefined> {
    return (await new SessionStore().loadSession(sessionId))?.endMetricSkipped;
  }

  it('anthropic-subscription without work consent sends no /v1/metrics and marks the end metric skipped', async () => {
    expect(existsSync(consentStorePath())).toBe(false);

    const sessionId = await runSession('anthropic-subscription');

    expect(metricCalls()).toEqual([]);
    expect(await endMetricSkipped(sessionId)).toBe('no-work-consent');
  });

  it('(a) with consent connected for the cwd, start and end are POSTed with X-CodeMie-Project', async () => {
    await connectFolder({ ...IDENTITY, project: 'test321' }, repo);

    const sessionId = await runSession('anthropic-subscription');

    expect(lifecycleStatuses()).toEqual(['started', 'completed']);
    expect(metricCalls().every((m) => m.project === 'test321')).toBe(true);
    expect(await endMetricSkipped(sessionId)).toBeUndefined();
  });

  it('(b) consent revoked between start and end: only the start metric is sent', async () => {
    await connectFolder({ ...IDENTITY, project: 'test321' }, repo);

    const sessionId = await runSession('anthropic-subscription', async () => {
      await disconnectFolder(IDENTITY, repo);
    });

    expect(lifecycleStatuses()).toEqual(['started']);
    expect(await endMetricSkipped(sessionId)).toBe('consent-revoked');
  });

  it('(c) a hold marker for the record key before SessionEnd withholds the end metric', async () => {
    await connectFolder({ ...IDENTITY, project: 'test321' }, repo);

    const sessionId = await runSession('anthropic-subscription', async () => {
      await writeNotice(recordKey(IDENTITY.api_identity, IDENTITY.owner_hash, NATIVE_ID), 'hold_project_unavailable', NATIVE_ID);
    });

    expect(lifecycleStatuses()).toEqual(['started']);
    expect(await endMetricSkipped(sessionId)).toBe('destination-held');
  });

  it('(d) ai-run-sso without consent still sends start and end', async () => {
    const sessionId = await runSession('ai-run-sso');

    expect(lifecycleStatuses()).toEqual(['started', 'completed']);
    expect(metricCalls().every((m) => m.project === 'test321')).toBe(true);
    expect(await endMetricSkipped(sessionId)).toBeUndefined();
  });
});
