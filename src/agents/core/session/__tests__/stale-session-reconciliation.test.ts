/**
 * The start pass over other sessions' records, the own-record step and nextRecordStart.
 *
 * Seams: `reconcileOtherSessions` / `finalizeOwnRecord` / `nextRecordStart` over a temp
 * sessions dir (CODEMIE_HOME per test); the hook pipeline (processEvent, deliverSession) is the
 * boundary and is stubbed, the file renames are real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync, symlinkSync } from 'fs';
import * as fsPromises from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Session } from '../types.js';
import type { BaseHookEvent } from '../../types.js';
import type { HookProcessingConfig } from '@/cli/commands/hook.js';
import { boundedRequest, noteSendAttempt } from '@/providers/plugins/sso/session/bounded-request.js';
import { processStartedAt } from '@/utils/processes.js';
import { logger } from '@/utils/logger.js';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile), stat: vi.fn(actual.stat) };
});

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
    runWithContext: (_ctx: unknown, fn: () => unknown) => fn(),
  },
}));

vi.mock('@/providers/core/codemie-auth-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/providers/core/codemie-auth-helpers.js')>()),
  getStoredAnalyticsCredentials: vi.fn(async () => ({ credentials: { cookies: { session: 'abc' } } })),
}));

const {
  reconcileOtherSessions,
  finalizeOwnRecord,
  LEGACY_IDLE_MS,
  ABANDON_WAIT_MS,
} = await import('../stale-session-reconciliation.js');
const { nextRecordStart } = await import('../next-record-start.js');
const { processEvent } = await import('@/cli/commands/hook.js');

const HOUR = 60 * 60 * 1000;
const DEAD_PID = 999_999;
const HOST = 'https://codemie.example.com';

let home: string;
let sessionsDir: string;
const previousHome = process.env.CODEMIE_HOME;

/** This launch: same host, a send path through the proxy. */
const launchEnv: NodeJS.ProcessEnv = {
  CODEMIE_URL: HOST,
  CODEMIE_BASE_URL: 'http://127.0.0.1:4000',
  CODEMIE_TARGET_API_URL: 'https://codemie.example.com/code-assistant-api',
  CODEMIE_PROFILE_NAME: 'work',
  CODEMIE_CLI_VERSION: '9.9.9',
};

let uuidCounter = 0;
function uuid(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
}

function record(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: uuid(),
    agentName: 'claude',
    provider: 'ai-run-sso',
    startTime: Date.now() - HOUR,
    workingDirectory: '/repo',
    status: 'active',
    activeDurationMs: 0,
    codemieUrl: HOST,
    ownerPid: DEAD_PID,
    ownerStartedAt: Date.now() - 2 * HOUR,
    correlation: { status: 'matched', retryCount: 0, agentSessionId: 'native-1' },
    ...overrides,
  };
}

function save(session: Session, name = `${session.sessionId}.json`): string {
  const path = join(sessionsDir, name);
  writeFileSync(path, JSON.stringify(session));
  return path;
}

function load(sessionId: string, prefix = ''): Session {
  return JSON.parse(readFileSync(join(sessionsDir, `${prefix}${sessionId}.json`), 'utf-8')) as Session;
}

function pipeline(overrides: {
  processEvent?: (event: BaseHookEvent, config: HookProcessingConfig) => Promise<void>;
  deliverSession?: (sessionId: string, config: HookProcessingConfig) => Promise<void>;
} = {}) {
  return {
    processEvent: vi.fn(overrides.processEvent ?? (async () => {})),
    deliverSession: vi.fn(overrides.deliverSession ?? (async () => {})),
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'codemie-reconcile-'));
  process.env.CODEMIE_HOME = home;
  sessionsDir = join(home, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  vi.mocked(fsPromises.readFile).mockClear();
  vi.mocked(fsPromises.stat).mockClear();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('reconcileOtherSessions', () => {
  it('finalizes a stranded claude record once, as its own agent with its native id and this launch URL', async () => {
    const stranded = save(record({ correlation: { status: 'matched', retryCount: 0, agentSessionId: 'claude-native-7' } }));
    const id = JSON.parse(readFileSync(stranded, 'utf-8')).sessionId as string;
    const hook = pipeline();

    await reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: hook }).done;

    expect(hook.processEvent).toHaveBeenCalledTimes(1);
    const [event, config] = hook.processEvent.mock.calls[0];
    expect(event).toMatchObject({
      hook_event_name: 'SessionEnd',
      session_id: 'claude-native-7',
      reason: 'interrupted',
      endTimeFromActivity: true,
      cwd: '/repo',
    });
    expect(config).toMatchObject({ agentName: 'claude', sessionId: id, ssoUrl: HOST, apiBaseUrl: 'http://127.0.0.1:4000' });
    expect(load(id).finalizeAttempts).toBe(1);
    expect(existsSync(join(home, 'sessions', `${id}.reconcile.lock`))).toBe(false);
  });

  it('leaves a record whose owner is alive byte-identical', async () => {
    const live = record({ ownerPid: process.pid, ownerStartedAt: processStartedAt() });
    const path = save(live);
    const before = readFileSync(path, 'utf-8');
    const hook = pipeline();

    await reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: hook }).done;

    expect(hook.processEvent).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  // The start time comes from the real `ps`; Windows has none and isOwnerAlive is pid-only there by design
  it.skipIf(process.platform === 'win32')('finalizes a record whose pid is alive but belongs to a process with another start time', async () => {
    const reused = record({ ownerPid: process.pid, ownerStartedAt: Date.now() - 10 * 24 * HOUR });
    save(reused);
    const hook = pipeline();

    await reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: hook }).done;

    expect(hook.processEvent).toHaveBeenCalledTimes(1);
  });

  it('closes a Claude Desktop record of a dead daemon locally, keeps it as {id}.json, sends nothing', async () => {
    const start = Date.now() - 5 * HOUR;
    const desktop = record({
      agentName: 'claude-desktop',
      startTime: start,
      runtimeCheckpoint: { externalSessionId: 'x', transcriptPath: '/t', lastDiscoveredAt: start + 1000, lastSeenActivityAt: start + 60_000 },
    });
    save(desktop);
    const hook = pipeline();

    await reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: hook }).done;

    expect(hook.processEvent).not.toHaveBeenCalled();
    expect(hook.deliverSession).not.toHaveBeenCalled();
    const closed = load(desktop.sessionId);
    expect(closed).toMatchObject({ status: 'completed', reason: 'desktop-daemon-gone', endTime: start + 60_000, ownerPid: DEAD_PID });
  });

  it('closes a Claude Desktop record without startTime of a dead daemon with a finite endTime', async () => {
    const start = Date.now() - 5 * HOUR;
    const desktop = record({
      agentName: 'claude-desktop',
      runtimeCheckpoint: { externalSessionId: 'x', transcriptPath: '/t', lastDiscoveredAt: start + 1000, lastSeenActivityAt: start + 60_000 },
    });
    delete (desktop as Partial<Session>).startTime;
    save(desktop);

    await reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: pipeline() }).done;

    expect(load(desktop.sessionId)).toMatchObject({ status: 'completed', reason: 'desktop-daemon-gone', endTime: start + 60_000 });
  });

  it('delivers an undelivered record of this host once, with deliveryAttempts 1 saved before the call', async () => {
    const undelivered = record({ status: 'completed', endTime: Date.now() - HOUR / 2 });
    save(undelivered);
    let attemptsSeenByDelivery: number | undefined;
    const hook = pipeline({
      deliverSession: async (sessionId) => {
        attemptsSeenByDelivery = load(sessionId).deliveryAttempts;
      },
    });

    await reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: hook }).done;

    expect(hook.deliverSession).toHaveBeenCalledTimes(1);
    expect(attemptsSeenByDelivery).toBe(1);
  });

  it('leaves a completed record of a live owner untouched; one of a dead owner is delivered once', async () => {
    const ownedPath = save(record({ status: 'completed', ownerPid: process.pid, ownerStartedAt: processStartedAt() }));
    const before = readFileSync(ownedPath, 'utf-8');
    const orphan = record({ status: 'completed' });
    save(orphan);
    const hook = pipeline();

    await reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: hook }).done;

    expect(hook.deliverSession.mock.calls.map(([sessionId]) => sessionId)).toEqual([orphan.sessionId]);
    expect(readFileSync(ownedPath, 'utf-8')).toBe(before);
  });

  it('leaves an undelivered record of another host untouched', async () => {
    const path = save(record({ status: 'completed', codemieUrl: 'https://other.example.com' }));
    const before = readFileSync(path, 'utf-8');
    const hook = pipeline();

    await reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: hook }).done;

    expect(hook.deliverSession).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('finalizes a stranded record of another host locally: no URL in its config', async () => {
    save(record({ codemieUrl: 'https://other.example.com' }));
    const hook = pipeline();

    await reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: hook }).done;

    expect(hook.processEvent).toHaveBeenCalledTimes(1);
    const config = hook.processEvent.mock.calls[0][1];
    expect(config.localOnly).toBe(true);
    expect(config.ssoUrl).toBeUndefined();
  });

  it('renames a completed record without codemieUrl, sending nothing', async () => {
    const plain = record({ status: 'completed', codemieUrl: undefined });
    save(plain);
    const hook = pipeline();

    await reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: hook }).done;

    expect(hook.processEvent).not.toHaveBeenCalled();
    expect(hook.deliverSession).not.toHaveBeenCalled();
    expect(existsSync(join(sessionsDir, `${plain.sessionId}.json`))).toBe(false);
    expect(existsSync(join(sessionsDir, `completed_${plain.sessionId}.json`))).toBe(true);
  });

  it('finalizes a legacy record idle 73 h locally and renames it; one idle 71 h stays untouched', async () => {
    const old = record({ ownerPid: undefined, ownerStartedAt: undefined, startTime: Date.now() - 73 * HOUR });
    const young = record({ ownerPid: undefined, ownerStartedAt: undefined, startTime: Date.now() - 71 * HOUR });
    save(old);
    const youngPath = save(young);
    const youngBefore = readFileSync(youngPath, 'utf-8');
    const hook = pipeline();

    await reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: hook }).done;

    expect(LEGACY_IDLE_MS).toBe(72 * HOUR);
    expect(hook.processEvent).toHaveBeenCalledTimes(1);
    const [event, config] = hook.processEvent.mock.calls[0];
    expect(event.session_id).toBe('native-1');
    expect(config).toMatchObject({ sessionId: old.sessionId, localOnly: true });
    expect(config.ssoUrl).toBeUndefined();
    expect(hook.deliverSession).not.toHaveBeenCalled();
    expect(existsSync(join(sessionsDir, `completed_${old.sessionId}.json`))).toBe(true);
    expect(readFileSync(youngPath, 'utf-8')).toBe(youngBefore);
  });

  it('handles at most 5 of 7 candidates, newest first', async () => {
    const records = Array.from({ length: 7 }, (_, i) => record({ startTime: Date.now() - (i + 1) * HOUR }));
    records.forEach((r) => save(r));
    const hook = pipeline();

    await reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: hook }).done;

    const handled = hook.processEvent.mock.calls.map(([, config]) => config.sessionId);
    expect(handled).toEqual(records.slice(0, 5).map((r) => r.sessionId));
    expect(load(records[5].sessionId).finalizeAttempts).toBeUndefined();
    expect(load(records[6].sessionId).finalizeAttempts).toBeUndefined();
  });

  it('a launch with no send path (CODEMIE_BASE_URL an upstream LLM host, no proxy) spends no slot on undelivered records: an older stranded one is finalized locally', async () => {
    const undelivered = Array.from({ length: 5 }, (_, i) => record({ status: 'completed', startTime: Date.now() - (i + 1) * HOUR }));
    undelivered.forEach((r) => save(r));
    const stranded = record({ startTime: Date.now() - 10 * HOUR });
    save(stranded);
    const hook = pipeline();
    const noProxy = { CODEMIE_URL: HOST, CODEMIE_BASE_URL: 'https://litellm.example.com' };

    await reconcileOtherSessions({ env: noProxy, ownSessionId: 'own', pipeline: hook }).done;

    expect(hook.deliverSession).not.toHaveBeenCalled();
    expect(hook.processEvent.mock.calls.map(([, config]) => [config.sessionId, config.localOnly])).toEqual([[stranded.sessionId, true]]);
    expect(undelivered.map((r) => load(r.sessionId).deliveryAttempts)).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it('a stranded record whose transcript was deleted ends at its latest delta, is delivered and renamed', async () => {
    const start = Date.parse('2026-10-01T10:00:00Z');
    const stranded = record({
      startTime: start,
      correlation: { status: 'matched', retryCount: 0, agentSessionId: 'native-9', agentSessionFile: join(home, 'deleted.jsonl') },
    });
    save(stranded);
    const deltas = [start + 60_000, start + 300_000].map((timestamp, i) => JSON.stringify({
      recordId: `rec-${i}`, sessionId: stranded.sessionId, timestamp, syncStatus: 'synced', syncAttempts: 1,
    }));
    writeFileSync(join(sessionsDir, `${stranded.sessionId}_metrics.jsonl`), `${deltas.join('\n')}\n`);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ success: true, message: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    try {
      await reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: { processEvent } }).done;
    } finally {
      fetchSpy.mockRestore();
    }

    expect(existsSync(join(sessionsDir, `${stranded.sessionId}.json`))).toBe(false);
    expect(load(stranded.sessionId, 'completed_')).toMatchObject({ status: 'completed', reason: 'interrupted', endTime: start + 300_000 });
  });

  it('skips a record whose reconcile lock another live process holds', async () => {
    const locked = record();
    const path = save(locked);
    const before = readFileSync(path, 'utf-8');
    writeFileSync(join(sessionsDir, `${locked.sessionId}.reconcile.lock`), JSON.stringify({ pid: process.pid, startedAt: processStartedAt() }));
    const hook = pipeline();

    await reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: hook }).done;

    expect(hook.processEvent).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('ends an attempt whose server never answers 10 s after it started, releases its lock, handles the next record', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const hanging = record({ status: 'completed', startTime: Date.now() - HOUR });
      const next = record({ status: 'completed', startTime: Date.now() - 2 * HOUR });
      save(hanging);
      save(next);
      const lockPath = join(sessionsDir, `${hanging.sessionId}.reconcile.lock`);
      let entered!: () => void;
      const requestSent = new Promise<void>((resolve) => { entered = resolve; });
      let elapsedAtStop: number | undefined;
      let hangingLockAtNext: boolean | undefined;
      const passStartedAt = Date.now();
      const hook = pipeline({
        deliverSession: async (sessionId, config) => {
          if (sessionId !== hanging.sessionId) {
            hangingLockAtNext = existsSync(lockPath);
            return;
          }
          // The server never answers: the request ends only when its bounds abort it
          const request = boundedRequest(60_000, { deadlineMs: config.deadlineMs, abortSignal: config.abortSignal });
          entered();
          await new Promise((resolve) => request.signal.addEventListener('abort', resolve, { once: true }));
          request.dispose();
          elapsedAtStop = Date.now() - passStartedAt;
        },
      });

      const pass = reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: hook });
      await requestSent;
      await vi.advanceTimersByTimeAsync(60_000);
      await pass.done;

      expect(elapsedAtStop).toBe(10_000);
      expect(hangingLockAtNext).toBe(false);
      expect(hook.deliverSession.mock.calls.map(([sessionId]) => sessionId)).toEqual([hanging.sessionId, next.sessionId]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('finalizes a record past its 3rd attempt without the flush', async () => {
    const transcript = join(home, 'transcript.jsonl');
    writeFileSync(transcript, '{}\n');
    save(record({ finalizeAttempts: 3, correlation: { status: 'matched', retryCount: 0, agentSessionId: 'n', agentSessionFile: transcript } }));
    const hook = pipeline();

    await reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: hook }).done;

    expect(hook.processEvent).toHaveBeenCalledTimes(1);
    expect(hook.processEvent.mock.calls[0][0].transcript_path).toBe('');
  });

  it('closes locally a record whose finalize still fails past its 3rd attempt; the next pass reaches an older record', async () => {
    const start = Date.parse('2026-10-01T10:00:00Z');
    const failing = Array.from({ length: 5 }, (_, i) =>
      record({ startTime: start + i * HOUR, activityStartedAt: start + i * HOUR + 60_000, finalizeAttempts: 3 }));
    failing.forEach((r) => save(r));
    const older = record({ startTime: start - HOUR });
    save(older);
    const failingIds = failing.map((r) => r.sessionId);
    const hook = pipeline({
      processEvent: async (_event, config) => {
        if (failingIds.includes(config.sessionId)) throw new Error('metrics file unwritable');
      },
    });

    await reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: hook }).done;
    await reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: hook }).done;

    expect(hook.processEvent.mock.calls.map(([, config]) => config.sessionId).at(-1)).toBe(older.sessionId);
    expect(failing.map((r) => existsSync(join(sessionsDir, `${r.sessionId}.json`)))).toEqual([false, false, false, false, false]);
    expect(hook.deliverSession).not.toHaveBeenCalled();
    expect(load(failing[0].sessionId, 'completed_')).toMatchObject({
      status: 'completed', reason: 'interrupted', endTime: Date.parse('2026-10-01T10:01:00Z'), finalizeAttempts: 4,
    });
  });

  it('a finalize failing past its 3rd attempt marks a record of this host dropped; one of another host closed locally by design is not', async () => {
    const own = record({ finalizeAttempts: 3 });
    const foreign = record({ finalizeAttempts: 3, codemieUrl: 'https://other.example.com' });
    save(own);
    save(foreign);
    const hook = pipeline({ processEvent: async () => { throw new Error('metrics file unwritable'); } });
    const before = Date.now();

    await reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: hook }).done;

    expect(load(own.sessionId, 'completed_').droppedAt).toBeGreaterThanOrEqual(before);
    expect(load(foreign.sessionId, 'completed_')).toMatchObject({ status: 'completed', reason: 'interrupted' });
    expect(load(foreign.sessionId, 'completed_').droppedAt).toBeUndefined();
  });

  it('a pass abandoned during an attempt that sent nothing rolls the counter back; the lock goes once the attempt stops', async () => {
    const stranded = record({ finalizeAttempts: 1 });
    save(stranded);
    const lockPath = join(sessionsDir, `${stranded.sessionId}.reconcile.lock`);
    let pass: ReturnType<typeof reconcileOtherSessions> | undefined;
    let holderAfterAbandon: number | undefined;
    const hook = pipeline({
      processEvent: async () => {
        await pass!.abandon();
        // The attempt is still running: its lock is still this process's
        holderAfterAbandon = (JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number }).pid;
      },
    });

    pass = reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: hook });
    await pass.done;

    expect(holderAfterAbandon).toBe(process.pid);
    expect(load(stranded.sessionId).finalizeAttempts).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('abandon during an attempt still saving leaves the record to the attempt: its write lands, its rollback is the one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stranded = record({ finalizeAttempts: 1 });
      save(stranded);
      let pass: ReturnType<typeof reconcileOtherSessions> | undefined;
      let entered!: () => void;
      const abandonCalled = new Promise<void>((resolve) => { entered = resolve; });
      let counterWhileSaving: number | undefined;
      const hook = pipeline({
        processEvent: async (_event, config) => {
          const abandoning = pass!.abandon();
          entered();
          await abandoning;
          // The attempt's own status save, after the exit step gave up waiting for it
          const current = load(config.sessionId);
          counterWhileSaving = current.finalizeAttempts;
          save({ ...current, status: 'completed', endTime: current.startTime + 1000 });
        },
      });

      pass = reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: hook });
      await abandonCalled;
      await vi.advanceTimersByTimeAsync(ABANDON_WAIT_MS);
      await pass.done;

      expect(counterWhileSaving).toBe(2);
      expect(load(stranded.sessionId)).toMatchObject({ status: 'completed', endTime: stranded.startTime + 1000, finalizeAttempts: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('an abandoned pass keeps the counter of the record whose send ran, and never reaches the others', async () => {
    const records = [0, 1, 2].map((i) => record({ startTime: Date.now() - (i + 1) * HOUR }));
    records.forEach((r) => save(r));
    let pass: ReturnType<typeof reconcileOtherSessions> | undefined;
    const hook = pipeline({
      processEvent: async (_event, config) => {
        noteSendAttempt(config.abortSignal);
        await pass!.abandon();
      },
    });

    pass = reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: hook });
    await pass.done;

    expect(hook.processEvent).toHaveBeenCalledTimes(1);
    expect(load(records[0].sessionId).finalizeAttempts).toBe(1);
    expect(load(records[1].sessionId).finalizeAttempts).toBeUndefined();
    expect(load(records[2].sessionId).finalizeAttempts).toBeUndefined();
    expect(readdirSync(sessionsDir).filter((name) => name.endsWith('.reconcile.lock'))).toEqual([]);
  });

  it('two passes started together on one stranded record finalize it once', async () => {
    const stranded = record();
    save(stranded);
    const finalizeAndRename = async (_event: BaseHookEvent, config: HookProcessingConfig) => {
      await new Promise((resolve) => setImmediate(resolve));
      const done = { ...load(config.sessionId), status: 'completed' as const };
      writeFileSync(join(sessionsDir, `completed_${config.sessionId}.json`), JSON.stringify(done));
      rmSync(join(sessionsDir, `${config.sessionId}.json`));
    };
    const first = pipeline({ processEvent: finalizeAndRename });
    const second = pipeline({ processEvent: finalizeAndRename });

    await Promise.all([
      reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: first }).done,
      reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: second }).done,
    ]);

    expect(first.processEvent.mock.calls.length + second.processEvent.mock.calls.length).toBe(1);
    expect(first.deliverSession.mock.calls.length + second.deliverSession.mock.calls.length).toBe(0);
  });

  it('never parses markers, completed_ records, generation names or temp files', async () => {
    const id = uuid();
    for (const name of [
      'abc-codemie-marker.json',
      `completed_${id}.json`,
      `${id}-gen.json`,
      `${id}.json.123.ab12.tmp`,
    ]) {
      writeFileSync(join(sessionsDir, name), JSON.stringify(record({ sessionId: id })));
    }

    await reconcileOtherSessions({ env: launchEnv, ownSessionId: 'own', pipeline: pipeline() }).done;

    const read = vi.mocked(fsPromises.readFile).mock.calls.map(([path]) => String(path));
    expect(read.filter((path) => path.startsWith(sessionsDir))).toEqual([]);
  });
});

describe('finalizeOwnRecord', () => {
  it('ends an own record still active through the synthetic end', async () => {
    const own = record({ ownerPid: process.pid, ownerStartedAt: processStartedAt() });
    save(own);
    const hook = pipeline();

    await finalizeOwnRecord(own.sessionId, { env: launchEnv, deadlineMs: Date.now() + 10_000, pipeline: hook });

    expect(hook.processEvent).toHaveBeenCalledTimes(1);
    expect(hook.processEvent.mock.calls[0][0]).toMatchObject({ endTimeFromActivity: true, session_id: 'native-1' });
  });

  it('delivers an own completed but undelivered record and counts the attempt', async () => {
    const own = record({ status: 'completed', ownerPid: process.pid });
    save(own);
    const hook = pipeline();

    await finalizeOwnRecord(own.sessionId, { env: launchEnv, deadlineMs: Date.now() + 10_000, pipeline: hook });

    expect(hook.deliverSession).toHaveBeenCalledTimes(1);
    expect(load(own.sessionId).deliveryAttempts).toBe(1);
  });

  it('leaves an own completed record undelivered when the launch has no send path: no delivery, no attempt counted', async () => {
    const own = record({ status: 'completed', ownerPid: process.pid });
    save(own);
    const hook = pipeline();

    await finalizeOwnRecord(own.sessionId, {
      env: { CODEMIE_URL: HOST, CODEMIE_BASE_URL: 'https://litellm.example.com' },
      deadlineMs: Date.now() + 10_000,
      pipeline: hook,
    });

    expect(hook.deliverSession).not.toHaveBeenCalled();
    expect(load(own.sessionId).deliveryAttempts).toBeUndefined();
  });

  it('does nothing for an own record already completed_', async () => {
    const own = record({ status: 'completed' });
    save(own, `completed_${own.sessionId}.json`);
    const hook = pipeline();

    await finalizeOwnRecord(own.sessionId, { env: launchEnv, deadlineMs: Date.now() + 10_000, pipeline: hook });

    expect(hook.processEvent).not.toHaveBeenCalled();
    expect(hook.deliverSession).not.toHaveBeenCalled();
  });

  it('waits for a held lock, then re-checks: the holder finished the record, nothing is left to do', async () => {
    const own = record({ ownerPid: process.pid });
    save(own);
    const lockPath = join(sessionsDir, `${own.sessionId}.reconcile.lock`);
    // A holder from another process (a pid that is alive: this one, with its real start time)
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: processStartedAt() }));
    const hook = pipeline();

    const step = finalizeOwnRecord(own.sessionId, { env: launchEnv, deadlineMs: Date.now() + 5_000, pipeline: hook });
    await vi.waitFor(() => expect(vi.mocked(fsPromises.readFile).mock.calls.some(([p]) => String(p) === lockPath)).toBe(true));
    // The holder finalizes and renames the record, then releases its lock
    writeFileSync(join(sessionsDir, `completed_${own.sessionId}.json`), JSON.stringify({ ...own, status: 'completed' }));
    rmSync(join(sessionsDir, `${own.sessionId}.json`));
    rmSync(lockPath);
    await step;

    expect(hook.processEvent).not.toHaveBeenCalled();
    expect(hook.deliverSession).not.toHaveBeenCalled();
  });

  it('gives up at the deadline when the lock stays held', async () => {
    const own = record({ ownerPid: process.pid });
    save(own);
    writeFileSync(join(sessionsDir, `${own.sessionId}.reconcile.lock`), JSON.stringify({ pid: process.pid, startedAt: processStartedAt() }));
    const hook = pipeline();
    const startedAt = Date.now();

    await finalizeOwnRecord(own.sessionId, { env: launchEnv, deadlineMs: startedAt + 150, pipeline: hook });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);
    expect(hook.processEvent).not.toHaveBeenCalled();
  });

  it('with no sessions folder yet, takes its lock and finds nothing to do', async () => {
    rmSync(sessionsDir, { recursive: true });
    vi.mocked(logger.error).mockClear();
    const hook = pipeline();

    await expect(finalizeOwnRecord(uuid(), { env: launchEnv, deadlineMs: Date.now() + 1_000, pipeline: hook })).resolves.toBeUndefined();

    expect(logger.error).not.toHaveBeenCalled();
    expect(hook.processEvent).not.toHaveBeenCalled();
  });
});

describe('nextRecordStart', () => {
  const transcript = '/transcripts/a.jsonl';

  function claudeRecord(startTime: number, file: string): Session {
    return record({ startTime, ownerPid: process.pid, correlation: { status: 'matched', retryCount: 0, agentSessionFile: file } });
  }

  it('gives a record the start of the later record over the same transcript; the later one gets none', async () => {
    const t0 = Date.now() - 3 * HOUR;
    const earlier = claudeRecord(t0, transcript);
    const later = claudeRecord(t0 + HOUR, transcript);
    const unrelated = claudeRecord(t0 + 30 * 60 * 1000, '/transcripts/b.jsonl');
    save(earlier);
    save(later, `completed_${later.sessionId}.json`);
    save(unrelated);

    expect(await nextRecordStart(earlier)).toBe(t0 + HOUR);
    expect(await nextRecordStart(later)).toBeUndefined();
  });

  it('is bounded by a later record saved under a /clear generation name', async () => {
    const t0 = Date.now() - 3 * HOUR;
    const stranded = claudeRecord(t0, '/transcripts/cleared.jsonl');
    const later = claudeRecord(t0 + HOUR, '/transcripts/cleared.jsonl');
    save(stranded);
    save(later, `completed_${later.sessionId}-native-gen-1.json`);

    expect(await nextRecordStart(stranded)).toBe(t0 + HOUR);
  });

  it('gives a stranded claude-acp record the start of the later record over the same transcript', async () => {
    const t0 = Date.now() - 3 * HOUR;
    const stranded = { ...claudeRecord(t0, '/transcripts/acp.jsonl'), agentName: 'claude-acp' };
    const later = claudeRecord(t0 + HOUR, '/transcripts/acp.jsonl');
    save(stranded);
    save(later);

    expect(await nextRecordStart(stranded)).toBe(t0 + HOUR);
  });

  it('never stats or parses a marker file', async () => {
    const earlier = claudeRecord(Date.now() - HOUR, '/transcripts/c.jsonl');
    save(earlier);
    const marker = join(sessionsDir, 'deadbeef-codemie-marker.json');
    writeFileSync(marker, '{}');

    await nextRecordStart(earlier);

    expect(vi.mocked(fsPromises.stat).mock.calls.map(([p]) => String(p))).not.toContain(marker);
    expect(vi.mocked(fsPromises.readFile).mock.calls.map(([p]) => String(p))).not.toContain(marker);
  });

  it('parses a file again only when its mtime changed', async () => {
    const t0 = Date.now() - 3 * HOUR;
    const earlier = claudeRecord(t0, '/transcripts/d.jsonl');
    const later = claudeRecord(t0 + HOUR, '/transcripts/d.jsonl');
    const other = claudeRecord(t0 + 2 * HOUR, '/transcripts/e.jsonl');
    save(earlier);
    const laterPath = save(later);
    const otherPath = save(other);

    await nextRecordStart(earlier);
    vi.mocked(fsPromises.readFile).mockClear();
    const touched = new Date(Date.now() + 5_000);
    utimesSync(otherPath, touched, touched);
    await nextRecordStart(earlier);

    const reparsed = vi.mocked(fsPromises.readFile).mock.calls.map(([p]) => String(p));
    expect(reparsed).toContain(otherPath);
    expect(reparsed).not.toContain(laterPath);
  });

  it('bounds a copilot-cli record by the later one of the same native session; an unknown id bounds nothing', async () => {
    const t0 = Date.now() - 3 * HOUR;
    const copilot = (startTime: number, agentSessionId: string) =>
      record({ agentName: 'copilot-cli', startTime, ownerPid: process.pid, correlation: { status: 'matched', retryCount: 0, agentSessionId } });
    const earlier = copilot(t0, 'copilot-native-1');
    const unknown = copilot(t0, 'unknown');
    [earlier, unknown, copilot(t0 + HOUR, 'copilot-native-1'), copilot(t0 + 30 * 60 * 1000, 'copilot-native-2'), copilot(t0 + 20 * 60 * 1000, 'unknown')]
      .forEach((r) => save(r));

    expect(await nextRecordStart(earlier)).toBe(t0 + HOUR);
    expect(await nextRecordStart(unknown)).toBeUndefined();
  });

  it.each(['opencode', 'codemie-code'])('bounds a %s record by the later one in the same directory reached through a symlink', async (agentName) => {
    const t0 = Date.now() - 3 * HOUR;
    const repo = join(home, 'repo');
    const other = join(home, 'other');
    mkdirSync(repo);
    mkdirSync(other);
    symlinkSync(repo, join(home, 'repo-link'));
    const earlier = record({ agentName, startTime: t0, ownerPid: process.pid, workingDirectory: repo });
    save(earlier);
    save(record({ agentName, startTime: t0 + HOUR, ownerPid: process.pid, workingDirectory: join(home, 'repo-link') }));
    save(record({ agentName, startTime: t0 + 30 * 60 * 1000, ownerPid: process.pid, workingDirectory: other }));
    save(record({ agentName: 'claude', startTime: t0 + 20 * 60 * 1000, ownerPid: process.pid, workingDirectory: repo }));

    expect(await nextRecordStart(earlier)).toBe(t0 + HOUR);
  });

  it('bounds a pi record by the later one whose run ledger shares a transcript', async () => {
    const t0 = Date.now() - 3 * HOUR;
    const shared = join(home, 'pi-shared.jsonl');
    const own = join(home, 'pi-own.jsonl');
    writeFileSync(shared, '{}\n');
    writeFileSync(own, '{}\n');
    const pi = (startTime: number, transcripts: string[]) => {
      const r = record({ agentName: 'pi', startTime, ownerPid: process.pid });
      save(r);
      const ledger = transcripts.map((file) => JSON.stringify({ t: 'session', file }));
      writeFileSync(join(sessionsDir, `${r.sessionId}_pi-run.jsonl`), `${ledger.join('\n')}\n`);
      return r;
    };
    const earlier = pi(t0, [shared]);
    pi(t0 + 30 * 60 * 1000, [own]);
    pi(t0 + HOUR, [shared, own]);

    expect(await nextRecordStart(earlier)).toBe(t0 + HOUR);
  });

  it('sees a transcript a later pi record\'s run ledger gained after the first lookup', async () => {
    const t0 = Date.now() - 3 * HOUR;
    const shared = join(home, 'pi-late.jsonl');
    writeFileSync(shared, '{}\n');
    const earlier = record({ agentName: 'pi', startTime: t0, ownerPid: process.pid });
    const later = record({ agentName: 'pi', startTime: t0 + HOUR, ownerPid: process.pid });
    save(earlier);
    save(later);
    writeFileSync(join(sessionsDir, `${earlier.sessionId}_pi-run.jsonl`), `${JSON.stringify({ t: 'session', file: shared })}\n`);

    expect(await nextRecordStart(earlier)).toBeUndefined();

    // The later run links the transcript: only its ledger grows, its record file is not rewritten.
    writeFileSync(join(sessionsDir, `${later.sessionId}_pi-run.jsonl`), `${JSON.stringify({ t: 'session', file: shared })}\n`);
    expect(await nextRecordStart(earlier)).toBe(t0 + HOUR);
  });
});
