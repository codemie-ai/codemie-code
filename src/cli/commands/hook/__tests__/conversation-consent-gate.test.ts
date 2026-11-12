/**
 * EPMCDME-17142: the automatic /v1/conversations upload of an anthropic-subscription session follows the same
 * session-frozen work-consent boundary as its legacy /v1/metrics path. Real entry point (`deliverSessionRecord`, the
 * SessionEnd / generation-close / stale-recovery delivery), real SessionStore, real legacy gate, consent store,
 * SessionSyncer, conversation processor and API client; only the network (fetch) and the evidence identity are faked.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), runWithContext: async (_c: unknown, f: () => unknown) => f() },
}));
vi.mock('@/agents/core/evidence/hook-identity.js', () => ({
  currentEvidenceIdentity: vi.fn(async () => ({ api_identity: 'api-x', owner_hash: 'owner-x' })),
}));

const SCOPE = { api_identity: 'api-x', owner_hash: 'owner-x', project: 'proj-a' };
const SID = 'probe-1';
const NATIVE = 'agent-1';
const PROMPT = 'PRIVATE-PROMPT';

let root: string;
let folder: string;
const prevHome = process.env.CODEMIE_HOME;
const fetchMock = vi.fn();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'conv-gate-'));
  folder = mkdtempSync(join(tmpdir(), 'conv-gate-repo-'));
  process.env.CODEMIE_HOME = join(root, '.codemie');
  delete process.env.CODEMIE_CONV_SYNC_DISABLED;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true, new_messages: 1, total_messages: 1 }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (prevHome === undefined) delete process.env.CODEMIE_HOME; else process.env.CODEMIE_HOME = prevHome;
  rmSync(root, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

/** The session record as the launch's SessionStart freezes it, plus one pending conversation payload. */
async function seed(provider: string) {
  const { SessionStore } = await import('@/agents/core/session/SessionStore.js');
  const { freezeLegacyMetricsConsent } = await import('@/agents/core/session/legacy-metrics-gate.js');
  const { getSessionConversationPath } = await import('@/agents/core/session/session-config.js');
  mkdirSync(join(root, '.codemie', 'sessions'), { recursive: true });
  const startTime = Date.now() - 1000;
  await new SessionStore().saveSession({
    sessionId: SID, agentName: 'claude', provider, project: 'proj-a', startTime, workingDirectory: folder, status: 'completed',
    reason: 'exit', activeDurationMs: 1, codemieUrl: 'https://codemie.example.com',
    correlation: { status: 'matched', agentSessionId: NATIVE, agentSessionFile: join(root, 't.jsonl'), retryCount: 0 },
    ...(await freezeLegacyMetricsConsent(provider, 'proj-a', folder)),
  } as never);
  writeFileSync(
    getSessionConversationPath(SID),
    JSON.stringify({
      payloadId: 'p1', timestamp: Date.now(), isTurnContinuation: false, historyIndices: [0], messageCount: 1, status: 'pending',
      payload: { conversationId: 'c1', history: [{ role: 'User', message: PROMPT, history_index: 0, date: new Date().toISOString() }] },
    }) + '\n'
  );
}

const config = (provider: string) => ({
  agentName: 'claude', provider, ssoUrl: 'https://codemie.example.com', syncApiUrl: 'https://codemie.example.com/code-assistant-api',
  cookies: 'c=1', sessionId: SID, clientType: 'codemie-cli', version: '0.0.0',
}) as never;

const deliver = async (provider: string): Promise<void> => {
  const { deliverSessionRecord } = await import('../delivery.js');
  await deliverSessionRecord(SID, NATIVE, 'exit', config(provider), {});
};
const conversationPuts = () => fetchMock.mock.calls.filter(([u]) => String(u).includes('/v1/conversations'));
const sentPrompt = () => fetchMock.mock.calls.some(([, i]) => String((i as RequestInit)?.body ?? '').includes(PROMPT));
const queue = async () => {
  const { getSessionConversationPath } = await import('@/agents/core/session/session-config.js');
  const live = getSessionConversationPath(SID);
  const path = existsSync(live) ? live : live.replace(`${SID}_conversation`, `completed_${SID}_conversation`); // a delivered record is renamed completed_
  return readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { status: string; error?: string; syncAttempts?: number });
};
const accept = async (): Promise<void> => {
  const { writeAccepted } = await import('@/agents/core/evidence/accepted-marker.js');
  const { recordKey } = await import('@/agents/core/evidence/record-store.js');
  await writeAccepted(recordKey('api-x', 'owner-x', NATIVE), NATIVE, 'proj-a');
};

describe('automatic conversation delivery of an anthropic-subscription session', () => {
  it('no consent: no /v1/conversations or /v1/metrics request, the payload is withheld (not failed) and never retried', async () => {
    await seed('anthropic-subscription');
    await deliver('anthropic-subscription');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sentPrompt()).toBe(false);
    expect(await queue()).toEqual([expect.objectContaining({ status: 'withheld', error: 'no-work-consent' })]);
    expect((await queue())[0].syncAttempts).toBeUndefined(); // not a transport attempt

    const { isDeliveryDone } = await import('../delivery.js');
    expect(await isDeliveryDone(SID, config('anthropic-subscription'))).toBe(true); // nothing left to retry
    await deliver('anthropic-subscription'); // a recovery pass changes nothing
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('valid frozen consent with the destination accepted: the conversation is uploaded', async () => {
    const { connectFolder } = await import('@/agents/core/evidence/consent-store.js');
    await connectFolder(SCOPE, folder);
    await seed('anthropic-subscription');
    await accept();
    await deliver('anthropic-subscription');
    expect(conversationPuts()).toHaveLength(1);
    expect(sentPrompt()).toBe(true);
    expect((await queue())[0].status).toBe('success');
  });

  it('consent but the destination not yet accepted: waits, unchanged and uncounted, then uploads once accepted', async () => {
    const { connectFolder } = await import('@/agents/core/evidence/consent-store.js');
    await connectFolder(SCOPE, folder);
    await seed('anthropic-subscription');
    await deliver('anthropic-subscription');
    expect(conversationPuts()).toHaveLength(0);
    expect(await queue()).toEqual([expect.objectContaining({ status: 'pending' })]);
    expect((await queue())[0].syncAttempts).toBeUndefined();

    await accept();
    await deliver('anthropic-subscription');
    expect(conversationPuts()).toHaveLength(1);
    expect((await queue())[0].status).toBe('success');
  });

  it('revoked after the session started: nothing is uploaded, queued data is withheld', async () => {
    const { connectFolder, disconnectFolder } = await import('@/agents/core/evidence/consent-store.js');
    await connectFolder(SCOPE, folder);
    await seed('anthropic-subscription');
    await accept();
    await disconnectFolder({ api_identity: 'api-x', owner_hash: 'owner-x' }, folder);
    await deliver('anthropic-subscription');
    expect(conversationPuts()).toHaveLength(0);
    expect(sentPrompt()).toBe(false);
    expect((await queue())[0]).toMatchObject({ status: 'withheld', error: 'consent-revoked' });
  });

  it('a consent connected after the session started never covers it', async () => {
    await seed('anthropic-subscription');
    const { connectFolder } = await import('@/agents/core/evidence/consent-store.js');
    await connectFolder(SCOPE, folder);
    await accept();
    await deliver('anthropic-subscription');
    expect(conversationPuts()).toHaveLength(0);
    expect((await queue())[0]).toMatchObject({ status: 'withheld', error: 'no-work-consent' });
  });

  it('an API-based provider (ai-run-sso) without any consent is unchanged: the conversation is uploaded', async () => {
    await seed('ai-run-sso');
    await deliver('ai-run-sso');
    expect(conversationPuts()).toHaveLength(1);
    expect(sentPrompt()).toBe(true);
    expect((await queue())[0].status).toBe('success');
  });
});
