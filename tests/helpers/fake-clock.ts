import { vi } from 'vitest';

/**
 * Runs `work` on a fake clock (setTimeout and Date) in 25 ms steps, real I/O running between them.
 * `hold`: the clock stands still while `while()` is true, up to `maxRealMs` of real time in all, so slow real I/O
 * inside a span the test can observe cannot spend a fake deadline; without it the clock never waits for I/O.
 */
export async function onFakeClock<T>(work: () => Promise<T>, hold?: { while: () => boolean; maxRealMs: number }): Promise<T> {
  const realSetTimeout = setTimeout;
  const realNow = performance.now.bind(performance);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    let finished = false;
    const run = work().finally(() => { finished = true; });
    let heldMs = 0;
    let last = realNow();
    // Only advances count against the 2000-step budget; a hold is bounded by `maxRealMs` instead.
    for (let step = 0; !finished && step < 2000;) {
      const now = realNow();
      const holding = hold !== undefined && heldMs < hold.maxRealMs && hold.while();
      if (holding) heldMs += now - last;
      last = now;
      if (!holding) {
        await vi.advanceTimersByTimeAsync(25);
        step++;
      }
      await new Promise((resolve) => realSetTimeout(resolve, 1));
    }
    return await run;
  } finally {
    vi.useRealTimers();
  }
}
