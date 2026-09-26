/**
 * Per-session serialization lock.
 *
 * Same-session operations are serialized; different sessions run fully in
 * parallel. The map entry is cleaned up once no more waiters remain.
 */

const locks = new Map<string, Promise<void>>();

export function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(sessionId) ?? Promise.resolve();
  let resolveCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  locks.set(sessionId, current);

  const result = previous.then(async () => {
    try {
      return await fn();
    } finally {
      // Clean up the map entry only if it still points to this chain link.
      if (locks.get(sessionId) === current) {
        locks.delete(sessionId);
      }
      resolveCurrent();
    }
  });

  return result;
}
