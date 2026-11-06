import { vi } from 'vitest';

/** Runs `work` on a fake clock (setTimeout and Date) in 25 ms steps, real I/O running between them. */
export async function onFakeClock<T>(work: () => Promise<T>): Promise<T> {
  const realSetTimeout = setTimeout;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    let finished = false;
    const run = work().finally(() => { finished = true; });
    for (let step = 0; !finished && step < 2000; step++) {
      await vi.advanceTimersByTimeAsync(25);
      await new Promise((resolve) => realSetTimeout(resolve, 1));
    }
    return await run;
  } finally {
    vi.useRealTimers();
  }
}
