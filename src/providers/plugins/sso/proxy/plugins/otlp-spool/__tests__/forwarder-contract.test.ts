import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const snapshotPendingHookRecordsMock = vi.fn();
const advanceCursorMock = vi.fn();
const isSendAllowedMock = vi.fn();
const readStateMock = vi.fn();
const fetchMock = vi.fn();
const readStatusMock = vi.fn();
const readRecordMock = vi.fn();
const getPolicyStateMock = vi.fn();
const isStoppedMock = vi.fn();
const writeStopMock = vi.fn();
const writeNoticeMock = vi.fn();
const consentHoldsMock = vi.fn();
const noteFailureMock = vi.fn(async () => 'noted');

vi.mock('../spool-io.js', () => ({
  snapshotPendingHookRecords: snapshotPendingHookRecordsMock,
  snapshotPendingBytes: vi.fn().mockResolvedValue(null),
  snapshotPendingNdjsonRecords: vi.fn().mockResolvedValue(null),
  isSendAllowed: isSendAllowedMock,
  noteStreamHold: vi.fn().mockResolvedValue('clear'),
  forwarderIdentity: vi.fn().mockReturnValue({ api_identity: 'https://api', owner_hash: 'h' }),
}));
vi.mock('../delivery-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../delivery-state.js')>();
  return {
    ...actual,
    deliveryGate: vi.fn(async () => 'go'),
    recordUnacknowledged: async (_s: string, _st: string, outcome: never) => {
      const f = actual.deliveryFailureOf(outcome);
      if (f) await noteFailureMock(f);
    },
  };
});
vi.mock('../session-status.js', () => ({ advanceCursor: advanceCursorMock, markSessionEnded: vi.fn(), readStatus: readStatusMock }));
vi.mock('../session-lock.js', () => ({ withSessionLock: (_s: string, fn: () => unknown) => fn() }));
vi.mock('@/agents/core/evidence/record-store.js', async (importOriginal) => ({ ...(await importOriginal<object>()), readRecord: readRecordMock }));
vi.mock('../policy-cache.js', async (importOriginal) => ({ ...(await importOriginal<object>()), getPolicyState: getPolicyStateMock, refreshPolicy: vi.fn() }));
vi.mock('../verdict-store.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readVerdictState: vi.fn().mockResolvedValue({ state: 'none' }),
  recordVerdict: vi.fn().mockResolvedValue({ schema: 1, class: 'personal', created: 0 }),
  replaceVerdict: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/agents/core/evidence/stop-marker.js', () => ({ isStopped: isStoppedMock, writeStop: writeStopMock, writeNotice: writeNoticeMock }));
vi.mock('@/agents/core/evidence/consent-store.js', () => ({ consentHolds: consentHoldsMock }));
vi.mock('@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js', () => ({
  readClaudeAnalyticsPreferences: vi.fn().mockResolvedValue({ kind: 'ok', value: { collectionGeneration: 0 } }),
}));
vi.mock('@/cli/commands/proxy/daemon-manager.js', () => ({ readState: readStateMock }));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const credentials = { cookies: { codemie_access_token: 'tok' }, apiUrl: 'https://api', timestamp: 0 };
const record = {
  schema: 1, session_id: 's1', launch_mode: 'native', routed_via_codemie: false, routing_proof: 'proven', organization: 'Acme',
  project: 'Proj A', project_source: 'none', api_identity: 'https://api', owner_hash: 'h', created: 0, last_used: 0,
  funding_route: 'subscription', collection_generation: 0,
};
const line = JSON.stringify({ agentName: 'claude-code-otlp', hookEvent: JSON.stringify({ type: 'agent.tool.end', session_id: 's1', codemie_project_name: 'Proj A' }) });
const batch = { project: 'Proj A', records: [line], cursor: 0, byteLength: Buffer.byteLength(line) + 1, dropped: 0, filtered: false };
const policy = (contracts?: string[]) => ({
  policy: { organizations: ['Acme'], version: 'v1' }, capability: 'evidence', usable: true, refreshDue: false,
  ...(contracts ? { publicationContracts: contracts } : {}),
});
const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const echo = (dest: string, project?: string) => ({
  'X-CodeMie-Publication-Contract': '1', 'X-CodeMie-Destination': dest, ...(project ? { 'X-CodeMie-Bound-Project': project } : {}),
});
const sentHeaders = () => fetchMock.mock.calls[0][1].headers as Record<string, string>;

describe('new-contract forwarding', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    readStateMock.mockResolvedValue({ url: 'http://127.0.0.1:1', targetUrl: 'https://api', profile: 'p' });
    isSendAllowedMock.mockResolvedValue(true);
    readStatusMock.mockResolvedValue({ sendMode: 'evidence' });
    readRecordMock.mockResolvedValue({ kind: 'existing', record });
    getPolicyStateMock.mockResolvedValue(policy(['1']));
    snapshotPendingHookRecordsMock.mockResolvedValue(batch);
    isStoppedMock.mockResolvedValue(false);
    consentHoldsMock.mockResolvedValue(true);
  });
  afterEach(() => vi.unstubAllGlobals());
  const run = async () => (await import('../forwarder.js')).forwardSession('s1', true, credentials);

  it('N0 acceptance with the echo is acknowledged; contract and funding are sent, consent is not', async () => {
    fetchMock.mockImplementation(async () => respond(200, {}, echo('personal')));
    await run();
    expect(sentHeaders()).toMatchObject({ 'X-CodeMie-Publication-Contract': '1', 'X-CodeMie-Funding-Route': 'subscription' });
    expect(sentHeaders()).not.toHaveProperty('X-CodeMie-Work-Consent');
    expect(advanceCursorMock).toHaveBeenCalled();
    expect(writeStopMock).not.toHaveBeenCalled();
  });

  it('N1 acceptance needs destination=project and the bound project equal (case-insensitive)', async () => {
    readRecordMock.mockResolvedValue({ kind: 'existing', record: { ...record, consent_ref: 'abcdef0123456789' } });
    fetchMock.mockImplementation(async () => respond(200, {}, echo('project', 'proj a')));
    await run();
    expect(sentHeaders()['X-CodeMie-Work-Consent']).toBe('explicit-folder');
    expect(advanceCursorMock).toHaveBeenCalled();
  });

  it.each([
    ['no echo at all', {}],
    ['wrong contract', { 'X-CodeMie-Publication-Contract': '2', 'X-CodeMie-Destination': 'personal' }],
    ['N1 personal destination', echo('personal')],
    ['N1 other bound project', echo('project', 'other')],
    ['N1 missing bound project', echo('project')],
  ])('response_unverified (%s) is never acknowledged and persists a stop', async (_n, headers) => {
    readRecordMock.mockResolvedValue({ kind: 'existing', record: { ...record, consent_ref: 'abcdef0123456789' } });
    fetchMock.mockImplementation(async () => respond(200, {}, headers as Record<string, string>));
    await run();
    expect(advanceCursorMock).not.toHaveBeenCalled();
    expect(writeStopMock).toHaveBeenCalledWith(expect.any(String), 'response_unverified', 's1');
    expect(noteFailureMock).toHaveBeenCalledWith(expect.objectContaining({ reason: 'response_unverified' }));
  });

  it('N0 acceptance without the echo is unverified too', async () => {
    fetchMock.mockImplementation(async () => respond(200, {}));
    await run();
    expect(advanceCursorMock).not.toHaveBeenCalled();
    expect(writeStopMock).toHaveBeenCalled();
  });

  it('a final discard is terminal without any echo and is not a stop', async () => {
    fetchMock.mockImplementation(async () => respond(200, { accepted: 0, dropped: 1, reason: 'session_contract_conflict' }));
    await run();
    expect(advanceCursorMock).toHaveBeenCalledWith('s1', 'hooks', batch.byteLength, expect.objectContaining({ reason: 'session_contract_conflict' }));
    expect(writeStopMock).not.toHaveBeenCalled();
  });

  it('422 final drops the range and stops the session with a reason', async () => {
    fetchMock.mockImplementation(async () => respond(422, { reason: 'publication_contract_requires_session', disposition: 'final' }));
    await run();
    expect(writeStopMock).toHaveBeenCalledWith(expect.any(String), 'requires_session', 's1');
  });

  it('503 hold raises a first-hold notice and is not acknowledged', async () => {
    fetchMock.mockImplementation(async () => respond(503, { reason: 'project_analytics_not_enabled', disposition: 'hold' }));
    await run();
    expect(writeNoticeMock).toHaveBeenCalled();
    expect(advanceCursorMock).not.toHaveBeenCalled();
    expect(writeStopMock).not.toHaveBeenCalled();
  });

  it('a stopped session sends nothing, backlog included', async () => {
    isStoppedMock.mockResolvedValue(true);
    await run();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('revoked consent stops the bound session and never sends a downgraded request', async () => {
    readRecordMock.mockResolvedValue({ kind: 'existing', record: { ...record, consent_ref: 'abcdef0123456789' } });
    consentHoldsMock.mockResolvedValue(false);
    await run();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeStopMock).toHaveBeenCalledWith(expect.any(String), 'consent_revoked', 's1');
  });

  it('no advertised contract: a new-contract session is never sent as legacy', async () => {
    getPolicyStateMock.mockResolvedValue(policy());
    await run();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('injected contract/consent/funding headers (any case) in the spooled hook event never reach the request', async () => {
    const hostile = JSON.stringify({ agentName: 'claude-code-otlp', hookEvent: JSON.stringify({ type: 'agent.tool.end', session_id: 's1', codemie_project_name: 'Proj A', headers: { 'x-codemie-work-consent': 'explicit-folder' } }) });
    snapshotPendingHookRecordsMock.mockResolvedValue({ ...batch, records: [hostile], byteLength: Buffer.byteLength(hostile) + 1 });
    fetchMock.mockImplementation(async () => respond(200, {}, echo('personal')));
    await run();
    expect(Object.keys(sentHeaders()).map((k) => k.toLowerCase())).not.toContain('x-codemie-work-consent');
    expect(sentHeaders()['X-CodeMie-Funding-Route']).toBe('subscription');
  });
});
