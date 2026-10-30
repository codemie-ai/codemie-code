import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { BaseAgentAdapter } from '../BaseAgentAdapter.js';
import { resetOutputStreamGuardForTests } from '../signal-handlers.js';
import type { AgentMetadata } from '../types.js';
import type { CodeMieProxy } from '../../../providers/plugins/sso/index.js';
import { logger } from '../../../utils/logger.js';
import { executeAfterRun, executeBeforeRun } from '../lifecycle-helpers.js';
import { finalizeOwnRecord } from '../session/stale-session-reconciliation.js';
import { noticeDeliveryAtExit } from '../session/exit-notice.js';

const FAKE_CHILD_PID = 4242;

// What happened, in order: the forwarded kills, the session-end hook, the proxy stop.
const { events, exitSignals, exitDeadlines, startPass } = vi.hoisted(() => ({
  events: [] as string[],
  // CODEMIE_EXIT_SIGNAL as each onSessionEnd call saw it.
  exitSignals: [] as (string | undefined)[],
  // CODEMIE_EXIT_DEADLINE_MS as each onSessionEnd call saw it.
  exitDeadlines: [] as (string | undefined)[],
  // The start pass the next run() gets; settled at once unless a test replaces `done`.
  startPass: { done: Promise.resolve(), abandon: async () => {} } as { done: Promise<void>; abandon: () => Promise<void> },
}));

vi.mock('../session/stale-session-reconciliation.js', () => ({
  EXIT_DEADLINE_ENV: 'CODEMIE_EXIT_DEADLINE_MS',
  reconcileOtherSessions: vi.fn(() => startPass),
  finalizeOwnRecord: vi.fn(() => Promise.resolve()),
}));

vi.mock('../session/exit-notice.js', () => ({
  noticeDeliveryAtExit: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../providers/core/registry.js', () => ({
  ProviderRegistry: {
    registerProvider: vi.fn((t: unknown) => t),
    registerSetupSteps: vi.fn(),
    registerHealthCheck: vi.fn(),
    registerModelProxy: vi.fn(),
    getProvider: vi.fn(() => undefined),
    getProviderNames: vi.fn(() => []),
  },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    setSessionId: vi.fn(),
    setAgentName: vi.fn(),
    setProfileName: vi.fn(),
  },
}));

vi.mock('../../../utils/processes.js', () => ({
  detectGitBranch: vi.fn(() => Promise.resolve(null)),
  detectGitRemoteRepo: vi.fn(() => Promise.resolve(null)),
  exec: vi.fn(),
  installGlobal: vi.fn(),
  uninstallGlobal: vi.fn(),
  getCommandPath: vi.fn(() => Promise.resolve(null)),
  processStartedAt: vi.fn(() => 1_700_000_123_456),
  WRAPPER_PID_ENV: 'CODEMIE_WRAPPER_PID',
  WRAPPER_STARTED_AT_ENV: 'CODEMIE_WRAPPER_STARTED_AT',
  signalTree: vi.fn((pid: number, signal: NodeJS.Signals) => {
    events.push(`kill:${signal}`);
    expect(pid).toBe(FAKE_CHILD_PID);
  }),
}));

vi.mock('../../../cli/commands/skills/setup/sync.js', () => ({
  syncRegisteredSkills: vi.fn(() => Promise.resolve()),
}));

vi.mock('../lifecycle-helpers.js', () => ({
  executeOnSessionStart: vi.fn(() => Promise.resolve()),
  executeBeforeRun: vi.fn((_adapter: unknown, _lifecycle: unknown, _name: unknown, env: unknown) => Promise.resolve(env)),
  executeEnrichArgs: vi.fn((_lifecycle: unknown, _name: unknown, args: unknown) => Promise.resolve(args)),
  executeOnSessionEnd: vi.fn(
    (_adapter: unknown, _lifecycle: unknown, _name: unknown, _code: unknown, env: NodeJS.ProcessEnv) => {
      events.push('onSessionEnd');
      exitSignals.push(env.CODEMIE_EXIT_SIGNAL);
      exitDeadlines.push(env.CODEMIE_EXIT_DEADLINE_MS);
      return Promise.resolve();
    }
  ),
  executeAfterRun: vi.fn(() => Promise.resolve()),
}));

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: vi.fn(),
}));

class FakeChild extends EventEmitter {
  pid = FAKE_CHILD_PID;
  // Only the win32 path kills the child directly; POSIX signals its tree.
  kill = vi.fn((signal?: NodeJS.Signals) => {
    events.push(`kill:${signal ?? 'default'}`);
    return true;
  });
}

/** An adapter whose proxy is a stub that records its stop. */
const proxyStopBounds: Array<{ deadlineMs?: number } | undefined> = [];

class ProxiedAdapter extends BaseAgentAdapter {
  protected async setupProxy(): Promise<void> {
    this.proxy = {
      stop: async (bounds?: { deadlineMs?: number }) => {
        events.push('proxyStop');
        proxyStopBounds.push(bounds);
      },
    } as unknown as CodeMieProxy;
  }
}

const metadata: AgentMetadata = {
  name: 'signal-agent',
  displayName: 'Signal Agent',
  description: 'Agent for signal tests',
  npmPackage: null,
  cliCommand: 'signal-agent-bin',
  envMapping: {},
  supportedProviders: [],
  silentMode: true,
};

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
type ForwardedSignal = (typeof SIGNALS)[number];

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code });
}

describe('BaseAgentAdapter.run signals and output streams', () => {
  let child: FakeChild;
  let platformSpy: ReturnType<typeof vi.spyOn>;
  let listenersBefore: Record<ForwardedSignal, ReturnType<typeof process.listeners>>;
  let outputListenersBefore: [ReturnType<typeof process.stdout.listeners>, ReturnType<typeof process.stderr.listeners>];
  const envBefore = { ...process.env };

  /** The handler run() registered for a signal, called the way Node calls it. */
  function signalHandler(signal: ForwardedSignal): (signal: NodeJS.Signals) => void {
    const added = process.listeners(signal).filter((listener) => !listenersBefore[signal].includes(listener));
    expect(added).toHaveLength(1);
    return added[0] as (signal: NodeJS.Signals) => void;
  }

  function addedListenerCount(signal: ForwardedSignal): number {
    return process.listeners(signal).filter((listener) => !listenersBefore[signal].includes(listener)).length;
  }

  /** Starts run() and waits for the spawn; the timers that follow are fake. */
  async function startRun(adapter: BaseAgentAdapter = new ProxiedAdapter(metadata)): Promise<{ running: Promise<void> }> {
    const running = adapter.run([], {});
    running.catch(() => undefined);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    vi.useFakeTimers();
    return { running };
  }

  beforeEach(() => {
    events.length = 0;
    exitSignals.length = 0;
    exitDeadlines.length = 0;
    proxyStopBounds.length = 0;
    startPass.done = Promise.resolve();
    startPass.abandon = async () => {};
    vi.clearAllMocks();
    child = new FakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    listenersBefore = {
      SIGINT: process.listeners('SIGINT'),
      SIGTERM: process.listeners('SIGTERM'),
      SIGHUP: process.listeners('SIGHUP'),
    };
    outputListenersBefore = [process.stdout.listeners('error'), process.stderr.listeners('error')];
  });

  afterEach(() => {
    vi.useRealTimers();
    platformSpy.mockRestore();
    vi.restoreAllMocks();
    for (const signal of SIGNALS) {
      for (const listener of process.listeners(signal)) {
        if (!listenersBefore[signal].includes(listener)) {
          process.off(signal, listener as (signal: NodeJS.Signals) => void);
        }
      }
    }
    // run() never restores the output-stream listeners; the test puts back the runner's own.
    resetOutputStreamGuardForTests();
    [process.stdout, process.stderr].forEach((stream, index) => {
      stream.removeAllListeners('error');
      for (const listener of outputListenersBefore[index]) {
        stream.on('error', listener as (error: Error) => void);
      }
    });
    for (const key of Object.keys(process.env)) {
      if (!(key in envBefore)) {
        delete process.env[key];
      }
    }
  });

  describe('forwarding (POSIX)', () => {
    it('forwards SIGTERM before any cleanup, then ends the session and stops the proxy once', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const { running } = await startRun();

      signalHandler('SIGTERM')('SIGTERM');
      expect(events).toEqual(['kill:SIGTERM']);

      child.emit('exit', null, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(running).rejects.toThrow('Signal Agent exited with code null');

      expect(events).toEqual(['kill:SIGTERM', 'onSessionEnd', 'proxyStop']);
      expect(exitSignals).toEqual(['SIGTERM']);

      // The child exited inside the fallback window: the fallback never fires.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(events).toEqual(['kill:SIGTERM', 'onSessionEnd', 'proxyStop']);
      expect(exitSpy).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('kills the child 10 s after an ignored SIGTERM, then finalizes on its exit and exits with 143', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      await startRun();

      signalHandler('SIGTERM')('SIGTERM');
      await vi.advanceTimersByTimeAsync(9_999);
      expect(events).toEqual(['kill:SIGTERM']);

      // The fallback only kills: the proxy stays up and the wrapper does not exit yet.
      await vi.advanceTimersByTimeAsync(1);
      expect(events).toEqual(['kill:SIGTERM', 'kill:SIGKILL']);
      expect(exitSpy).not.toHaveBeenCalled();

      child.emit('exit', null, 'SIGKILL');
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(143));
      expect(events).toEqual(['kill:SIGTERM', 'kill:SIGKILL', 'onSessionEnd', 'proxyStop']);
      expect(exitSignals).toEqual(['SIGTERM']);
    });

    it('kills the child 10 s after an ignored SIGHUP, then finalizes on its exit and exits with 129', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      await startRun();

      signalHandler('SIGHUP')('SIGHUP');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(events).toEqual(['kill:SIGHUP', 'kill:SIGKILL']);
      expect(exitSpy).not.toHaveBeenCalled();

      child.emit('exit', null, 'SIGKILL');
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(129));
      expect(events).toEqual(['kill:SIGHUP', 'kill:SIGKILL', 'onSessionEnd', 'proxyStop']);
      expect(exitSignals).toEqual(['SIGHUP']);
    });

    it('rejects on a child error after SIGTERM and leaves no fallback, no exit and no signal listener', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const { running } = await startRun();

      signalHandler('SIGTERM')('SIGTERM');
      child.emit('error', new Error('spawn failed'));
      await expect(running).rejects.toThrow('Failed to start Signal Agent: spawn failed');

      await vi.advanceTimersByTimeAsync(15_000);
      expect(events).toEqual(['kill:SIGTERM', 'onSessionEnd', 'proxyStop']);
      expect(exitSpy).not.toHaveBeenCalled();
      expect(SIGNALS.map(addedListenerCount)).toEqual([0, 0, 0]);
    });

    it('forwards SIGINT and arms no fallback: the proxy stays up while the child keeps running', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const { running } = await startRun();

      signalHandler('SIGINT')('SIGINT');
      expect(events).toEqual(['kill:SIGINT']);
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(events).toEqual(['kill:SIGINT']);
      expect(exitSpy).not.toHaveBeenCalled();

      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(2_000);
      await running;
    });

    it('forwards two SIGINTs 15 s apart and arms no fallback: each is a separate turn interrupt', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const { running } = await startRun();

      signalHandler('SIGINT')('SIGINT');
      await vi.advanceTimersByTimeAsync(15_000);
      signalHandler('SIGINT')('SIGINT');
      expect(events).toEqual(['kill:SIGINT', 'kill:SIGINT']);
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(20_000);
      expect(events).toEqual(['kill:SIGINT', 'kill:SIGINT']);
      expect(exitSpy).not.toHaveBeenCalled();

      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(2_000);
      await running;
    });

    it('arms the fallback from a SIGTERM that follows a SIGINT and exits with 143 after the kill 10 s after the SIGTERM', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      await startRun();

      signalHandler('SIGINT')('SIGINT');
      await vi.advanceTimersByTimeAsync(5_000);
      signalHandler('SIGTERM')('SIGTERM');
      await vi.advanceTimersByTimeAsync(9_999);
      expect(events).toEqual(['kill:SIGINT', 'kill:SIGTERM']);

      await vi.advanceTimersByTimeAsync(1);
      expect(events).toEqual(['kill:SIGINT', 'kill:SIGTERM', 'kill:SIGKILL']);
      expect(exitSpy).not.toHaveBeenCalled();

      child.emit('exit', null, 'SIGKILL');
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(143));
      expect(events).toEqual(['kill:SIGINT', 'kill:SIGTERM', 'kill:SIGKILL', 'onSessionEnd', 'proxyStop']);
    });

    it('arms the fallback from a SIGINT 1 s after the previous one and exits with 130 after the kill 10 s after it', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      await startRun();

      signalHandler('SIGINT')('SIGINT');
      await vi.advanceTimersByTimeAsync(1_000);
      signalHandler('SIGINT')('SIGINT');
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(events).toEqual(['kill:SIGINT', 'kill:SIGINT']);

      await vi.advanceTimersByTimeAsync(1);
      expect(events).toEqual(['kill:SIGINT', 'kill:SIGINT', 'kill:SIGKILL']);
      expect(exitSpy).not.toHaveBeenCalled();

      child.emit('exit', null, 'SIGKILL');
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130));
      expect(events).toEqual(['kill:SIGINT', 'kill:SIGINT', 'kill:SIGKILL', 'onSessionEnd', 'proxyStop']);
      expect(exitSignals).toEqual(['SIGINT']);
    });

    it('arms the fallback from the third SIGINT when only it comes within 2 s of the previous one', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      await startRun();

      signalHandler('SIGINT')('SIGINT');
      await vi.advanceTimersByTimeAsync(5_000);
      signalHandler('SIGINT')('SIGINT');
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      signalHandler('SIGINT')('SIGINT');
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(9_999);
      expect(events).toEqual(['kill:SIGINT', 'kill:SIGINT', 'kill:SIGINT']);
      await vi.advanceTimersByTimeAsync(1);
      expect(events).toEqual(['kill:SIGINT', 'kill:SIGINT', 'kill:SIGINT', 'kill:SIGKILL']);

      child.emit('exit', null, 'SIGKILL');
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130));
      expect(exitSignals).toEqual(['SIGINT']);
    });

    it('keeps the fallback armed by a second SIGINT when a SIGTERM follows and exits with 130', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      await startRun();

      signalHandler('SIGINT')('SIGINT');
      signalHandler('SIGINT')('SIGINT');
      await vi.advanceTimersByTimeAsync(5_000);
      signalHandler('SIGTERM')('SIGTERM');
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(events).toEqual(['kill:SIGINT', 'kill:SIGINT', 'kill:SIGTERM']);
      await vi.advanceTimersByTimeAsync(1);
      expect(events).toEqual(['kill:SIGINT', 'kill:SIGINT', 'kill:SIGTERM', 'kill:SIGKILL']);

      child.emit('exit', null, 'SIGKILL');
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130));
      expect(exitSpy).not.toHaveBeenCalledWith(143);
      expect(exitSignals).toEqual(['SIGINT']);
    });

    it('arms one fallback for three SIGINTs and kills the child once', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      await startRun();

      signalHandler('SIGINT')('SIGINT');
      signalHandler('SIGINT')('SIGINT');
      await vi.advanceTimersByTimeAsync(5_000);
      signalHandler('SIGINT')('SIGINT');
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(events).toEqual(['kill:SIGINT', 'kill:SIGINT', 'kill:SIGINT', 'kill:SIGKILL']);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(events).toEqual(['kill:SIGINT', 'kill:SIGINT', 'kill:SIGINT', 'kill:SIGKILL']);

      child.emit('exit', null, 'SIGKILL');
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130));
      expect(events).toEqual(['kill:SIGINT', 'kill:SIGINT', 'kill:SIGINT', 'kill:SIGKILL', 'onSessionEnd', 'proxyStop']);
    });

    it.each([
      ['SIGHUP', 'SIGHUP'],
      ['SIGTERM', 'SIGTERM'],
    ] as const)('arms one fallback for SIGTERM then %s and exits with the code of the first', async (_name, second) => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      await startRun();

      signalHandler('SIGTERM')('SIGTERM');
      await vi.advanceTimersByTimeAsync(5_000);
      signalHandler(second)(second);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(events).toEqual(['kill:SIGTERM', `kill:${second}`]);
      await vi.advanceTimersByTimeAsync(1);
      expect(events).toEqual(['kill:SIGTERM', `kill:${second}`, 'kill:SIGKILL']);

      child.emit('exit', null, 'SIGKILL');
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(143));
      expect(exitSpy).not.toHaveBeenCalledWith(129);
      expect(exitSignals).toEqual(['SIGTERM']);
    });

    it('ignores a SIGHUP that arrives while the child-exit path runs and leaves SIGINT / SIGTERM to their default', async () => {
      const { running } = await startRun();

      signalHandler('SIGTERM')('SIGTERM');
      child.emit('exit', null, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(SIGNALS.map(addedListenerCount)).toEqual([0, 0, 1]);
      signalHandler('SIGHUP')('SIGHUP');
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(running).rejects.toThrow();

      expect(events).toEqual(['kill:SIGTERM', 'onSessionEnd', 'proxyStop']);
      expect(SIGNALS.map(addedListenerCount)).toEqual([0, 0, 0]);
    });

    it('rejects with the afterRun error after a normal exit and leaves no signal listener', async () => {
      vi.mocked(executeAfterRun).mockRejectedValueOnce(new Error('afterRun failed'));
      const { running } = await startRun();

      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(running).rejects.toThrow('afterRun failed');

      expect(SIGNALS.map(addedListenerCount)).toEqual([0, 0, 0]);
    });

    it('still exits with 143 when afterRun throws after the fallback', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      vi.mocked(executeAfterRun).mockRejectedValueOnce(new Error('afterRun failed'));
      await startRun();

      signalHandler('SIGTERM')('SIGTERM');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(events).toEqual(['kill:SIGTERM', 'kill:SIGKILL']);

      // A non-null code so that afterRun runs.
      child.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(143));
      expect(SIGNALS.map(addedListenerCount)).toEqual([0, 0, 0]);
    });

    it('registers SIGINT, SIGTERM and SIGHUP on POSIX and removes them when the run ends', async () => {
      const { running } = await startRun();

      expect(SIGNALS.map(addedListenerCount)).toEqual([1, 1, 1]);

      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(2_000);
      await running;

      expect(SIGNALS.map(addedListenerCount)).toEqual([0, 0, 0]);
    });

    // libuv on Windows rejects SIGHUP with ENOSYS; any kill there is TerminateProcess.
    it.each(SIGNALS)('on win32 kills the child on %s with no signal name and finalizes after its exit', async (signal) => {
      platformSpy.mockReturnValue('win32');
      const { running } = await startRun();

      expect(() => signalHandler(signal)(signal)).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual(['kill:default']);

      child.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(running).rejects.toThrow('Signal Agent exited with code 1');
      expect(events).toEqual(['kill:default', 'onSessionEnd', 'proxyStop']);
    });

    it('registers SIGINT, SIGTERM and SIGHUP on win32, removes them when the run ends and guards the output streams', async () => {
      platformSpy.mockReturnValue('win32');
      const { running } = await startRun();

      expect(SIGNALS.map(addedListenerCount)).toEqual([1, 1, 1]);
      expect(() => process.stdout.emit('error', errnoError('EIO'))).not.toThrow();

      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(2_000);
      await running;

      expect(SIGNALS.map(addedListenerCount)).toEqual([0, 0, 0]);
    });
  });

  describe('exit notice', () => {
    it.each([
      { silentMode: true, print: false },
      { silentMode: false, print: true },
    ])('silentMode $silentMode → printed: $print, after the own record, with the process start time', async ({ silentMode, print }) => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.mocked(finalizeOwnRecord).mockImplementationOnce(async () => {
        events.push('ownRecord');
      });
      vi.mocked(noticeDeliveryAtExit).mockImplementationOnce(async () => {
        events.push('notice');
      });
      const { running } = await startRun(new ProxiedAdapter({ ...metadata, silentMode }));

      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(2_000);
      await running;

      const [sessionId] = vi.mocked(finalizeOwnRecord).mock.calls[0];
      expect(vi.mocked(noticeDeliveryAtExit)).toHaveBeenCalledWith(sessionId, 1_700_000_123_456, print);
      expect(events).toEqual(['onSessionEnd', 'ownRecord', 'notice', 'proxyStop']);
    });

    it('an own-record step that rejects does not stop the exit: the notice and the proxy stop still run', async () => {
      vi.mocked(finalizeOwnRecord).mockImplementationOnce(async () => {
        events.push('ownRecord');
        throw new Error('lock dir unwritable');
      });
      vi.mocked(noticeDeliveryAtExit).mockImplementationOnce(async () => {
        events.push('notice');
      });
      const { running } = await startRun();

      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(running).resolves.toBeUndefined();
      expect(events).toEqual(['onSessionEnd', 'ownRecord', 'notice', 'proxyStop']);
    });
  });

  describe('output streams', () => {
    let entryPointListener: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // Stands in for the listener bin/codemie.js installs.
      entryPointListener = vi.fn();
      process.stdout.on('error', entryPointListener);
      process.stderr.on('error', entryPointListener);
    });

    afterEach(() => {
      process.stdout.off('error', entryPointListener);
      process.stderr.off('error', entryPointListener);
    });

    it('ignores EIO / EPIPE and re-throws any other error while run() is in progress', async () => {
      const { running } = await startRun();

      expect(() => process.stdout.emit('error', errnoError('EIO'))).not.toThrow();
      expect(() => process.stderr.emit('error', errnoError('EPIPE'))).not.toThrow();
      const eacces = errnoError('EACCES');
      expect(() => process.stdout.emit('error', eacces)).toThrow(eacces);
      expect(entryPointListener).not.toHaveBeenCalled();

      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(running).resolves.toBeUndefined();
    });

    it('keeps the guard after run() returns: a late EIO does not throw and the entry-point listener stays removed', async () => {
      const { running } = await startRun();
      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(running).resolves.toBeUndefined();

      expect(() => process.stdout.emit('error', errnoError('EIO'))).not.toThrow();
      expect(() => process.stderr.emit('error', errnoError('EIO'))).not.toThrow();
      expect(entryPointListener).not.toHaveBeenCalled();
    });

    it('installs one guard per process: two run() calls leave exactly one error listener on each stream', async () => {
      for (let i = 0; i < 2; i++) {
        child = new FakeChild();
        vi.mocked(spawn).mockClear().mockReturnValue(child as unknown as ReturnType<typeof spawn>);
        const { running } = await startRun();
        child.emit('exit', 0, null);
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(running).resolves.toBeUndefined();
        vi.useRealTimers();
      }

      expect(process.stdout.listeners('error')).toHaveLength(1);
      expect(process.stderr.listeners('error')).toHaveLength(1);
      expect(process.stdout.listeners('error')).not.toContain(entryPointListener);
    });

    it('logs only the first ignored EIO when the log write itself raises EIO', async () => {
      const { running } = await startRun();
      // In debug mode logger.debug writes to the closed stdout, which raises EIO again.
      vi.mocked(logger.debug).mockClear().mockImplementationOnce(() => {
        process.stdout.emit('error', errnoError('EIO'));
      });

      expect(() => process.stdout.emit('error', errnoError('EIO'))).not.toThrow();
      expect(logger.debug).toHaveBeenCalledTimes(1);

      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(running).resolves.toBeUndefined();
    });

    it('run() throws before the spawn: the guard is installed and the entry-point listener is removed', async () => {
      const adapter = new ProxiedAdapter({ ...metadata, cliCommand: null });

      await expect(adapter.run([], {})).rejects.toThrow('Signal Agent has no CLI command configured');

      expect(() => process.stdout.emit('error', errnoError('EIO'))).not.toThrow();
      expect(() => process.stderr.emit('error', errnoError('EPIPE'))).not.toThrow();
      expect(process.stdout.listeners('error')).not.toContain(entryPointListener);
      expect(process.stderr.listeners('error')).not.toContain(entryPointListener);
      expect(entryPointListener).not.toHaveBeenCalled();
    });
  });

  describe('exit budget', () => {
    it('abandons the start pass when a setup step throws before the spawn and rejects with that error', async () => {
      startPass.done = new Promise<void>(() => {});
      const abandon = vi.fn(async () => {});
      startPass.abandon = abandon;
      vi.mocked(executeBeforeRun).mockRejectedValueOnce(new Error('bad agent config'));

      await expect(new ProxiedAdapter(metadata).run([], {})).rejects.toThrow('bad agent config');

      expect(abandon).toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('awaits a start pass still running at exit before the session end and the proxy stop', async () => {
      let finishPass: () => void = () => {};
      startPass.done = new Promise<void>((resolve) => {
        finishPass = resolve;
      });
      const { running } = await startRun();

      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(500);
      expect(events).toEqual([]);

      finishPass();
      await expect(running).resolves.toBeUndefined();
      expect(events).toEqual(['onSessionEnd', 'proxyStop']);
    });

    it('abandons a start pass that never settles at 5 s, leaving the own record the rest of the 10 s deadline', async () => {
      const { finalizeOwnRecord } = await import('../session/stale-session-reconciliation.js');
      startPass.done = new Promise<void>(() => {});
      const abandon = vi.fn(async () => {
        events.push('abandon');
      });
      startPass.abandon = abandon;
      let ownRecordAt = 0;
      vi.mocked(finalizeOwnRecord).mockImplementationOnce(async () => {
        events.push('ownRecord');
        ownRecordAt = Date.now();
      });
      const { running } = await startRun();

      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(2_000);
      const exitStart = Date.now();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(events).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(events).toEqual(['abandon', 'onSessionEnd', 'ownRecord', 'proxyStop']);
      await expect(running).resolves.toBeUndefined();
      expect(abandon).toHaveBeenCalledTimes(1);
      expect(ownRecordAt).toBe(exitStart + 5_000);
      expect(vi.mocked(finalizeOwnRecord)).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ deadlineMs: exitStart + 10_000 }));
    });

    it('gives the session end, the own-record step and the proxy stop one deadline, 10 s after the grace period', async () => {
      const { finalizeOwnRecord } = await import('../session/stale-session-reconciliation.js');
      const { running } = await startRun();

      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(2_000);
      const exitStart = Date.now();
      await expect(running).resolves.toBeUndefined();

      const deadlineMs = Number(exitDeadlines[0]);
      expect(deadlineMs).toBe(exitStart + 10_000);
      expect(vi.mocked(finalizeOwnRecord)).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ deadlineMs }));
      expect(proxyStopBounds).toEqual([{ deadlineMs }]);
    });
  });

});
