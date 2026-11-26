import { CONFIG } from './constants.js';

export interface RawInputOptions {
  /** Unref stdin on stop so it no longer keeps the process alive. */
  unrefOnStop?: boolean;
}

/**
 * Puts stdin into raw mode and feeds every key (or pasted chunk) to `onKey` until the returned
 * stop function is called. Shared by the selection prompts and the setup wizard screens.
 */
export function startRawInput(onKey: (key: string) => void, options: RawInputOptions = {}): () => void {
  const keepAliveTimer = setInterval(() => {}, CONFIG.KEEP_ALIVE_INTERVAL_MS); // keep event loop running
  const onData = (data: Buffer | string): void => onKey(data.toString());

  process.stdin.resume();
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;

    clearInterval(keepAliveTimer);
    process.stdin.removeListener('data', onData);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    if (options.unrefOnStop) {
      process.stdin.unref();
    }
  };
}
