/**
 * Backend 503 hold lifecycle: its own delivery reason, a single original clock and a reported expiry (the forwarder
 * then stops the session with hold_expired). Real spool files and status; only Date, the daemon state and the logger are faked.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ root: '' }));

vi.mock('../spool-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../spool-paths.js')>();
  const { join: pathJoin } = await import('node:path');
  return {
    ...actual,
    spoolRoot: (): string => state.root,
    streamFile: (sessionId: string, stream: string): string => pathJoin(state.root, `${sessionId}.${stream}`),
    statusFile: (sessionId: string): string => pathJoin(state.root, sessionId + '.status'),
  };
});
vi.mock('@/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const SESSION = 'sess-h';
const T0 = Date.UTC(2026, 10, 3, 9);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const LINE = JSON.stringify({ agentName: 'claude-code-otlp', hookEvent: JSON.stringify({ type: 'agent.tool.end', session_id: SESSION, codemie_project_name: 'A' }) }) + '\n';
const range = { cursor: 0, end: Buffer.byteLength(LINE) };
const hold = { kind: 'retry', reason: 'http_503', detail: 'project_unavailable', hold: true } as const;
const ordinary = { kind: 'retry', reason: 'http_503', detail: 'default_project_unavailable' } as const;

describe('backend 503 hold lifecycle', () => {
  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), 'otlp-hold-'));
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const { appendSpool } = await import('../spool-io.js');
    await appendSpool(SESSION, 'hooks', LINE, ['A']);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(state.root, { recursive: true, force: true });
  });

  it('a hold outcome is its own delivery reason; an ordinary 503 detail is not', async () => {
    const { deliveryFailureOf } = await import('../delivery-state.js');
    expect(deliveryFailureOf(hold)).toEqual({ reason: 'destination_hold', detail: 'project_unavailable' });
    expect(deliveryFailureOf(ordinary)).toEqual({ reason: 'destination_unavailable', detail: 'default_project_unavailable' });
  });

  it('the request crossing the original bound reports the expiry once; a changing reason does not restart the clock', async () => {
    const { recordUnacknowledged } = await import('../delivery-state.js');
    const { readStatus } = await import('../session-status.js');
    const expired = vi.fn(async () => true);
    await recordUnacknowledged(SESSION, 'hooks', hold, range, expired);
    vi.setSystemTime(T0 + DAY / 2);
    await recordUnacknowledged(SESSION, 'hooks', ordinary, range, expired);
    expect(expired).not.toHaveBeenCalled();
    vi.setSystemTime(T0 + DAY + MIN);
    await recordUnacknowledged(SESSION, 'hooks', hold, range, expired);
    expect(expired).toHaveBeenCalledTimes(1);
    expect((await readStatus(SESSION))?.lastLoss).toMatchObject({ reason: 'destination_hold', detail: 'project_unavailable' });
  });

  it('an ordinary 503 expiry never reports a hold expiry', async () => {
    const { recordUnacknowledged } = await import('../delivery-state.js');
    const expired = vi.fn(async () => true);
    await recordUnacknowledged(SESSION, 'hooks', ordinary, range, expired);
    vi.setSystemTime(T0 + DAY + MIN);
    await recordUnacknowledged(SESSION, 'hooks', ordinary, range, expired);
    expect(expired).not.toHaveBeenCalled();
  });

  it('the gate before a request also reports an expired hold', async () => {
    const { recordUnacknowledged, deliveryGate } = await import('../delivery-state.js');
    await recordUnacknowledged(SESSION, 'hooks', hold, range);
    const expired = vi.fn(async () => true);
    expect(await deliveryGate(SESSION, 'hooks', T0 + MIN, expired)).toBe('wait');
    expect(expired).not.toHaveBeenCalled();
    expect(await deliveryGate(SESSION, 'hooks', T0 + DAY + MIN, expired)).toBe('go');
    expect(expired).toHaveBeenCalledTimes(1);
  });
});
