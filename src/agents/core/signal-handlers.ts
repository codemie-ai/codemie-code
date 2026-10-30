/**
 * The wrapper's signal handling for a spawned agent and the guard on its own
 * output streams.
 */
import type { ChildProcess } from 'child_process';
import { signalTree } from '../../utils/processes.js';
import { logger } from '../../utils/logger.js';

/**
 * How long the wrapper waits for the agent to exit after forwarding it SIGTERM,
 * SIGHUP or a SIGINT within 2 s of the previous one before killing it; the
 * child-exit path then finalizes the session. Any other SIGINT arms no such timer:
 * the agent may only interrupt its turn and keep running, while a SIGINT within
 * 2 s of the previous one is an exit request whose wait stays bounded.
 */
const SIGNAL_FALLBACK_MS = 10_000;

/** Double Ctrl+C is the agents' exit convention; a later SIGINT is a new turn interrupt. */
const SIGINT_REPEAT_WINDOW_MS = 2_000;

export interface SignalHandlers {
  removeSignalHandlers: () => void;
  removeInterruptHandlers: () => void;
  onChildGone: () => void;
  fallbackSignal: () => NodeJS.Signals | undefined;
}

let outputStreamsGuarded = false;
// Logged once: in debug mode logger.debug writes to the closed stream itself,
// and each such write raises another EIO.
let closedOutputStreamLogged = false;

function onOutputStreamError(error: NodeJS.ErrnoException): void {
  if (error?.code === 'EIO' || error?.code === 'EPIPE') {
    if (!closedOutputStreamLogged) {
      closedOutputStreamLogged = true;
      logger.debug(`Ignored ${error.code} on the wrapper's output stream`);
    }
    return;
  }
  throw error;
}

/**
 * Keeps the wrapper alive when its terminal or pipe closes: writes to stdout /
 * stderr then fail with EIO / EPIPE, and the agent's session end still has to be
 * delivered through this process's proxy. Any other stream error is re-thrown.
 * The guard replaces the entry point's 'error' listeners and stays until the
 * process ends: a write can still fail after run() returns, and with no listener
 * that error is uncaught and the wrapper exits 1. Installed once per process.
 */
export function ignoreClosedOutputStreams(): void {
  if (outputStreamsGuarded) {
    return;
  }
  outputStreamsGuarded = true;
  for (const stream of [process.stdout, process.stderr]) {
    stream.removeAllListeners('error');
    stream.on('error', onOutputStreamError);
  }
}

/** Test-only: removes the output-stream guard and clears its per-process state. */
export function resetOutputStreamGuardForTests(): void {
  process.stdout.off('error', onOutputStreamError);
  process.stderr.off('error', onOutputStreamError);
  outputStreamsGuarded = false;
  closedOutputStreamLogged = false;
}

function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    signalTree(child.pid, signal);
  }
}

/**
 * On Windows any `child.kill` terminates the agent outright (TerminateProcess),
 * so the agent cannot finalize anything itself; only the order of the wrapper's
 * own finalization matters. The handler kills the agent with no signal name —
 * libuv there rejects SIGHUP with ENOSYS — and the child-exit path finalizes as
 * on POSIX (grace, session end, proxy stop).
 *
 * Node emits SIGHUP when the console window closes (CTRL_CLOSE_EVENT); without
 * a listener the wrapper would die at once. Windows ends the process a few
 * seconds after that event, so finalization there is best-effort. The handlers
 * are one-shot: a second signal of the same kind takes Node's default action.
 */
export function installWin32SignalHandlers(child: ChildProcess, displayName: string): SignalHandlers {
  const handleSignal = (signal: NodeJS.Signals) => {
    logger.debug(`[${displayName}] got ${signal} -> killing the agent`);
    child.kill();
  };

  const sigintHandler = () => handleSignal('SIGINT');
  const sigtermHandler = () => handleSignal('SIGTERM');
  const sighupHandler = () => handleSignal('SIGHUP');

  process.once('SIGINT', sigintHandler);
  process.once('SIGTERM', sigtermHandler);
  process.once('SIGHUP', sighupHandler);

  const removeInterruptHandlers = () => {
    process.off('SIGINT', sigintHandler);
    process.off('SIGTERM', sigtermHandler);
  };

  return {
    removeSignalHandlers: () => {
      removeInterruptHandlers();
      process.off('SIGHUP', sighupHandler);
    },
    removeInterruptHandlers,
    onChildGone: () => undefined,
    fallbackSignal: () => undefined,
  };
}

/**
 * The agent's process tree gets the signal first and the proxy stays up, so
 * the agent's own session-end traffic still reaches it; the child-exit path
 * then finishes the session as on a normal exit. Once that path runs,
 * SIGINT / SIGTERM take their default action (a hung finalization can still
 * be stopped) and a late SIGHUP is ignored. The first of a SIGTERM, a SIGHUP or
 * a SIGINT within 2 s of the previous one the wrapper receives arms the fallback;
 * any other SIGINT arms nothing, since the agent may just interrupt its turn and
 * keep running with the proxy, while a SIGINT within 2 s of the previous one is an
 * exit request whose wait stays bounded. After 10 s the fallback kills the agent's
 * tree and the child-exit path finalizes.
 *
 * Every SIGINT / SIGTERM / SIGHUP is forwarded, so a terminal Ctrl+C in cooked
 * mode reaches the agent twice (the terminal's and the forwarded one): a known
 * limit, kept on purpose.
 */
export function installPosixSignalHandlers(child: ChildProcess, displayName: string): SignalHandlers {
  let childExited = false;
  let signalFallbackTimer: NodeJS.Timeout | undefined;
  let firedFor: NodeJS.Signals | undefined;
  let lastSigintAt: number | undefined;

  const forwardSignal = (signal: NodeJS.Signals) => {
    if (childExited) {
      return;
    }
    logger.debug(`[${displayName}] got ${signal} -> forwarded`);
    signalChildTree(child, signal);
    if (signal === 'SIGINT') {
      const now = Date.now();
      const repeated = lastSigintAt !== undefined && now - lastSigintAt <= SIGINT_REPEAT_WINDOW_MS;
      lastSigintAt = now;
      if (!repeated) {
        return;
      }
    }
    signalFallbackTimer ??= setTimeout(() => {
      logger.debug(`[${displayName}] agent did not exit ${SIGNAL_FALLBACK_MS}ms after ${signal}, killing it`);
      firedFor = signal;
      signalChildTree(child, 'SIGKILL');
    }, SIGNAL_FALLBACK_MS).unref();
  };
  const forwardedSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

  for (const signal of forwardedSignals) {
    process.on(signal, forwardSignal);
  }

  return {
    removeSignalHandlers: () => {
      for (const signal of forwardedSignals) {
        process.off(signal, forwardSignal);
      }
    },
    removeInterruptHandlers: () => {
      process.off('SIGINT', forwardSignal);
      process.off('SIGTERM', forwardSignal);
    },
    onChildGone: () => {
      childExited = true;
      clearTimeout(signalFallbackTimer);
    },
    fallbackSignal: () => firedFor,
  };
}
