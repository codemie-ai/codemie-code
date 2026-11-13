/**
 * IR-CLI002 fault injection at the verdict-store seam: durable privacy state that cannot be written or
 * read never authorizes an evidence-free or unmarked send.
 * @group unit
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readVerdictStateMock = vi.fn();
const recordVerdictMock = vi.fn();
const replaceVerdictMock = vi.fn();

vi.mock('../verdict-store.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readVerdictState: readVerdictStateMock,
  recordVerdict: recordVerdictMock,
  replaceVerdict: replaceVerdictMock,
}));
vi.mock('@/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const record = {
  schema: 1, session_id: 's1', launch_mode: 'native', routed_via_codemie: false, routing_proof: 'proven',
  organization: 'Acme', project_source: 'none', api_identity: 'https://api', owner_hash: 'h', created: 0, last_used: 0,
} as never;
const other = { organizations: ['Other'], version: 'v1' };

describe('classifySession durability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readVerdictStateMock.mockResolvedValue({ state: 'none' });
    recordVerdictMock.mockResolvedValue(null);
    replaceVerdictMock.mockResolvedValue(false);
  });

  it('initial verdict write failure: a determinate Personal is held verdict_unavailable, not sent', async () => {
    const { classifySession } = await import('../classification.js');
    expect(await classifySession('k', record, { policy: other, capability: 'evidence' })).toEqual({ action: 'hold', reason: 'verdict_unavailable' });
    expect(recordVerdictMock).toHaveBeenCalled();
  });

  it('a non-Personal result does not depend on the verdict write', async () => {
    const { classifySession } = await import('../classification.js');
    const r = await classifySession('k', record, { policy: { organizations: ['acme'], version: 'v1' }, capability: 'evidence' });
    expect(r).toMatchObject({ action: 'send', result: { class: 'corporate' } });
  });

  it('an unreadable verdict without a usable policy is held, whatever the capability (no legacy, no stripped send)', async () => {
    readVerdictStateMock.mockResolvedValue({ state: 'unreadable' });
    const { classifySession } = await import('../classification.js');
    for (const capability of ['evidence', 'legacy', 'unknown'] as const) {
      expect(await classifySession('k', record, { policy: null, capability })).toEqual({ action: 'hold', reason: 'verdict_unavailable' });
    }
  });

  it('an unreadable verdict with a fresh policy: Personal must be re-persisted or it is held', async () => {
    readVerdictStateMock.mockResolvedValue({ state: 'unreadable' });
    const { classifySession } = await import('../classification.js');
    expect(await classifySession('k', record, { policy: other, capability: 'evidence' })).toEqual({ action: 'hold', reason: 'verdict_unavailable' });
    recordVerdictMock.mockResolvedValue({ schema: 1, class: 'personal', created: 0 });
    expect(await classifySession('k', record, { policy: other, capability: 'evidence' })).toMatchObject({ action: 'send', result: { class: 'personal' } });
  });

  it('a failed replace of a stored verdict by an eligible fresh result is held, not sent as if replaced', async () => {
    readVerdictStateMock.mockResolvedValue({ state: 'ok', verdict: { schema: 1, class: 'personal', policy_version: 'v0', created: 0 } });
    const { classifySession } = await import('../classification.js');
    expect(await classifySession('k', record, { policy: { organizations: ['acme'], version: 'v1' }, capability: 'evidence' }))
      .toEqual({ action: 'hold', reason: 'verdict_unavailable' });
  });
});
