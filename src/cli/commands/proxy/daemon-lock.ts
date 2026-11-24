import { getCodemiePath } from '../../../utils/paths.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { acquirePidLock } from '../../../utils/pid-lock.js';

/** Wait budget of the daemon lock for `proxy connect`, `start`, `restart` and `stop`. */
export const DAEMON_LOCK_COMMAND_BUDGET_MS = 25_000;
/** Wait budget of the daemon lock for a hook's cold start, inside its hook timeout. */
export const DAEMON_LOCK_HOOK_BUDGET_MS = 12_000;

/** The daemon lock stayed held by another process for the whole wait budget. */
export class DaemonLockError extends ConfigurationError {
  constructor() {
    super('Another codemie process is starting or stopping the proxy; try again.');
  }
}

/**
 * Runs `fn` holding the cross-process lock every start and stop of the daemon takes, so two of them never
 * interleave. Not re-entrant: never called from inside `fn`. Throws {@link DaemonLockError} when the lock is
 * still held after `budgetMs`.
 */
export async function withDaemonLock<T>(budgetMs: number, fn: () => Promise<T>): Promise<T> {
  const lock = await acquirePidLock(getCodemiePath('proxy-daemon.lock'), { mode: 'wait', budgetMs });
  if (!lock) throw new DaemonLockError();
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
